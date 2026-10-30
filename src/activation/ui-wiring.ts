// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Command registrations, all through `registerGuardedCommand`. A registration
// performs nothing; each mutating handler re-checks trust at the point of effect,
// which is the programmatic-invocation case VS Code's guidance warns about.

import * as vscode from 'vscode';

import type { AuditLogWriter } from '../audit/audit-log-writer';
import { runAuto, type AutoCommandArgs } from '../commands/auto';
import { runCancel } from '../commands/cancel';
import { runClearAll } from '../commands/clear-all';
import { runClearQueue } from '../commands/clear-queue';
import { runEnqueue, type EnqueueCommandArgs } from '../commands/enqueue';
import { runGitApprovals, type GitApprovalItem } from '../commands/git-approvals';
import { runOpenDashboard } from '../commands/open-dashboard';
import {
  runClearCompleted,
  runClearFailed,
  runMoveQueuedItemDown,
  runMoveQueuedItemUp,
  runPauseQueue,
  runResumeQueue
} from '../commands/queue-ops';
import { runRerunFromHistory } from '../commands/rerun-from-history';
import {
  runReportFailedRowExits,
  type ReportFailedRowExitsDeps
} from '../commands/report-failed-row-exits';
import { runRestartCanceledTask } from '../commands/restart-canceled-task';
import { runResume } from '../commands/resume';
import { runRetryActiveRun } from '../commands/retry-active-run';
import {
  runPausePhase,
  runRestartPhase,
  runResumePhase,
  type PhaseControlCommandDeps
} from '../commands/phase-control-commands';
import { runRetryPhaseNow } from '../commands/retry-phase-now';
import { runSchedule, type ScheduleCommandArgs } from '../commands/schedule';
import { runShowActiveRun } from '../commands/show-active-run';
import { runShowAuditLog } from '../commands/show-audit';
import {
  runStartQueueCommand,
  type StartQueueCommandArg
} from '../commands/start-queue';
import { registerQueueFailurePolicyCommand } from './queue-failure-policy-wiring';
import { registerAuditChainCommands } from './audit-commands-wiring';
import { registerEvidenceCommands } from './evidence-commands-wiring';
import type { TransportRouter } from '../monitor/transport/transport-router';
import type { OperatorAttribution } from '../lib/operator-attribution';
import type { RuntimeLogAccessor } from '../lib/runtime-log/runtime-log-settings';
import { registerQueueItemExitCommands } from './queue-item-exit-wiring';
import { readQueueFailurePolicyDefault } from './uncached-settings-accessors';
import type { PipelineCatalog } from '../config/pipeline-config';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import { errorMessage } from '../lib/errors';
import type { SanitizedLogger } from '../lib/logger';
import {
  registerGuardedCommand,
  type GuardedCommandDeps
} from './guarded-command-registration';
import type { QueueManager } from '../queue/queue-manager';
import type { ExecutionLeasePort } from '../services/auto-drain-coordinator';
import type { QueueStartFailureRegistry } from '../services/queue-start-failure-registry';
import type { GuardedRunService } from '../services/guarded-run-service';
import type { HistoryStore } from '../state/history-store';
import type { WorkspaceLockManager } from '../state/lock';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { ConnectedRunProjection } from '../contracts/sidebar-ipc';
import { DashboardBridge } from '../ui/dashboard/dashboard-bridge';
import { HistoryDescriptionStore } from '../services/history/history-description-store';
import type { Notifier } from '../ui/notifications';
import {
  projectConnectedRun,
  type ConnectedChildState
} from '../ui/sidebar/connected-run-projector';
import type { ConnectedRunPort } from '../ui/sidebar/commands/router-types';
import type { StateProjector } from '../ui/sidebar/state-projector';

