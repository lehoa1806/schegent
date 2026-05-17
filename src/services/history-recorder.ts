// Feature 013 — Wave 7 (US7 / T098): history-write logic extracted
// from `WorkflowController`. The orchestrator calls
// `historyRecorder.record(run, description, terminalStatus)` at each
// terminal transition (completed/failed/canceled) instead of holding
// the sanitization + buildHistoryEntry plumbing inline.
//
// Owns: HistoryStore.append + buildHistoryEntry + error swallowing.
// Sanitization happens inside `buildHistoryEntry` via the injected
// logger (FR-029 sanitize-once invariant).

import type { HistoryStore } from '../state/history-store';
import { buildHistoryEntry } from '../state/history-entry';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkflowRun } from '../state/workflow-run';

export interface HistoryRecorderDeps {
  readonly historyStore: Pick<HistoryStore, 'append'> | null;
  readonly logger: SanitizedLogger;
}

export class HistoryRecorder {
  private readonly historyStore: Pick<HistoryStore, 'append'> | null;
  private readonly logger: SanitizedLogger;

  constructor(deps: HistoryRecorderDeps) {
    this.historyStore = deps.historyStore;
    this.logger = deps.logger;
  }

  public async record(
    run: WorkflowRun,
    description: string,
    terminalStatus: 'completed' | 'failed' | 'canceled'
  ): Promise<void> {
    if (!this.historyStore) return;
    try {
      const entry = buildHistoryEntry({
        runId: run.id,
        featureId: run.featureId,
        description,
        terminalStatus,
        startedAt: run.startedAt,
        completedAt: run.lastTransitionAt,
        lastErrorSummary: run.lastError?.message ?? null,
        logger: this.logger,
        pipelineId: run.pipeline?.id ?? null
      });
      await this.historyStore.append(entry);
    } catch (err) {
      this.logger.warn(`history append failed: ${(err as Error).message}`);
    }
  }
}
