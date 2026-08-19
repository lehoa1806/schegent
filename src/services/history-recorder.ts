// Feature 013 — Wave 7 (US7 / T098): history-write logic extracted
// from `WorkflowController`. The orchestrator calls
// `historyRecorder.record(run, description, terminalStatus)` at each
// terminal transition (completed/failed/canceled) instead of holding
// the sanitization + buildHistoryEntry plumbing inline.
//
// Owns: HistoryStore.append + buildHistoryEntry + error swallowing.
// Sanitization happens inside `buildHistoryEntry` via the injected
// logger (FR-029 sanitize-once invariant).
//
// FR-R3-010 (T405) added two responsibilities, both of them consequences of
// history becoming per-queue and the description leaving control state:
//
//   - It names the queue. `HistoryStore.append` no longer accepts an entry
//     without one, and this is the layer that can answer — it holds the queue
//     manager, the store does not.
//   - It writes the description to evidence and stamps the reference. The write
//     happens here rather than in the builder because a reference is a claim
//     that something is retrievable, and only the store's answer makes it true.
//
// Neither can fail a completion. A Run that finished, finished; a description
// that could not be written costs a replay convenience, and a queue that could
// not be resolved costs an attribution, and both are recorded rather than
// raised.

import type { HistoryStore } from '../state/history-store';
import {
  buildHistoryEntry,
  withDescriptionRef,
  HISTORY_UNATTRIBUTED_QUEUE_ID
} from '../state/history-entry';
import type { HistoryDescriptionStore } from './history/history-description-store';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkflowRun } from '../state/workflow-run';

export interface HistoryRecorderDeps {
  readonly historyStore: Pick<HistoryStore, 'append'> | null;
  readonly logger: SanitizedLogger;
  /**
   * The queue a Task belongs to, or `null` when no queue holds it.
   *
   * Deliberately **not** `QueueManager.queueIdForTask`, which falls back to
   * `DEFAULT_QUEUE_ID` for a Task it cannot find. That fallback is right for
   * the caller that has to put work somewhere; it is wrong here, because a
   * guessed queue files one queue's record under another queue's name and the
   * operator asking "what has this queue done" gets an answer that is wrong
   * rather than incomplete. `null` routes to the documented unattributed
   * partition instead.
   */
  readonly queueIdForTask: (taskId: string) => string | null;
  readonly descriptions: Pick<HistoryDescriptionStore, 'write' | 'remove'>;
}

export class HistoryRecorder {
  private readonly historyStore: Pick<HistoryStore, 'append'> | null;
  private readonly logger: SanitizedLogger;
  private readonly queueIdForTask: (taskId: string) => string | null;
  private readonly descriptions: Pick<HistoryDescriptionStore, 'write' | 'remove'>;

  constructor(deps: HistoryRecorderDeps) {
    this.historyStore = deps.historyStore;
    this.logger = deps.logger;
    this.queueIdForTask = deps.queueIdForTask;
    this.descriptions = deps.descriptions;
  }

  public async record(
    run: WorkflowRun,
    description: string,
    terminalStatus: 'completed' | 'failed' | 'canceled'
  ): Promise<void> {
    if (!this.historyStore) return;
    try {
      const built = buildHistoryEntry({
        runId: run.id,
        featureId: run.featureId,
        description,
        terminalStatus,
        startedAt: run.startedAt,
        completedAt: run.lastTransitionAt,
        lastErrorSummary: run.lastError?.message ?? null,
        logger: this.logger,
        pipelineId: run.pipeline?.id ?? null,
        // Feature 091 (T013, FR-010) — the recorder is the only writer of a
        // history entry, so it is the only route by which what a Run recorded
        // outlives the Run itself.
        runOutputs: run.runOutputs
      });
      // The Task row outlives the Run: `QueueManager.finish()` marks it rather
      // than removing it, so the lookup resolves for every ordinary completion
      // and the unattributed partition is reached only when the Task really is
      // gone — a delete or a clear-all that raced the terminal transition.
      const queueId = this.queueIdForTask(run.featureId) ?? HISTORY_UNATTRIBUTED_QUEUE_ID;
      const ref = await this.descriptions.write(run.id, built.fullDescription);
      const evicted = await this.historyStore.append(
        queueId,
        withDescriptionRef(built.entry, ref)
      );
      await this.discardEvictedDescriptions(evicted);
    } catch (err) {
      this.logger.warn(`history append failed: ${(err as Error).message}`);
    }
  }

  /**
   * Remove the description files of entries the per-queue cap just evicted.
   *
   * Without this the on-disk set grows for the life of the workspace while the
   * memento stays bounded, which is the amplification this feature removed
   * reappearing one layer down. The cap is the single retention rule for both:
   * an entry leaves history and its description leaves with it.
   *
   * Best-effort by construction — `remove` swallows its own failures, and an
   * orphaned file is inert. An eviction whose `runId` is not a string is
   * skipped rather than guessed at; it names no file this store would have
   * written.
   */
  private async discardEvictedDescriptions(evicted: readonly object[]): Promise<void> {
    for (const row of evicted) {
      const runId = (row as { runId?: unknown }).runId;
      if (typeof runId === 'string' && runId.length > 0) {
        await this.descriptions.remove(runId);
      }
    }
  }
}