interface Stage2UiWiringDeps {
  readonly extensionRoot: string;
  readonly workspaceRoot: string;
  readonly projector: StateProjector;
  readonly dispatch: ConstructorParameters<typeof DashboardBridge>[0]['dispatch'];
  readonly guardedRunService: GuardedRunService;
  readonly store: WorkspaceStateStore;
  readonly auditWriter: AuditLogWriter;
  readonly notifier: Notifier;
  readonly logger: SanitizedLogger;
  readonly getCatalog: () => PipelineCatalog;
  readonly controller: SchegentWorkflowController;
  readonly queue: QueueManager;
  readonly lock: WorkspaceLockManager;
  // FR-R3-150 (T1620) — the queue-scoped Clean All orchestrator releases a
  // queue's execution lease directly by id (D5); this is the same manager
  // instance the controller and the deactivate path share (one window, one
  // set of leases, per `extension.ts`'s own note at its `executionLease` wire).
  readonly executionLease: ExecutionLeasePort;
  readonly historyStore: HistoryStore;
  readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
  /**
   * Feature 195 (T018, FR-021) — the same registry `AutoDrainCoordinator`
   * writes to at step 2a, read here so an explicit Start Queue can report a
   * halt as a refusal naming the failed task, rather than the pre-feature
   * asynchronous `accepted`.
   */
  readonly queueStartFailures: Pick<QueueStartFailureRegistry, 'get'>;
  /** FR-R4-F04 (D4) — private storage, where the deletion removes a Run's recovery checkpoint. */
  readonly globalStorageRoot: string;
  /** FR-R4-F04 (D5) — asked when the shared legacy transport ages out. */
  readonly transportRouter: Pick<TransportRouter, 'legacyAgesOutBy' | 'measure'>;
  /** FR-R4-F04 (P4) — the operator attribution the reset command replaces. */
  readonly operatorAttribution: Pick<OperatorAttribution, 'reset'>;
  /** FR-R4-F04 (B3) — where the runtime log is, for the diagnostics bundle's lines for one Run. */
  readonly runtimeLogAccessor: Pick<RuntimeLogAccessor, 'read'>;
}

export interface Stage2UiWiring {
  readonly dashboardBridge: DashboardBridge;
  dispose(): void;
}

/**
 * Feature 088 (T040) — the host-side facade over connected-run state.
 *
 * It lives here rather than in `extension.ts` for a budget reason recorded in
 * [plan.md D7](../../../specs/088-workflow-continuation/plan.md): activation is
 * at its LOC ceiling, and this is composition it can name in a few lines instead
 * of building inline. It holds no state of its own — every method reads the
 * store on call — so it is safe to construct once and share between the message
 * router (which mutates) and the projector (which reads).
 */
export interface ConnectedRunService extends ConnectedRunPort {
  /** Every connected run, already folded to the shape the snapshot carries. */
  listProjections(): readonly ConnectedRunProjection[];
}

type ConnectedRunStore = Pick<
  WorkspaceStateStore,
  'getRequest' | 'getConnectedRun' | 'getConnectedRuns' | 'compareAndSetConnectedRun'
>;

/**
 * One child Pipeline Run's state, read from the queue and then from history.
 *
 * The queue is authoritative while an item is in it, including after it reaches
 * a terminal status — the "done" section of the queue is the same array. History
 * is the second reading and exists for one case: an operator who clears completed
 * items would otherwise turn every child reference in every connected run into an
 * unresolvable one, leaving finished nodes projecting as `hydrating` forever.
 *
 * `null` when neither knows the id. That is *no observation*, not a state: the
 * projector falls the node through to its decision fold and the launcher's gate
 * reads it as settled, which is what keeps a dead reference from wedging a run.
 *
 * `pending` and `paused` both read as `in-flight` because the only question this
 * answers is whether the child has settled, and neither has (see
 * data-model.md "Derived" on why the name is `in-flight`).
 *
 * FR-R3-002 (T283) — the queue read is `getRequest`, not `getQueue()`. The
 * argument-less read resolved to the Default queue, so a child in flight on any
 * other queue was simply absent from the array, fell through to history, and
 * resolved `null` — which, per the paragraph above, the launcher's gate reads as
 * **settled**. A live child was therefore reported as finished. `getRequest`
 * names the *Task*, and the store resolves whichever queue owns it; a caller
 * that holds a Task id and no queue id has an honest way to ask.
 */
