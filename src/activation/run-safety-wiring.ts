import * as vscode from 'vscode';
import type { RawTranscriptWriter } from '../audit/raw-transcript-writer';
import type { QueueManager } from '../queue/queue-manager';
import type { SanitizedLogger } from '../lib/logger';
import type { HistoryStore } from '../state/history-store';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { isTerminalRunStatus } from '../state/workflow-run';
import { HistoryRecorder } from '../services/history-recorder';
import { RunCheckpointService } from '../services/run-checkpoint-service';
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
}) {
  const terminalTransitions = new TerminalTransitionCoordinator(
    input.store,
    input.queue,
    new HistoryRecorder({ historyStore: input.historyStore, logger: input.logger }),
    input.logger
  );
  await terminalTransitions.replay();
  return {
    terminalTransitions,
    checkpoints: new RunCheckpointService(
      input.context.globalStorageUri.fsPath,
      input.workspaceRoot,
      input.logger,
      // Feature 093 (T053, FR-022a) — Runs that could hold uncommitted work in
      // the shared worktree. Counted as **non-terminal**, which is wider than
      // "currently executing" on purpose: a paused Run's edits are still sitting
      // in the worktree, so a sibling's `git diff HEAD` would sweep them into a
      // snapshot whose restore reverts them. Terminal Runs linger in the record
      // until their queue starts another, and counting those would decline
      // every checkpoint forever once two queues had each finished one.
      () =>
        Object.values(input.store.getRunMap()).filter(
          (run) => !isTerminalRunStatus(run.status)
        ).length
    ),
    requestGitApproval: async (plan: import('../state/workflow-run').MutationPlanSnapshot) => {
      const msg = `This run can change Git state in ${plan.gitCapablePhaseIds.length} phase(s): ${plan.gitCapablePhaseIds.join(', ')}.`;
      input.logger.warn(`pipeline.git-approval-bypassed msg="${msg}" fingerprint=${plan.fingerprint}`);
      vscode.window.showWarningMessage(msg);
      return true;
    },
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
