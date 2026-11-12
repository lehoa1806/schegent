// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: DEFERRED.
// Two acts ran at wiring time and neither was on T1525d's list:
// `terminalTransitions.replay()` (four workspace writes per journalled intent)
// and `checkpointRetention.sweep()` (global-storage deletes chosen by workspace
// state). Both are handed to `stage2-producers.ts` as thunks — see
// `replayTerminalTransitions` and `sweepCheckpointRetention` below. The
// `git diff` spawn in this module runs inside a requester the controller calls
// during a Run, not at wiring time.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { RawTranscriptWriter } from '../audit/raw-transcript-writer';
import type { QueueManager } from '../queue/queue-manager';
import type { SanitizedLogger } from '../lib/logger';
import { resolveDiffBase } from '../lib/git-diff-base';
import { withHostGitConfig } from '../lib/host-git-config';
import type { HistoryStore } from '../state/history-store';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { isOperableRunStatus, isTerminalRunStatus, LIVE_RUN_STATUSES } from '../state/workflow-run';
import { createGitApprovalRequester, createPersistentGitApproval } from './git-approval';
import { UNRECORDED_PIPELINE_ID } from '../state/git-plan-grants';
import { createUncontainedConsentRequester } from './uncontained-consent';
import { createHistoryRecorder } from '../services/history-recorder';
import { MetricsRollupWriter } from '../metrics/metrics-rollup-writer';
import { TerminalRunRollupRecorder } from '../metrics/terminal-run-rollup-recorder';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { EvidenceHealthReporter } from '../services/evidence-health/evidence-health-monitor';
import type { Notifier } from '../ui/notifications';
import type { ContainmentAcceptancePort } from '../controller/uncontained-consent-gate';
import { createSpendBoundWatcher, spendSeedTargets } from '../services/spend-bound-watcher';
import { readSpendReplay } from '../services/spend-bound-replay';
import { readLanesEnabled, readSpendLimits } from './uncached-settings-accessors';
import { RunCheckpointService } from '../services/run-checkpoint-service';
import { recoveryPinnedRunPredicate } from '../services/artifact-lifecycle/run-recovery-pins';
import { RunCheckpointRetentionService } from '../services/run-checkpoint-retention';
import { RunMutationLedger } from '../services/run-mutation-ledger';
import type { SessionArtifactRetentionService } from '../services/session-retention/session-artifact-retention-service';
import { TerminalTransitionCoordinator } from '../services/terminal-transition-coordinator';
import {
  recordChildTerminal,
  type PhaseAttemptDispatchInput,
  type PhaseAttemptDispatchResult
} from '../services/workflow-execution/connected-run-coordinator';
import { makeChildRunFactsReader } from '../services/workflow-execution/child-run-facts-reader';
import type { NodeRunStartDeps } from '../services/workflow-execution/node-run-starter';
import {
  phaseDispatchResultOf,
  startPhaseAttempt
} from '../services/workflow-execution/phase-attempt-start';
import {
  getOrCreateProductionWorkflowComposition,
  type ProductionWorkflowComposition
} from '../services/workflow-execution/production-workflow-composition';
import type { DurableAttemptEvidenceResult } from '../services/workflow-execution/workflow-recovery-service';
import { createBackendAvailabilityWiring } from './backend-wiring';
import {
  createSqliteCutoverCoordinator,
  getSqliteCutoverCoordinator,
  getWorkspaceLockForStore
} from './sqlite-cutover-wiring';
import type { BackendCapabilityService } from '../services/backend-capability-service';
import { isWorkflowNodeTerminalStatus } from '../contracts/workflow-definitions';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { ResolvedPortValue } from '../contracts/run-request';
import { createUsageAccountingWiring } from '../services/usage-accounting/usage-accounting-wiring';
import type { ConnectedWorkflowRun } from '../state/connected-workflow-run';
import type { ConnectedRunWriteResult } from '../state/workspace-state';
import type { WorkflowRun } from '../state/workflow-run';
import type { TransportRouter } from '../monitor/transport/transport-router';