function readChildState(
  store: ConnectedRunStore,
  history: Pick<HistoryStore, 'list'>,
  queueItemId: string
): ConnectedChildState | null {
  const request = store.getRequest(queueItemId);
  if (request !== null) {
    if (request.status === 'completed') return 'completed';
    if (request.status === 'failed') return 'failed';
    if (request.status === 'canceled') return 'canceled';
    return 'in-flight';
  }
  return history.list().find((entry) => entry.featureId === queueItemId)?.terminalStatus ?? null;
}

/** Constructs the facade above. Pure composition — no VS Code API is touched. */
export function createConnectedRunService(
  store: ConnectedRunStore,
  history: Pick<HistoryStore, 'list'>
): ConnectedRunService {
  const reader = (queueItemId: string): ConnectedChildState | null =>
    readChildState(store, history, queueItemId);
  return {
    get: (connectedRunId) => store.getConnectedRun(connectedRunId),
    compareAndSetConnectedRun: (next, expectedRevision) =>
      store.compareAndSetConnectedRun(next, expectedRevision),
    readChildState: reader,
    listProjections: () =>
      Object.freeze(
        Object.values(store.getConnectedRuns()).map((run) => projectConnectedRun(run, reader))
      )
  };
}

/** What the failed-row report writes when the extension's version cannot be read as a version. */
const UNKNOWN_VERSION = 'unknown';
const EXTENSION_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$/;

/**
 * FR-R4-F16 (feature 244, contract M2.3) — the ports of "Schegent: Report Failed-Row Exits".
 *
 * Read-only by construction: it is handed the clock, two reads of queue state, the version, a way to
 * open an unsaved document, and the logger and notifier, and no audit writer, queue manager, controller
 * or lock, so the command cannot append, start work or take a lease. The workspace root is
 * `deps.workspaceRoot`, never the first workspace folder read directly (hard rule 31). The policy
 * default is read on call, through the uncached accessor, because an operator who changes the setting
 * means it.
 */
function failedRowCensusPorts(deps: Stage2UiWiringDeps): ReportFailedRowExitsDeps {
  return {
    workspaceRoot: deps.workspaceRoot,
    now: Date.now,
    readQueueStates: () => deps.store.getQueueStates(),
    readPolicyDefault: () => readQueueFailurePolicyDefault(deps.workspaceRoot),
    // The version is shown in the report, so it is accepted by pattern and nothing else.
    extensionVersion: () => {
      const version: unknown = vscode.extensions.getExtension('schegent.schegent')?.packageJSON?.version;
      return typeof version === 'string' && EXTENSION_VERSION_PATTERN.test(version) ? version : UNKNOWN_VERSION;
    },
    openReport: async (content) => {
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
      await vscode.window.showTextDocument(document, { preview: false });
    },
    logger: deps.logger,
    notifier: deps.notifier
  };
}

/**
 * Registers the operator command surface and owns its dashboard bridge.
 * Workflow/runtime composition stays in extension activation; this module is
 * the single lifecycle owner for VS Code UI command registrations.
 */
