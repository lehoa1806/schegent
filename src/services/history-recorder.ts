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
import { HistoryDescriptionStore } from './history/history-description-store';
import { historyErrorCode } from './history/error-code';
import { resolveRunOrigin } from './run-origin-resolver';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkflowRun } from '../state/workflow-run';
import type { RunOriginRef } from '../contracts/run-origin';

/**
 * FR-R3-071 — whether a terminal record is durable. `recorded` means the
 * history entry landed; `skipped-no-store` is a configured absence, not a
 * failure; `failed` carries the code the warn line already logged. The
 * terminal-transition coordinator clears its repair intent only on the first
 * two.
 */
export type HistoryRecordResult =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'skipped-no-store' }
  | { readonly outcome: 'failed'; readonly code: string };

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
  /**
   * Feature 103 (FR-013) — how the Run was started, from its Task id.
   *
   * Shaped like `queueIdForTask` and for the same reason: the lookup walks the
   * connected-run map, which this layer has no business holding. `null` means
   * "could not tell", and the recorder leaves the field absent rather than
   * guessing `'standalone'` — absence is a state the surface states plainly,
   * and a guess would assert on a row that a Workflow member ran alone.
   *
   * Read once here, at completion, because the aggregate that answers it is
   * deletable and the record it lands in is not.
   */
  readonly originForTask: (taskId: string) => RunOriginRef | null;
  readonly descriptions: Pick<HistoryDescriptionStore, 'write' | 'remove'>;
}

/**
 * The collaborators a composition root has to hand when it builds the recorder.
 *
 * Structural rather than the concrete `QueueManager` and `WorkspaceStateStore`:
 * the factory needs one method from each, and naming the classes would make
 * this module depend on two subsystems it otherwise knows nothing about.
 */
export interface HistoryRecorderWiring {
  readonly historyStore: Pick<HistoryStore, 'append'> | null;
  readonly logger: SanitizedLogger;
  readonly queue: { queueIdForExistingTask(taskId: string): string | null };
  readonly store: { getConnectedRuns(): Parameters<typeof resolveRunOrigin>[0] };
  readonly workspaceRoot: string;
}

/**
 * The recorder as every host wires it.
 *
 * Both composition roots — `SchegentWorkflowController` and
 * `createRunSafetyWiring` — built the same deps literal, and the three choices
 * in it are each the kind that is only wrong once: `queueIdForExistingTask`
 * rather than `queueIdForTask`, because the strict resolver returns `null` where
 * the other guesses `'default'` and the recorder cannot tell a resolved queue
 * from a guessed one (FR-R3-010); the origin read from the *live* map at
 * completion, because the aggregate answering it is deletable and the record it
 * lands in is not (FR-013); and the description store rooted at the workspace.
 * A second copy of that literal is a second chance to get one of them wrong, so
 * the copies are gone and the reasons live here.
 *
 * The class constructor stays public and takes ports directly — that is what
 * lets a test substitute all four without a workspace.
 */
export function createHistoryRecorder(wiring: HistoryRecorderWiring): HistoryRecorder {
  return new HistoryRecorder({
    historyStore: wiring.historyStore,
    logger: wiring.logger,
    queueIdForTask: (taskId) => wiring.queue.queueIdForExistingTask(taskId),
    originForTask: (taskId) => resolveRunOrigin(wiring.store.getConnectedRuns(), taskId),
    descriptions: new HistoryDescriptionStore({
      workspaceRoot: wiring.workspaceRoot,
      logger: wiring.logger
    })
  });
}

export class HistoryRecorder {
  private readonly historyStore: Pick<HistoryStore, 'append'> | null;
  private readonly logger: SanitizedLogger;
  private readonly queueIdForTask: (taskId: string) => string | null;
  private readonly originForTask: (taskId: string) => RunOriginRef | null;
  private readonly descriptions: Pick<HistoryDescriptionStore, 'write' | 'remove'>;

  constructor(deps: HistoryRecorderDeps) {
    this.historyStore = deps.historyStore;
    this.logger = deps.logger;
    this.queueIdForTask = deps.queueIdForTask;
    this.originForTask = deps.originForTask;
    this.descriptions = deps.descriptions;
  }

  public async record(
    run: WorkflowRun,
    description: string,
    terminalStatus: 'completed' | 'failed' | 'canceled'
  ): Promise<HistoryRecordResult> {
    // FR-R3-071 — the caller that clears the terminal repair intent needs to
    // know whether history is durable; the internal catch used to swallow that
    // answer, so a failed append still cleared the intent. The fire-and-forget
    // call sites keep ignoring the result, which is their existing behaviour.
    if (!this.historyStore) return { outcome: 'skipped-no-store' };
    try {
      // Feature 103 (T030, FR-015) — resolved before the build and each behind
      // its own guard, so an unanswerable provenance costs the field and not the
      // run. This is the posture the queue lookup above already has: a
      // completion that happened is recorded, and what could not be determined
      // about it is recorded as absent.
      const plan = this.planOf(run);
      const catalogVersion = plan?.catalogVersion;
      const origin = this.originOf(run);
      const built = buildHistoryEntry({
        runId: run.id,
        featureId: run.featureId,
        description,
        terminalStatus,
        startedAt: run.startedAt,
        completedAt: run.lastTransitionAt,
        lastErrorSummary: run.lastError?.message ?? null,
        logger: this.logger,
        pipelineId: plan?.id ?? null,
        // Feature 091 (T013, FR-010) — the recorder is the only writer of a
        // history entry, so it is the only route by which what a Run recorded
        // outlives the Run itself.
        runOutputs: run.runOutputs,
        ...(catalogVersion !== undefined ? { catalogVersion } : {}),
        ...(origin !== undefined ? { origin } : {})
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
      // A failed description write with a successful append is still
      // 'recorded': the entry exists and resolves as legacy/missing later,
      // which is the same shape a legacy entry already has. Durability here
      // means the ENTRY landed.
      return { outcome: 'recorded' };
    } catch (err) {
      const code = historyErrorCode(err);
      this.logger.warn(`history append failed: ${code}`);
      return { outcome: 'failed', code };
    }
  }

  /**
   * The Run's frozen plan, or `undefined` if reading it throws.
   *
   * One guarded read rather than one per field. Both `pipelineId` and
   * `catalogVersion` come off this object, and a second `run.pipeline` in the
   * argument list would be an unguarded read of the same throwing getter — which
   * is exactly the shape that took the whole entry down: FR-015 says an
   * unresolvable provenance field costs the field, and losing the run to it
   * costs the operator the completion itself.
   *
   * The version is copied off the plan and never re-resolved from the catalog,
   * which has moved on and would answer about today rather than about this run
   * (FR-010). A plan supplied ready-made carries none, and so does every run
   * recorded before feature 102; both are honest absences.
   */
  private planOf(run: WorkflowRun): WorkflowRun['pipeline'] | undefined {
    try {
      return run.pipeline;
    } catch (err) {
      this.logger.warn(`history provenance: plan unreadable: ${historyErrorCode(err)}`);
      return undefined;
    }
  }

  /** How the Run was started, or `undefined` when the port cannot say (FR-015). */
  private originOf(run: WorkflowRun): RunOriginRef | undefined {
    try {
      return this.originForTask(run.featureId) ?? undefined;
    } catch (err) {
      this.logger.warn(`history provenance: origin unresolved: ${historyErrorCode(err)}`);
      return undefined;
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