export async function createRunSafetyWiring(input: {
  context: vscode.ExtensionContext;
  workspaceRoot: string;
  store: WorkspaceStateStore;
  queue: QueueManager;
  historyStore: HistoryStore;
  logger: SanitizedLogger;
  rawTranscript: RawTranscriptWriter;
  /** FR-R4-F04 (X5) — applies the transport end table at a Run's end. */
  transportRouter: Pick<TransportRouter, 'finalizeRun'>;
  sessionRetention: SessionArtifactRetentionService;
  protectedSessionRunIds: () => ReadonlySet<string>;
  evidenceHealth: EvidenceHealthReporter;
  auditWriter: AuditLogWriter;
  notifier: Notifier;
  /** FR-R6-F09 -- binds the fingerprint an operator accepted; returned beside the consent requester. */
  recordContainmentAcceptance?: ContainmentAcceptancePort;
}) {
  // FR-R3-009 — the durable cumulative-totals rollup. Constructed here so the
  // terminal-transition coordinator, which is the single append site, is the only
  // thing that holds it.
  const metricsRollupWriter = new MetricsRollupWriter({
    workspaceRoot: input.workspaceRoot,
    logger: input.logger,
    evidenceHealth: input.evidenceHealth
  });
  const terminalRollupRecorder = new TerminalRunRollupRecorder({
    writer: metricsRollupWriter,
    logger: input.logger,
    workspaceRoot: input.workspaceRoot
  });
  // FR-R6-F06 (T026, contracts/surfaces-and-wiring.md section 1) — no accounting store is opened
  // until the F01-B cutover, so the service is `null`: nothing is subscribed and a terminal run
  // is not recorded. Production behaviour is unchanged. Declared before the coordinator whose
  // terminal callback uses it, so no terminal run can reach it uninitialized.
  const usageAccounting = createUsageAccountingWiring({
    service: null,
    auditWriter: input.auditWriter,
    subscriptions: input.context.subscriptions,
    logger: input.logger
  });
  const terminalTransitions = new TerminalTransitionCoordinator(
    input.store,
    input.queue,
    createHistoryRecorder({
      historyStore: input.historyStore,
      logger: input.logger,
      queue: input.queue,
      store: input.store,
      workspaceRoot: input.workspaceRoot
    }),
    input.logger,
    {
      recordTerminalRun: async (run) => {
        if (!isOperableRunStatus(run.status)) {
          spendWatcher.forget(run.id);
        }
        await terminalRollupRecorder.recordTerminalRun(run);
        // FR-R6-F06 (T026) — after the rollup, and in its own guard: accounting never decides
        // whether a terminal transition completes.
        try {
          usageAccounting.onTerminalRun({ runId: run.id, status: run.status, endedAtMs: run.lastTransitionAt });
          sqliteCutover?.onTerminalRun({ runId: run.id, status: run.status, endedAtMs: run.lastTransitionAt });
        } catch {
          // The wiring does not throw; this guard keeps that true if it ever did.
        }
      }
    }
  );
  // FR-R3-136 (FR-011) — NOT called here any more, and this was a find rather
  // than a listed task. `replay()` walks the journalled terminal-transition
  // intents and calls `complete()` on each, which finishes a queue item, records
  // history and writes the metrics rollup — four workspace writes, performed at
  // wiring time, in a function whose name says nothing about acting. T1525d's
  // suppression list named the audit append, the catalog write and the retention
  // sweep; it did not name this one, because nobody had read for producer acts in
  // the modules the composition root calls. That is what T1525a's classification
  // pass is for.
  //
  // Handed over rather than moved: the coordinator belongs here beside its single
  // append site, and `stage2-producers.ts` runs it in the same relative position
  // it held before — ahead of the recovery installers, which read the run map
  // this reconciles.
  //
  // FR-R4-F01 (decision TA4) — the owner id is optional so a harness that calls
  // this bare keeps today's behaviour. Passed, it lets `replay()` tell a rival
  // that holds an intent's queue from this window, and defer instead of writing
  // a loser's outcome over the winner's Run.
  let boundGuardedRun: NodeRunStartDeps['guardedRun'] | undefined;
  let boundDefaultRunnerKind: BackendRunnerKind | undefined;
  const bindGuardedRun = (
    guardedRun: NodeRunStartDeps['guardedRun'],
    defaultRunnerKind?: BackendRunnerKind
  ): void => {
    boundGuardedRun = guardedRun;
    boundDefaultRunnerKind = defaultRunnerKind;
  };
  const runComposableWorkflowRecovery = async (): Promise<void> => {
    await sqliteCutover?.activatePrimary();
    await reconcileComposableWorkflowRuns({
      workspaceRoot: input.workspaceRoot,
      store: input.store,
      historyStore: input.historyStore,
      logger: input.logger,
      getGuardedRun: () => boundGuardedRun,
      getDefaultRunnerKind: () => boundDefaultRunnerKind
    });
  };
  const replayTerminalTransitions = async (selfOwnerId?: string): Promise<void> => {
    await sqliteCutover?.activatePrimary();
    await terminalTransitions.replay(selfOwnerId);
    await runComposableWorkflowRecovery();
  };
  // Feature 093 (T053, FR-022a) — Runs that could hold uncommitted work in the
  // shared worktree. Counted as **non-terminal**, which is wider than
  // "currently executing" on purpose: a paused Run's edits are still sitting in
  // the worktree, so a sibling's `git diff HEAD` would sweep them into a
  // snapshot whose restore reverts them. Terminal Runs linger in the record
  // until their queue starts another, and counting those would decline every
  // checkpoint forever once two queues had each finished one.
  //
  // FR-R3-004 — the ledger bounds itself by the same list, so "in flight" means
  // one thing to the count that selects the sole-run path and to the record that
  // partitions the tree.
  const inFlightRuns = () =>
    Object.values(input.store.getRunMap()).filter((run) => !isTerminalRunStatus(run.status));
  const mutationLedger = new RunMutationLedger({
    // The base is resolved per read, on the same reasoning as the checkpoint's
    // own capture: `HEAD` names nothing in a workspace whose first commit has
    // not been made. The ledger catches a throwing `readDiff` and records the
    // observation as failed, so a literal `HEAD` here did not fail a Run — it
    // did something quieter and longer-lived, marking every Run's evidence
    // incomplete for as long as the workspace had no commits, which declines
    // every checkpoint above one in-flight Run. Resolving the base keeps the
    // ledger observing in exactly the workspaces the checkpoint now snapshots.
    readDiff: async () =>
      (
        await promisify(execFile)(
          'git',
          withHostGitConfig([
            'diff',
            '--binary',
            '--no-ext-diff',
            (await resolveDiffBase(input.workspaceRoot)).ref
          ]),
          {
            cwd: input.workspaceRoot,
            maxBuffer: 20 * 1024 * 1024
          }
        )
      ).stdout,
    listInFlightRunIds: () => inFlightRuns().map((run) => run.id),
    workspaceRoot: input.workspaceRoot
  });
  // FR-R3-012 (T434) — the outer bound on the checkpoint store, scheduled here
  // and deliberately not awaited. The sweep walks a directory shared across
  // every workspace the extension has ever opened, so its cost scales with the
  // operator's history rather than with this workspace, and activation must not
  // wait on it. `sweep()` never rejects, so the `void` drops a promise that
  // cannot carry a failure — every fault inside it is already a warning.
  // FR-R3-112 — the spend bound, observing the one record that carries usage.
  //
  // WIRED HERE because this is where the other bounds on a run's behaviour are wired,
  // and because everything it needs is already here: the store it stamps, the queue's
  // Run identity, the audit stream it reads, and the operator it tells. The subscription
  // is disposed with the extension, so a deactivated host stops evaluating.
  //
  // The workspace bound is read PER EVALUATION, not captured: an operator who sets a
  // limit while a run is in flight means it for that run, and a value closed over at
  // activation would apply the previous window's setting for the rest of the session.
  const spendWatcher = createSpendBoundWatcher({
    // FR-R4-F02 (E2 G6) — the values of the same read the disclosure shows the origins of.
    config: () => {
      const { limitUsd, limitTokens } = readSpendLimits();
      return { limitUsd: limitUsd.value, limitTokens: limitTokens.value };
    },
    findRunById: (runId) => input.store.findRunById(runId),
    // The same fenced write the operator's own pause makes. An unfenced claim is
    // refused by the store, which is the correct outcome: a window that has lost
    // primacy must not stamp another window's Run.
    //
    // FR-R4-F01 (FR-008) — only the pause pair the watcher stamped is written, as a PATCH of
    // the Run as it is inside the chain. The watcher hands over a whole Run built from its own
    // earlier read; writing that back would carry a stale snapshot over whatever landed since.
    // A pause already in place (an operator's, a breakpoint's) is not stamped over.
    pause: async (queueId, run) => {
      await input.store.updateRun(
        queueId,
        {
          runId: run.id,
          allowedStatuses: LIVE_RUN_STATUSES,
          label: 'spend-pause',
          patch: (current) =>
            current.manualPauseAt !== null
              ? {}
              : { manualPauseAt: run.manualPauseAt, manualPauseCause: run.manualPauseCause }
        },
        input.store.runCommitClaim(queueId)
      );
    },
    // `void`, not returned: `Notifier.warn` resolves when the operator dismisses the notice, and
    // the watcher's contract is fire-and-forget — awaiting an operator's attention inside a bound
    // check would stall the next evaluation behind a toast nobody clicked.
    notify: (message) => {
      void input.notifier.warn(message);
    },
    logger: input.logger,
    now: () => Date.now()
  });
  input.context.subscriptions.push(input.auditWriter.subscribe(spendWatcher.onAuditEntry));
  // FR-R3-209, FR-R4-F02 (contract S4 G16, G17) — the tally a restart emptied is rebuilt by a
  // bounded replay of the audit chain for the Runs that can still move (`failed` included, OD-1),
  // and each comes back complete or with the reason it is only a lower bound. A read is the only
  // act: it writes nothing, and the watcher counts a row once whichever way it arrives.
  void spendWatcher.seedFrom(
    readSpendReplay(
      input.workspaceRoot,
      input.logger,
      spendSeedTargets(Object.values(input.store.getRunMap()))
    )
  );

  // FR-R6-F05 (FR-005) — active and paused runs pin their checkpoints; the
  // predicate reads the run map at sweep time, not at construction.
  const checkpointRetention = new RunCheckpointRetentionService({
    globalStorageRoot: input.context.globalStorageUri.fsPath,
    logger: input.logger,
    isPinnedRun: recoveryPinnedRunPredicate(() => input.store.getRunMap())
  });
  // FR-R3-136 (FR-011) — deferred with the same reasoning, and it needs its own
  // sentence because the writes are NOT under the workspace: the sweep deletes
  // checkpoint archives under `context.globalStorageUri`. It is still a producer
  // act under T1523a's criterion, which is about paths the workspace or persisted
  // state can INFLUENCE rather than paths inside the folder. An untrusted folder
  // therefore gets to name what a global-storage sweep deletes, which reaches
  // further than the folder that supplied the names.
  //
  // HOW it gets to name them, corrected by FR-R3-146. This said candidates were
  // "read out of `.schegent/state.json`", which is wrong twice: no such file
  // exists, and the sweep reads no state at all. `runSweep` enumerates the
  // checkpoint root with `readdir`, so the candidates are DIRECTORY NAMES — and
  // those names are run ids the checkpoint service wrote when the runs they
  // belong to were persisted. The influence is real and one step longer than the
  // old sentence claimed.
  const resolveRunCwd = async (run: WorkflowRun): Promise<string> => {
    const coord = sqliteCutover?.getRunLaneCoordinator();
    if (!coord) return input.workspaceRoot;
    return coord.resolveExecutionRoot({
      runId: run.id,
      laneId: run.laneId,
      laneRootRef: run.laneRootRef
    });
  };
  const checkpoints = new RunCheckpointService(
    input.context.globalStorageUri.fsPath,
    input.workspaceRoot,
    input.logger,
    () => inFlightRuns().length,
    mutationLedger,
    undefined,
    resolveRunCwd
  );
  const lockRegistration = getWorkspaceLockForStore(input.store);
  const sqliteCutover = lockRegistration
    ? createSqliteCutoverCoordinator({
        context: input.context,
        workspaceRoot: input.workspaceRoot,
        store: input.store,
        auditWriter: input.auditWriter,
        envelopes: checkpoints,
        pinnedRunIds: input.protectedSessionRunIds,
        logger: input.logger,
        isWorkspaceTrusted: () => vscode.workspace.isTrusted,
        hasPrimacy: () => lockRegistration.lock.hasPrimacy(),
        disposables: lockRegistration.disposables
      })
    : undefined;
  const provisionRunLane = async (rootExecutionId: string, aliasRunId?: string) => {
    if (!readLanesEnabled(input.workspaceRoot)) return null;
    await sqliteCutover?.activatePrimary();
    const coord = sqliteCutover?.getRunLaneCoordinator();
    return coord ? coord.provisionForRun(rootExecutionId, aliasRunId) : null;
  };
  const sweepCheckpointRetention = (): Promise<unknown> => checkpointRetention.sweep();
  return {
    terminalTransitions,
    mutationLedger,
    spendWatcher,
    checkpointRetention,
    replayTerminalTransitions,
    reconcileComposableWorkflowRuns: runComposableWorkflowRecovery,
    sweepCheckpointRetention,
    bindGuardedRun,
    checkpoints,
    provisionRunLane,
    resolveRunCwd,
    onRunLanePaused: (laneId: string | undefined) => sqliteCutover?.getRunLaneCoordinator()?.onRunPaused(laneId),
    onRunLaneResumed: (runId: string) => sqliteCutover?.getRunLaneCoordinator()?.onRunResumed(runId),
    // Feature 098 (SEC-02) — a real, awaited approve/cancel decision bound to
    // the mutation fingerprint. `showWarningMessage` with `modal: true` adds
    // its own Cancel button and resolves `undefined` on dismissal, so the only
    // value that grants is the explicit approve label.
    //
    // FR-R3-146 (FR-006, FR-007) — wrapped in the durable grant. The lookup and
    // the write both live here rather than in `git-approval.ts` because this is
    // where the store already is, which keeps that module a pure decision and
    // leaves `workflow-run-factory.ts` untouched (plan A7).
    requestGitApproval: createPersistentGitApproval({
      request: createGitApprovalRequester({
        confirm: (message, detail, actions) =>
          Promise.resolve(
            vscode.window.showWarningMessage(message, { modal: true, detail }, ...actions)
          ),
        logger: input.logger
      }),
      // Both thunks read the store when the question is asked, not when the
      // wiring is built — the rule stated for the spend bound above.
      isGranted: (fingerprint) => input.store.hasGitPlanGrant(fingerprint),
      persist: (plan) =>
        input.store.recordGitPlanGrant({
          fingerprint: plan.fingerprint,
          grantedAt: Date.now(),
          phaseIds: plan.gitCapablePhaseIds,
          pipelineId: plan.pipelineId ?? UNRECORDED_PIPELINE_ID
        }),
      logger: input.logger
    }),
    // FR-R3-146 (FR-002) — the same seam, the same modal shape, for the same
    // reason: only the explicit action grants, and dismissal resolves `undefined`.
    //
    // `getConfiguration()` with no section, so the requester writes the one full
    // key it owns. Called per prompt rather than captured, because the value it
    // appends to must be the value as it stands when the operator answers.
    requestUncontainedConsent: createUncontainedConsentRequester({
      confirm: (message, detail, approveLabel) =>
        Promise.resolve(
          vscode.window.showWarningMessage(message, { modal: true, detail }, approveLabel)
        ),
      config: {
        get: <T,>(key: string): T | undefined =>
          vscode.workspace.getConfiguration().get<T>(key),
        update: (key, value, target) =>
          vscode.workspace.getConfiguration().update(key, value, target)
      },
      logger: input.logger
    }),
    recordContainmentAcceptance: input.recordContainmentAcceptance,
    onRunTerminal: async (run: import('../state/workflow-run').WorkflowRun) => {
      if (!isOperableRunStatus(run.status)) {
        spendWatcher.forget(run.id);
      }
      // FR-R4-F04 (X5) — transport first, in its own `try`, so a failure here never stops the raw
      // transcript's finalize or the retention sweep below. `finalizeRun` reports its own failures and
      // does not throw; this guards the call, not the contract.
      try {
        await input.transportRouter.finalizeRun(run.id, run.status, input.protectedSessionRunIds());
      } catch {
        // Reported once by the router; the Run's end goes on.
      }
      await input.rawTranscript.finalizeRun(
        run.id,
        run.status,
        run.rawTranscriptMode ?? 'always'
      );
      if (run.status !== 'paused') {
        await input.sessionRetention.sweep(input.protectedSessionRunIds());
      }
      await recordConnectedWorkflowTransition(
        {
          ...input,
          getGuardedRun: () => boundGuardedRun,
          getDefaultRunnerKind: () => boundDefaultRunnerKind
        },
        run
      );
    }
  };
}

