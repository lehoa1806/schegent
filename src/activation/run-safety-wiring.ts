import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { RawTranscriptWriter } from '../audit/raw-transcript-writer';
import type { QueueManager } from '../queue/queue-manager';
import type { SanitizedLogger } from '../lib/logger';
import type { HistoryStore } from '../state/history-store';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { isTerminalRunStatus } from '../state/workflow-run';
import { createGitApprovalRequester } from './git-approval';
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
  await terminalTransitions.replay();
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
  void checkpointRetention.sweep();
  return {
    terminalTransitions,
    mutationLedger,
    spendWatcher,
    checkpointRetention,
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
    requestGitApproval: createGitApprovalRequester({
      confirm: (message, detail, approveLabel) =>
        Promise.resolve(
          vscode.window.showWarningMessage(message, { modal: true, detail }, approveLabel)
        ),
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