export function registerStage2Ui(deps: Stage2UiWiringDeps): Stage2UiWiring {
  const dashboardBridge = new DashboardBridge({
    extensionRoot: deps.extensionRoot,
    projector: deps.projector,
    dispatch: deps.dispatch,
    logger: deps.logger
  });
  // FR-R3-071 — one store instance for the sidecar READ half, shared by both
  // replay commands. The write half lives on the recorder's own instance
  // (createHistoryRecorder); the two address the same files by construction,
  // because refs are derived from run ids alone.
  const historyDescriptions = new HistoryDescriptionStore({
    workspaceRoot: deps.workspaceRoot,
    logger: deps.logger
  });
  const queueOpsCtx = {
    queue: deps.queue,
    lock: deps.lock,
    notifier: deps.notifier,
    logger: deps.logger
  };
  /**
   * FR-R3-154 (T1645) — the three Phase controls take the same three
   * dependencies, named once so the registrations below stay one line each.
   */
  const phaseControlCommandDeps = (d: typeof deps): PhaseControlCommandDeps => ({
    controller: d.controller,
    notifier: d.notifier,
    logger: d.logger
  });

  // FR-R3-136 (FR-005, FR-006) — the trust guard every registration below goes
  // through. `isWorkspaceTrusted` is a thunk, not a captured boolean: a command
  // outlives its registration and can be invoked programmatically at any later
  // time, including after `onDidGrantWorkspaceTrust` has fired. Reading vscode
  // directly here matches `sidebar-router-wiring.ts`, which passes the same shape
  // to the message router — one idiom for this in the codebase, not two.
  const guard: GuardedCommandDeps = {
    isWorkspaceTrusted: () => vscode.workspace.isTrusted,
    notifier: deps.notifier,
    logger: deps.logger,
    isOwner: () => deps.lock.hasPrimacy()
  };

  const commands: vscode.Disposable[] = [
    // The argument annotations on the handlers below are new with the guard, and
    // they are a tightening rather than noise: `vscode.commands.registerCommand`
    // types its handler as `(...args: any[]) => any`, so every one of these
    // parameters was implicitly `any` and the palette could hand a command the
    // wrong shape without a compile error.
    registerGuardedCommand(guard, 'schegent.auto', (args: AutoCommandArgs | undefined) =>
      runAuto(args, {
        guardedRunService: deps.guardedRunService,
        store: deps.store,
        audit: deps.auditWriter,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    registerGuardedCommand(guard, 'schegent.enqueue', async (args: EnqueueCommandArgs) => {
      const result = await runEnqueue(args, {
        guardedRunService: deps.guardedRunService,
        store: deps.store,
        audit: deps.auditWriter,
        logger: deps.logger,
        via: 'dashboard-submit',
        promptForInput: false
      });
      if (result?.result.outcome === 'enqueued') {
        // FR-R3-002 (T279) — drain the queue the task actually landed on.
        // `runEnqueue` has already refused an unnamed queue, so `args.queueId`
        // is a valid fallback for the case where the inserted row could not be
        // read back; the argument-less drain this replaces always swept Default.
        const drainTarget = result.queueId ?? args.queueId;
        void deps.controller.drainQueuedWork(drainTarget).catch((err) =>
          deps.logger.warn(`enqueue: auto-drain failed: ${(err as Error).message}`)
        );
      }
      return result;
    }),
    registerGuardedCommand(guard, 'schegent.schedule', (args: ScheduleCommandArgs | undefined) =>
      runSchedule(args, {
        guardedRunService: deps.guardedRunService,
        getCatalog: deps.getCatalog,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    registerGuardedCommand(guard, 'schegent.resume', (prompt?: string) =>
      runResume({
        store: deps.store,
        controller: deps.controller,
        lock: deps.lock,
        notifier: deps.notifier,
        logger: deps.logger,
        prompt
      })
    ),
    registerGuardedCommand(guard, 
      'schegent.startQueue',
      (arg?: StartQueueCommandArg) =>
        runStartQueueCommand(arg, {
          guardedRunService: deps.guardedRunService,
          controller: deps.controller,
          logger: deps.logger,
          startFailures: deps.queueStartFailures
        })
    ),
    registerGuardedCommand(guard, 'schegent.cancel', (arg?: { taskId?: string }) =>
      runCancel({
        controller: deps.controller,
        store: deps.store,
        queue: deps.queue,
        audit: deps.auditWriter,
        notifier: deps.notifier,
        logger: deps.logger,
        taskId: typeof arg?.taskId === 'string' ? arg.taskId : undefined
      })
    ),
    registerGuardedCommand(guard,
      'schegent.restartCanceledTask',
      async (arg?: { taskId?: string }) => {
        const result = await runRestartCanceledTask({
          store: deps.store,
          queue: deps.queue,
          audit: deps.auditWriter,
          notifier: deps.notifier,
          logger: deps.logger,
          taskId: typeof arg?.taskId === 'string' ? arg.taskId : ''
        });
        if (result.ok) {
          // Restoring a row to `pending` is the same state transition
          // `schegent.enqueue` performs above, and needs the same trigger: the
          // drain coordinator is edge-triggered, so without this the restarted
          // Task waits for an unrelated event. `result.queueId` is the queue the
          // row actually landed on, never a defaulted sweep of Default.
          void deps.controller.drainQueuedWork(result.queueId).catch((err) =>
            deps.logger.warn(
              `restartCanceledTask: auto-drain failed: ${errorMessage(err)}`
            )
          );
        }
        return result;
      }
    ),
    registerGuardedCommand(guard, 'schegent.showAuditLog', () =>
      runShowAuditLog({ workspaceRoot: deps.workspaceRoot, notifier: deps.notifier })
    ),
    registerGuardedCommand(guard, 'schegent.reportFailedRowExits', () =>
      runReportFailedRowExits(failedRowCensusPorts(deps))
    ),
    // FR-R3-146 (FR-012, SC-005) — the observe-and-withdraw surface for the
    // durable Git grants. Both thunks read the store when the command runs, not
    // when the wiring is built: the rule `run-safety-wiring.ts:204-206` states for
    // the grant lookup itself, and for the same reason — an operator who clears
    // state mid-session means it.
    registerGuardedCommand(guard, 'schegent.gitApprovals', () =>
      runGitApprovals({
        grants: () => deps.store.getGitPlanGrants(),
        forget: (fingerprint) => deps.store.forgetGitPlanGrant(fingerprint),
        forgetAll: () => deps.store.forgetAllGitPlanGrants(),
        pick: (items) =>
          Promise.resolve(
            vscode.window.showQuickPick<GitApprovalItem & vscode.QuickPickItem>(
              items as (GitApprovalItem & vscode.QuickPickItem)[],
              {
                title: 'Schegent: Git Approvals',
                placeHolder: 'Plans this workspace approves without asking. Pick one to withdraw it.',
                // The detail line carries the phases and the fingerprint, and it
                // is the reason this list answers "what did I grant" at all.
                matchOnDetail: true
              }
            )
          ),
        // `modal: true`, like both consent modals: withdrawing a security decision
        // is answered, not dismissed past.
        confirm: (message, detail, approveLabel) =>
          Promise.resolve(
            vscode.window.showWarningMessage(message, { modal: true, detail }, approveLabel)
          ),
        info: (message) => deps.notifier.info(message)
      })
    ),
    // FR-R3-112 — the chain verification, from the surface rather than only from a shell. FR-R4-F03 (TA3):
    // registered with the reset command in `audit-commands-wiring.ts`, because this function is at its bound.
    ...registerAuditChainCommands(guard, {
      workspaceRoot: deps.workspaceRoot,
      notifier: deps.notifier,
      logger: deps.logger,
      auditWriter: deps.auditWriter
    }),
    // FR-R4-F04 (TA4) — export audit log, export Run evidence and delete Run evidence, registered
    // together in `evidence-commands-wiring.ts` because this function is at its bound.
    ...registerEvidenceCommands(guard, {
      workspaceRoot: deps.workspaceRoot,
      store: deps.store, historyStore: deps.historyStore,
      auditWriter: deps.auditWriter,
      notifier: deps.notifier,
      logger: deps.logger,
      globalStorageRoot: deps.globalStorageRoot,
      transportRouter: deps.transportRouter,
      operatorAttribution: deps.operatorAttribution,
      runtimeLogAccessor: deps.runtimeLogAccessor
    }),
    // Feature 195 (T064) — retry and attested completion, the two queue-item
    // exits that must offer the queue a drain; extracted together for the
    // reason `queue-item-exit-wiring.ts` records.
    ...registerQueueItemExitCommands(guard, {
      queueOps: queueOpsCtx,
      controller: deps.controller,
      logger: deps.logger
    }),
    registerGuardedCommand(guard, 'schegent.moveQueuedItemUp', (arg) =>
      runMoveQueuedItemUp(arg, queueOpsCtx)
    ),
    registerGuardedCommand(guard, 'schegent.moveQueuedItemDown', (arg) =>
      runMoveQueuedItemDown(arg, queueOpsCtx)
    ),
    registerGuardedCommand(guard, 'schegent.clearAll', () =>
      runClearAll({
        controller: deps.controller,
        store: deps.store,
        queue: deps.queue,
        audit: deps.auditWriter,
        lock: deps.lock,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    // FR-R3-150 (T1618/T1620) — the queue-scoped Clean All, addressed by
    // `queueId`; registered-only (no palette entry), called only from
    // `cmd-clear-queue.ts`. `schegent.clearAll` above stays workspace-wide.
    registerGuardedCommand(guard, 'schegent.clearQueue', (queueId: string) =>
      runClearQueue(
        {
          controller: deps.controller, queue: deps.queue, executionLease: deps.executionLease,
          audit: deps.auditWriter, lock: deps.lock, notifier: deps.notifier, logger: deps.logger
        },
        queueId
      )
    ),
    registerGuardedCommand(guard, 'schegent.clearCompleted', () =>
      runClearCompleted(queueOpsCtx)
    ),
    registerGuardedCommand(guard, 'schegent.clearFailed', () =>
      runClearFailed(queueOpsCtx)
    ),
    registerGuardedCommand(guard, 'schegent.pauseQueue', (arg) =>
      runPauseQueue(arg, queueOpsCtx)
    ),
    registerGuardedCommand(guard, 'schegent.resumeQueue', () =>
      runResumeQueue(queueOpsCtx)
    ),
    registerQueueFailurePolicyCommand(guard, { queue: deps.queue, logger: deps.logger }), // T037
    registerGuardedCommand(guard, 'schegent.rerunFromHistory', (arg) =>
      runRerunFromHistory(arg, {
        guarded: deps.guardedRunService,
        history: deps.historyStore,
        descriptions: historyDescriptions,
        lock: deps.lock,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    registerGuardedCommand(guard, 'schegent.showActiveRun', (arg) =>
      runShowActiveRun(arg, { notifier: deps.notifier, logger: deps.logger })
    ),
    registerGuardedCommand(guard, 'schegent.openDashboard', (arg) =>
      runOpenDashboard(arg, {
        bridge: dashboardBridge,
        notifier: deps.notifier,
        logger: deps.logger,
        getWorkspaceFolders: deps.getWorkspaceFolders
      })
    ),
    registerGuardedCommand(guard, 'schegent.retryActiveRun', (arg) =>
      runRetryActiveRun(arg, {
        store: deps.store,
        controller: deps.controller,
        queue: deps.queue,
        history: deps.historyStore,
        descriptions: historyDescriptions,
        lock: deps.lock,
        guarded: deps.guardedRunService,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    registerGuardedCommand(guard, 'schegent.retryPhaseNow', (arg) =>
      runRetryPhaseNow(arg, {
        controller: deps.controller,
        lock: deps.lock,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    // Feature 093 (FR-018 / T080) — the sidebar always passes the addressed
    // queue; a human invoking these from the palette passes nothing and the
    // controller resolves a sole Run, refusing when N are in flight.
    //
    // FR-R3-154 (T1645) — the three bodies moved to
    // `src/commands/phase-control-commands.ts` so their `MutationResult` is
    // returned instead of warned about and dropped. `registerGuardedCommand`
    // preserves a handler's return value, which is what carries the outcome
    // back through `executeCommand` to the sidebar route.
    registerGuardedCommand(guard, 'schegent.pausePhase', (queueId?: string) =>
      runPausePhase(queueId, phaseControlCommandDeps(deps))
    ),
    registerGuardedCommand(guard,
      'schegent.resumePhase',
      (prompt?: string, queueId?: string) =>
        runResumePhase(prompt, queueId, phaseControlCommandDeps(deps))
    ),
    registerGuardedCommand(guard, 'schegent.restartPhase', (queueId?: string) =>
      runRestartPhase(queueId, phaseControlCommandDeps(deps))
    ),
    registerGuardedCommand(guard, 'schegent.redetectClaudeTransport', () => {
      deps.notifier.info(
        'Schegent: Claude CLI now natively streams prompts over stdin. No transport redetection is necessary.'
      );
    })
  ];
  return {
    dashboardBridge,
    dispose(): void {
      dashboardBridge.dispose();
      for (const command of commands) command.dispose();
    }
  };
}