/**
 * FR-R3-129 (T1491 wiring, FR-005) — append the routing decision for a connected
 * Workflow whose node just finished.
 *
 * WHAT WAS MISSING. `recordChildTerminal` — *"evaluate and record one node's
 * outgoing connections (FR-020, FR-030)"* — had **no production caller**. A whole
 * -tree sweep found it in two test files and nowhere in `src/`. So a connected
 * Workflow's node could reach a terminal state and no decision was appended, which
 * left the append-only trail that exists to answer *"why was this branch not
 * offered"* empty in every real Run.
 *
 * THIS IS NOT A SCHEDULER, and the distinction is exact. `recordChildTerminal`
 * evaluates the outgoing connections and RECORDS what it evaluated;
 * `continueConnectedRun` starts the next node and stays operator-invoked.
 * `FR-R3-088` refused a workflow scheduler deliberately (FR-039/FR-040: the
 * operator submits the continuation), and that refusal is untouched — recording
 * what was evaluated is what makes the manual offer explicable rather than
 * arbitrary. `tests/e2e/connected-workflow.test.ts` asserts that no node starts on
 * its own.
 *
 * BEST-EFFORT, on the same reasoning `settleTerminalRun` gives for `queue.finish`
 * and the history record: a Run that reached a terminal state has reached it, and a
 * failure to append a routing decision must not throw out of the terminal handler
 * and leave the rest of a Run's bookkeeping undone.
 *
 * A NO-OP FOR ALMOST EVERY RUN. Most Runs belong to no connected Workflow. The
 * guard is a lookup over the connected-run records before anything is constructed,
 * so an ordinary Run pays one map scan.
 */
