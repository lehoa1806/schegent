import * as vscode from 'vscode';
import type { RawTranscriptWriter } from '../audit/raw-transcript-writer';
import type { QueueManager } from '../queue/queue-manager';
import type { SanitizedLogger } from '../lib/logger';
import type { HistoryStore } from '../state/history-store';
import type { WorkspaceStateStore } from '../state/workspace-state';
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
      input.logger
    ),
    requestGitApproval: async (plan: import('../state/workflow-run').MutationPlanSnapshot) => {
      const selection = await vscode.window.showWarningMessage(
        `This run can change Git state in ${plan.gitCapablePhaseIds.length} phase(s): ${plan.gitCapablePhaseIds.join(', ')}. Approval is frozen to plan ${plan.fingerprint.slice(0, 12)}.`,
        { modal: true, detail: 'Schegent checkpoints before each Git-capable phase. Catalog changes require new approval.' },
        'Approve Git Plan'
      );
      return selection === 'Approve Git Plan';
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
