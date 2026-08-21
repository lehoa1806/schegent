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
import type { EvidenceHealthReporter } from '../services/evidence-health/evidence-health-monitor';
import { RunCheckpointService } from '../services/run-checkpoint-service';
import { RunCheckpointRetentionService } from '../services/run-checkpoint-retention';
import { RunMutationLedger } from '../services/run-mutation-ledger';
import type { SessionArtifactRetentionService } from '../services/session-retention/session-artifact-retention-service';
import { TerminalTransitionCoordinator } from '../services/terminal-transition-coordinator';

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
  const checkpointRetention = new RunCheckpointRetentionService({
    globalStorageRoot: input.context.globalStorageUri.fsPath,
    logger: input.logger
  });
  void checkpointRetention.sweep();
  return {
    terminalTransitions,
    mutationLedger,
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
    }
  };
}