function makePhaseDispatcher(deps: {
  readonly workspaceRoot?: string;
  readonly logger: SanitizedLogger;
  readonly historyStore?: Pick<HistoryStore, 'outputsFor'>;
  readonly getGuardedRun?: () => NodeRunStartDeps['guardedRun'] | undefined;
  readonly getDefaultRunnerKind?: () => BackendRunnerKind | undefined;
}): (phaseInput: PhaseAttemptDispatchInput) => Promise<PhaseAttemptDispatchResult> {
  return async (phaseInput) => {
    const guardedRun = deps.getGuardedRun?.();
    if (guardedRun === undefined || phaseInput.run.frozenClosure === undefined) {
      return { outcome: 'rejected', reason: 'launcher-unavailable' };
    }
    const defaultRunnerKind = deps.getDefaultRunnerKind?.();
    const historyStore = deps.historyStore;
    const started = await startPhaseAttempt(
      {
        guardedRun,
        ...(defaultRunnerKind !== undefined ? { defaultRunnerKind } : {}),
        ...(historyStore !== undefined
          ? { readPriorRunOutputs: (runId) => historyStore.outputsFor(runId) }
          : {}),
        logger: deps.logger
      },
      phaseInput,
      deps.workspaceRoot ?? null,
      { continuesWorkflow: true }
    );
    return phaseDispatchResultOf(started);
  };
}

