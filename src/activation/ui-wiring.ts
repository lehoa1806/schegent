import * as vscode from 'vscode';

import type { AuditLogWriter } from '../audit/audit-log-writer';
import { runAuto } from '../commands/auto';
import { runCancel } from '../commands/cancel';
import { runClearAll } from '../commands/clear-all';
import { runEnqueue, type EnqueueCommandArgs } from '../commands/enqueue';
import { runExportAuditLog } from '../commands/export-audit';
import { runOpenDashboard } from '../commands/open-dashboard';
import {
  runClearCompleted,
  runClearFailed,
  runMoveQueuedItemDown,
  runMoveQueuedItemUp,
  runPauseQueue,
  runResumeQueue,
  runRetryQueuedItem
} from '../commands/queue-ops';
import { runRerunFromHistory } from '../commands/rerun-from-history';
import { runRestartCanceledTask } from '../commands/restart-canceled-task';
import { runResume } from '../commands/resume';
import { runRetryActiveRun } from '../commands/retry-active-run';
import { runRetryPhaseNow } from '../commands/retry-phase-now';
import { runSchedule } from '../commands/schedule';
import { runShowActiveRun } from '../commands/show-active-run';
import { runShowAuditLog } from '../commands/show-audit';
import {
  runStartQueueCommand,
  type StartQueueCommandArg
} from '../commands/start-queue';
import type { PipelineCatalog } from '../config/pipeline-config';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { SanitizedLogger } from '../lib/logger';
import type { QueueManager } from '../queue/queue-manager';
import type { GuardedRunService } from '../services/guarded-run-service';
import type { HistoryStore } from '../state/history-store';
import type { WorkspaceLockManager } from '../state/lock';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { ConnectedRunProjection } from '../contracts/sidebar-ipc';
import { DashboardBridge } from '../ui/dashboard/dashboard-bridge';
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
  readonly historyStore: HistoryStore;
  readonly getWorkspaceFolders: () => readonly vscode.WorkspaceFolder[] | undefined;
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
  const queueOpsCtx = {
    queue: deps.queue,
    lock: deps.lock,
    notifier: deps.notifier,
    logger: deps.logger
  };
  const commands: vscode.Disposable[] = [
    vscode.commands.registerCommand('schegent.auto', (args) =>
      runAuto(args, {
        guardedRunService: deps.guardedRunService,
        store: deps.store,
        audit: deps.auditWriter,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    vscode.commands.registerCommand('schegent.enqueue', async (args: EnqueueCommandArgs) => {
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
    vscode.commands.registerCommand('schegent.schedule', (args) =>
      runSchedule(args, {
        guardedRunService: deps.guardedRunService,
        getCatalog: deps.getCatalog,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    vscode.commands.registerCommand('schegent.resume', (prompt?: string) =>
      runResume({
        store: deps.store,
        controller: deps.controller,
        lock: deps.lock,
        notifier: deps.notifier,
        logger: deps.logger,
        prompt
      })
    ),
    vscode.commands.registerCommand(
      'schegent.startQueue',
      (arg?: StartQueueCommandArg) =>
        runStartQueueCommand(arg, {
          guardedRunService: deps.guardedRunService,
          controller: deps.controller,
          logger: deps.logger
        })
    ),
    vscode.commands.registerCommand('schegent.cancel', (arg?: { taskId?: string }) =>
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
    vscode.commands.registerCommand(
      'schegent.restartCanceledTask',
      (arg?: { taskId?: string }) =>
        runRestartCanceledTask({
          store: deps.store,
          queue: deps.queue,
          audit: deps.auditWriter,
          notifier: deps.notifier,
          logger: deps.logger,
          taskId: typeof arg?.taskId === 'string' ? arg.taskId : ''
        })
    ),
    vscode.commands.registerCommand('schegent.showAuditLog', () =>
      runShowAuditLog({ workspaceRoot: deps.workspaceRoot, notifier: deps.notifier })
    ),
    vscode.commands.registerCommand('schegent.exportAuditLog', () =>
      runExportAuditLog({ workspaceRoot: deps.workspaceRoot, notifier: deps.notifier })
    ),
    vscode.commands.registerCommand('schegent.retryQueuedItem', (arg) =>
      runRetryQueuedItem(arg, queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.moveQueuedItemUp', (arg) =>
      runMoveQueuedItemUp(arg, queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.moveQueuedItemDown', (arg) =>
      runMoveQueuedItemDown(arg, queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.clearAll', () =>
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
    vscode.commands.registerCommand('schegent.clearCompleted', () =>
      runClearCompleted(queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.clearFailed', () =>
      runClearFailed(queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.pauseQueue', (arg) =>
      runPauseQueue(arg, queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.resumeQueue', () =>
      runResumeQueue(queueOpsCtx)
    ),
    vscode.commands.registerCommand('schegent.rerunFromHistory', (arg) =>
      runRerunFromHistory(arg, {
        guarded: deps.guardedRunService,
        history: deps.historyStore,
        lock: deps.lock,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    vscode.commands.registerCommand('schegent.showActiveRun', (arg) =>
      runShowActiveRun(arg, { notifier: deps.notifier, logger: deps.logger })
    ),
    vscode.commands.registerCommand('schegent.openDashboard', (arg) =>
      runOpenDashboard(arg, {
        bridge: dashboardBridge,
        notifier: deps.notifier,
        logger: deps.logger,
        getWorkspaceFolders: deps.getWorkspaceFolders
      })
    ),
    vscode.commands.registerCommand('schegent.retryActiveRun', (arg) =>
      runRetryActiveRun(arg, {
        store: deps.store,
        controller: deps.controller,
        queue: deps.queue,
        history: deps.historyStore,
        lock: deps.lock,
        guarded: deps.guardedRunService,
        notifier: deps.notifier,
        logger: deps.logger
      })
    ),
    vscode.commands.registerCommand('schegent.retryPhaseNow', (arg) =>
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
    vscode.commands.registerCommand('schegent.pausePhase', async (queueId?: string) => {
      const result = await deps.controller.pauseActivePhase(queueId);
      if (!result.ok) {
        deps.notifier.warn(`Schegent: pause phase rejected (${result.reason}).`);
      }
    }),
    vscode.commands.registerCommand(
      'schegent.resumePhase',
      async (prompt?: string, queueId?: string) => {
        const result = await deps.controller.resumeActivePhase(prompt, queueId);
        if (!result.ok) {
          deps.notifier.warn(`Schegent: resume phase rejected (${result.reason}).`);
        }
      }
    ),
    vscode.commands.registerCommand('schegent.restartPhase', async (queueId?: string) => {
      const result = await deps.controller.restartActivePhase(queueId);
      if (!result.ok) {
        deps.notifier.warn(`Schegent: restart phase rejected (${result.reason}).`);
      }
    }),
    vscode.commands.registerCommand('schegent.redetectClaudeTransport', () => {
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
