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
import type { HistoryStore } from '../state/history-store';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { isTerminalRunStatus } from '../state/workflow-run';
import { createGitApprovalRequester, createPersistentGitApproval } from './git-approval';
import { UNRECORDED_PIPELINE_ID } from '../state/git-plan-grants';
import { createUncontainedConsentRequester } from './uncontained-consent';
import { createHistoryRecorder } from '../services/history-recorder';
import { MetricsRollupWriter } from '../metrics/metrics-rollup-writer';
import { TerminalRunRollupRecorder } from '../metrics/terminal-run-rollup-recorder';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { EvidenceHealthReporter } from '../services/evidence-health/evidence-health-monitor';
import type { Notifier } from '../ui/notifications';
import { createSpendBoundWatcher } from '../services/spend-bound-watcher';
import { RunCheckpointService } from '../services/run-checkpoint-service';
import { RunCheckpointRetentionService } from '../services/run-checkpoint-retention';
import { RunMutationLedger } from '../services/run-mutation-ledger';
import type { SessionArtifactRetentionService } from '../services/session-retention/session-artifact-retention-service';
import { TerminalTransitionCoordinator } from '../services/terminal-transition-coordinator';
import { recordChildTerminal } from '../services/workflow-execution/connected-run-coordinator';
import { makeChildRunFactsReader } from '../services/workflow-execution/child-run-facts-reader';
import type { ConnectedWorkflowRun } from '../state/connected-workflow-run';
import type { ConnectedRunWriteResult } from '../state/workspace-state';
import type { WorkflowRun } from '../state/workflow-run';

export async function createRunSafetyWiring(input: {
  context: vscode.ExtensionContext;
  workspaceRoot: string;
  store: WorkspaceStateStore;
  queue: QueueManager;
  historyStore: HistoryStore;
  logger: SanitizedLogger;
  rawTranscript: RawTranscriptWriter;
  sessionRetention: SessionArtifactRetentionService;
  protectedSessionRunIds: () => ReadonlySet<string>;
  evidenceHealth: EvidenceHealthReporter;
  auditWriter: AuditLogWriter;
  notifier: Notifier;
}) {
  // FR-R3-009 — the durable cumulative-totals rollup. Constructed here so the
  // terminal-transition coordinator, which is the single append site, is the only
  // thing that holds it.
  const metricsRollupWriter = new MetricsRollupWriter({
    workspaceRoot: input.workspaceRoot,
    logger: input.logger,
    evidenceHealth: input.evidenceHealth
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
    new TerminalRunRollupRecorder({
      writer: metricsRollupWriter,
      logger: input.logger,
      workspaceRoot: input.workspaceRoot
    })
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
  const replayTerminalTransitions = (): Promise<void> => terminalTransitions.replay();
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
    readDiff: async () =>
      (
        await promisify(execFile)('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], {
          cwd: input.workspaceRoot,
          maxBuffer: 20 * 1024 * 1024
        })
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
    config: () => {
      const settings = vscode.workspace.getConfiguration('schegent');
      return {
        limitUsd: settings.get<number | null>('spend.maxUsdPerRun', null),
        limitTokens: settings.get<number | null>('spend.maxTokensPerRun', null)
      };
    },
    findRunById: (runId) => input.store.findRunById(runId),
    // The same fenced write the operator's own pause makes. An unfenced claim is
    // refused by the store, which is the correct outcome: a window that has lost
    // primacy must not stamp another window's Run.
    pause: async (queueId, run) => {
      await input.store.setRun(queueId, run, input.store.runCommitClaim(queueId));
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

  const checkpointRetention = new RunCheckpointRetentionService({
    globalStorageRoot: input.context.globalStorageUri.fsPath,
    logger: input.logger
  });
  // FR-R3-136 (FR-011) — deferred with the same reasoning, and it needs its own
  // sentence because the writes are NOT under the workspace: the sweep deletes
  // checkpoint archives under `context.globalStorageUri`. It is still a producer
  // act under T1523a's criterion, which is about paths the workspace or persisted
  // state can INFLUENCE rather than paths inside the folder — every candidate is
  // selected from run ids read out of `.schegent/state.json`. An untrusted folder
  // therefore gets to name what a global-storage sweep deletes, which reaches
  // further than the folder that supplied the names.
  const sweepCheckpointRetention = (): Promise<unknown> => checkpointRetention.sweep();
  return {
    terminalTransitions,
    mutationLedger,
    spendWatcher,
    checkpointRetention,
    replayTerminalTransitions,
    sweepCheckpointRetention,
    checkpoints: new RunCheckpointService(
      input.context.globalStorageUri.fsPath,
      input.workspaceRoot,
      input.logger,
      () => inFlightRuns().length,
      mutationLedger
    ),
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
    onRunTerminal: async (run: import('../state/workflow-run').WorkflowRun) => {
      await input.rawTranscript.finalizeRun(
        run.id,
        run.status,
        run.rawTranscriptMode ?? 'always'
      );
      if (run.status !== 'paused') {
        await input.sessionRetention.sweep(input.protectedSessionRunIds());
      }
      await recordConnectedWorkflowTransition(input, run);
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
async function recordConnectedWorkflowTransition(
  input: {
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