function buildDeclaredOutputsFromRun(
  runOutputs: WorkflowRun['runOutputs']
): Readonly<Record<string, ResolvedPortValue>> {
  const out: Record<string, ResolvedPortValue> = {};
  for (const record of runOutputs ?? []) {
    if (record.status !== 'resolved' || record.reference === undefined) continue;
    out[record.name] = Object.freeze({
      portId: record.name,
      type: 'file',
      value: record.reference
    });
  }
  return Object.freeze(out);
}

export async function reconcileComposableWorkflowRuns(input: {
  readonly workspaceRoot: string;
  readonly store: {
    getConnectedRuns(): Readonly<Record<string, ConnectedWorkflowRun>>;
    getRunMap(): Readonly<Record<string, WorkflowRun | undefined>>;
    compareAndSetConnectedRun(
      next: ConnectedWorkflowRun,
      expectedRevision: number
    ): Promise<ConnectedRunWriteResult>;
    canCommitConnectedRun?(): Promise<boolean>;
    getQueueRegistry?(): { readonly entries: readonly { readonly id: string }[] };
    getQueue?(queueId: string): {
      readonly requests: readonly {
        readonly id: string;
        readonly status: string;
        readonly workflowOccurrence?: { readonly attemptId: string };
      }[];
    };
  };
  readonly historyStore?: Pick<HistoryStore, 'list' | 'outputsFor'>;
  readonly logger: SanitizedLogger;
  readonly getGuardedRun?: () => NodeRunStartDeps['guardedRun'] | undefined;
  readonly getDefaultRunnerKind?: () => BackendRunnerKind | undefined;
  readonly isQueueOrTaskPresent?: (queueId: string, rootRunId: string) => boolean;
  readonly capabilities?: BackendCapabilityService;
  readonly productionComposition?: ProductionWorkflowComposition;
}): Promise<void> {
  try {
    if (
      input.store.canCommitConnectedRun !== undefined &&
      !(await input.store.canCommitConnectedRun())
    ) {
      return;
    }
    const allRuns = Object.values(input.store.getConnectedRuns()).filter(
      (run) => run.invocations !== undefined
    );
    if (allRuns.length === 0) return;
    if (input.capabilities !== undefined && 'getRawControlLedger' in input.store) {
      const availabilityWiring = createBackendAvailabilityWiring({
        store: input.store as WorkspaceStateStore,
        capabilities: input.capabilities,
        hostEpoch: 'recovery-epoch'
      });
      availabilityWiring.dispose();
    }
    const composition =
      input.productionComposition ??
      getOrCreateProductionWorkflowComposition(input.store, {
        workspaceRoot: input.workspaceRoot
      });
    const recovery = composition.createRecoveryService({
      workspaceRoot: input.workspaceRoot,
      connectedRuns: {
        get: (id) => input.store.getConnectedRuns()[id] ?? null,
        list: () =>
          Object.values(input.store.getConnectedRuns()).filter(
            (run) => run.invocations !== undefined
          ),
        compareAndSetConnectedRun: (next, rev) =>
          input.store.compareAndSetConnectedRun(next, rev)
      },
      dispatchPhase: makePhaseDispatcher(input),
      isQueueOrTaskPresent: (queueId, rootRunId) => {
        if (
          input.isQueueOrTaskPresent !== undefined &&
          !input.isQueueOrTaskPresent(queueId, rootRunId)
        ) {
          return false;
        }
        if (
          input.store.getQueueRegistry !== undefined &&
          !input.store.getQueueRegistry().entries.some((entry) => entry.id === queueId)
        ) {
          return false;
        }
        if (input.store.getQueue !== undefined) {
          const wfRun = input.store.getConnectedRuns()[rootRunId] as
            | ConnectedWorkflowRun
            | undefined;
          const requests = input.store.getQueue(queueId).requests;
          for (const frame of Object.values(wfRun?.invocations ?? {})) {
            if (frame.status !== 'in-flight' && frame.status !== 'paused') continue;
            for (const attempts of Object.values(frame.attemptsByNodeId)) {
              const last = attempts[attempts.length - 1] as
                | (typeof attempts)[number]
                | undefined;
              if (
                last !== undefined &&
                last.queueItemId !== undefined &&
                (last.status === 'in-flight' || last.status === 'paused') &&
                requests.some(
                  (req) => req.id === last.queueItemId && req.status === 'canceled'
                )
              ) {
                return false;
              }
            }
          }
        }
        return true;
      },
      ...(input.store.getQueue !== undefined
        ? {
            findMatchingEnqueuedAttempt: (queueId, attempt) =>
              input.store
                .getQueue!(queueId)
                .requests.find(
                  (req) =>
                    req.status !== 'canceled' &&
                    req.workflowOccurrence?.attemptId === attempt.attemptId
                )?.id
          }
        : {}),
      checkDurableAttemptEvidence: (_workflowRun, _frame, attempt): DurableAttemptEvidenceResult => {
        if (attempt.queueItemId === undefined) return { completed: false };
        const liveMatch = Object.values(input.store.getRunMap()).find(
          (candidate) => candidate !== undefined && candidate.featureId === attempt.queueItemId
        );
        if (liveMatch !== undefined && isWorkflowNodeTerminalStatus(liveMatch.status)) {
          return {
            completed: true,
            status: liveMatch.status,
            declaredOutputs: buildDeclaredOutputsFromRun(liveMatch.runOutputs),
            completedAt: liveMatch.lastTransitionAt
          };
        }
        const historyMatch = input.historyStore
          ?.list()
          .find((entry) => entry.featureId === attempt.queueItemId);
        if (
          historyMatch !== undefined &&
          isWorkflowNodeTerminalStatus(historyMatch.terminalStatus)
        ) {
          const parsedCompletedAt = Date.parse(historyMatch.completedAt);
          return {
            completed: true,
            status: historyMatch.terminalStatus,
            declaredOutputs: buildDeclaredOutputsFromRun(historyMatch.runOutputs),
            completedAt: Number.isFinite(parsedCompletedAt) ? parsedCompletedAt : Date.now()
          };
        }
        return { completed: false };
      }
    });
    await recovery.reconcileAllRuns(Date.now());
  } catch (error) {
    input.logger.warn(
      `run-safety-wiring: connected-workflow recovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function recordConnectedWorkflowTransition(
  input: {
    readonly workspaceRoot?: string;
    readonly historyStore?: Pick<HistoryStore, 'outputsFor'>;
    readonly store: {
      getConnectedRuns(): Readonly<Record<string, ConnectedWorkflowRun>>;
      getRunMap(): Readonly<Record<string, WorkflowRun | undefined>>;
      getHistory(): readonly object[];
      compareAndSetConnectedRun(
        next: ConnectedWorkflowRun,
        expectedRevision: number
      ): Promise<ConnectedRunWriteResult>;
    };
    readonly logger: SanitizedLogger;
    readonly getGuardedRun?: () => NodeRunStartDeps['guardedRun'] | undefined;
    readonly getDefaultRunnerKind?: () => BackendRunnerKind | undefined;
    readonly productionComposition?: ProductionWorkflowComposition;
  },
  run: import('../state/workflow-run').WorkflowRun
): Promise<void> {
  try {
    const connected: readonly ConnectedWorkflowRun[] = Object.values(
      input.store.getConnectedRuns()
    );
    if (connected.length === 0) return;
    for (const workflowRun of connected) {
      for (const record of Object.values(workflowRun.nodes)) {
        const attemptIndex = record.attempts.findIndex(
          (attempt: { readonly queueItemId: string }) => attempt.queueItemId === run.featureId
        );
        if (attemptIndex < 0) continue;
        await recordChildTerminal(
          {
            connectedRuns: input.store,
            readChildFacts: makeChildRunFactsReader({
              runsByQueue: () => input.store.getRunMap(),
              history: () => input.store.getHistory()
            }),
            logger: input.logger
          },
          {
            run: workflowRun,
            nodeId: record.nodeId,
            attemptIndex,
            decidedAt: Date.now()
          }
        );
        return;
      }

      if (workflowRun.invocations !== undefined && isWorkflowNodeTerminalStatus(run.status)) {
        for (const frame of Object.values(workflowRun.invocations)) {
          for (const attempts of Object.values(frame.attemptsByNodeId)) {
            const matchedAttempt = attempts.find(
              (candidate) =>
                candidate.queueItemId === run.featureId && candidate.status === 'in-flight'
            );
            if (matchedAttempt === undefined) continue;
            const composition =
              input.productionComposition ??
              getOrCreateProductionWorkflowComposition(input.store, {
                ...(input.workspaceRoot !== undefined
                  ? { workspaceRoot: input.workspaceRoot }
                  : {})
              });
            const cutover =
              'getRawControlLedger' in input.store
                ? getSqliteCutoverCoordinator(input.store as WorkspaceStateStore)
                : undefined;
            const execRoot =
              (await cutover?.getRunLaneCoordinator()?.resolveExecutionRoot({
                runId: run.id,
                laneId: run.laneId,
                laneRootRef: run.laneRootRef
              })) ??
              input.workspaceRoot ??
              '';
            const phase =
              workflowRun.frozenClosure?.phasesById[matchedAttempt.targetDefinitionId];
            const evaluated = await composition.evaluateSettlementOutcome({
              attemptId: matchedAttempt.attemptId,
              workspaceRoot: execRoot,
              status: run.status,
              phase,
              declaredOutputs: buildDeclaredOutputsFromRun(run.runOutputs),
              evaluatedAt: run.lastTransitionAt
            });
            const controlService = composition.createControlService({
              ...(input.workspaceRoot !== undefined
                ? { workspaceRoot: input.workspaceRoot }
                : {}),
              connectedRuns: {
                get: (id) => input.store.getConnectedRuns()[id] ?? null,
                compareAndSetConnectedRun: (next, rev) =>
                  input.store.compareAndSetConnectedRun(next, rev)
              },
              dispatchPhase: makePhaseDispatcher(input)
            });
            await controlService.completeNodeAttemptSerialized({
              runId: workflowRun.connectedRunId,
              invocationId: frame.invocationId,
              nodeId: matchedAttempt.nodeId,
              attemptIndex: matchedAttempt.attemptIndex,
              status: evaluated.status,
              completedAt: run.lastTransitionAt,
              declaredOutputs: evaluated.declaredOutputs,
              ...(evaluated.decisionResults !== undefined
                ? { decisionResults: evaluated.decisionResults }
                : {}),
              ...(evaluated.verdict !== undefined ? { verdict: evaluated.verdict } : {}),
              ...(evaluated.failureCode !== undefined
                ? { failureCode: evaluated.failureCode }
                : {})
            });
            const refreshedWf = input.store.getConnectedRuns()[workflowRun.connectedRunId] as
              | ConnectedWorkflowRun
              | undefined;
            const rootStatus = Object.values(refreshedWf?.invocations ?? {}).find(
              (f) => f.parentInvocationId === null
            )?.status;
            if (
              rootStatus === 'completed' ||
              rootStatus === 'failed' ||
              rootStatus === 'canceled'
            ) {
              cutover?.completeRootExecutionLane({
                rootExecutionId: workflowRun.connectedRunId,
                laneId: run.laneId,
                status: rootStatus
              });
            }
            return;
          }
        }
      }
    }
  } catch (error) {
    // See the docblock: best-effort by design.
    input.logger.warn(
      `run-safety-wiring: connected-workflow routing record failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
