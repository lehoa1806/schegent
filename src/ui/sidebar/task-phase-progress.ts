// FR-R3-158 — the settled-phase pair that every Task row carries, and the two
// readings the resolution needs from the composer.
//
// Its own module rather than more of `queue-projector.ts`: the projector's job
// is to shape a queue's rows, and this is one field's four-source resolution
// with its own rule about what "unknown" means. Keeping it here also keeps that
// module inside the 300-line bound `tests/lint/source-loc-budget.test.ts` holds
// every sidebar projector to.

import type { TaskPhaseProgressProjection } from '../../contracts/snapshot-projections';
import type { PipelineDef } from '../../contracts/snapshot-vocabulary';
import type { FeatureRequest } from '../../queue/feature-request';
import {
  computePlannedTotal,
  settledPhaseProgress,
  type PlannedPhase
} from '../../services/run-planned-total';
import type { WorkflowRun } from '../../state/workflow-run';

/** The two readings the four-source chain takes from outside the Task record. */
export interface TaskPhaseProgressContext {
  /**
   * Source 2 — the settled-phase pair of the Run this queue is holding, already
   * paired by `settledPhaseProgress`. It answers for exactly one row, the one
   * `activeRunTaskId` names; every other row in the queue would be reading a
   * figure that belongs to a different task.
   *
   * `null` for a queue with no Run, or a Run that froze no plan. Absent on a
   * caller with no run wiring, which is the same answer.
   */
  readonly liveRunProgress?: TaskPhaseProgressProjection | null;
  /**
   * Source 3 — the phases the named pipeline plans, or `null` when the id does
   * not resolve in the operator's catalog. A lookup rather than a catalog, so
   * the resolution holds no opinion about where a pipeline comes from and a host
   * with no catalog wiring resolves nothing instead of a fabricated total.
   */
  readonly plannedPhasesOf?: (pipelineId: string) => readonly PlannedPhase[] | null;
}

/**
 * Build both readings from what the snapshot composer already has in hand: the
 * queue's own Run, and the operator's pipeline catalog.
 *
 * Shaped here rather than inline in `snapshot-composer.ts` so the composer hands
 * over its two values without knowing how a row turns them into a figure — and
 * because the composer sits one line under its own LOC ceiling.
 */
export function phaseProgressContext(
  run: WorkflowRun | null,
  pipelines: readonly PipelineDef[]
): TaskPhaseProgressContext {
  return {
    liveRunProgress: settledPhaseProgress(run),
    plannedPhasesOf: (pipelineId: string) => {
      const phases = pipelines.find((pipeline) => pipeline.id === pipelineId)?.phases;
      return phases === undefined ? null : phases.map((id) => ({ id }));
    }
  };
}

/**
 * FR-R3-158 (FR-002, T019) — the settled-phase pair for one Task row, resolved
 * by the four-source chain in `data-model.md` §3.
 *
 * The chain's defining property is what it does **not** do: no step reads
 * `req.status`. `completed` gets no shortcut to a full count, `failed` gets no
 * shortcut to zero, and a row's figure therefore cannot change meaning as the
 * task moves between statuses. FR-002 says no status may be given its own
 * arithmetic; the way to make that true rather than merely intended is to give
 * the resolution nothing to branch on.
 *
 * In order:
 *   1. The pair recorded on the task when it reached a terminal status. It wins
 *      even while a live Run exists (FR-009a) — otherwise the figure would
 *      alternate between the recorded number and a re-derived one as the Run
 *      came and went, and the operator would be reading two different answers to
 *      one question.
 *   2. The queue's live Run, for the one task that owns it.
 *   3. The task's bound pipeline, counted with an empty override set, at
 *      `settled: 0`. This is what keeps a queued task reading `0 of N`.
 *   4. `null` — unknown, and rendered as no figure at all, never as `0 of 0`.
 *
 * Source 3 goes through `computePlannedTotal` and never through
 * `pipeline.phases.length` (D4). The raw length counts a repeated phase twice
 * and subtracts no overrides, which is how a total smaller than its own
 * numerator gets produced.
 */
export function resolveTaskPhaseProgress(
  req: FeatureRequest,
  ctx: TaskPhaseProgressContext & { readonly activeRunTaskId?: string | null }
): TaskPhaseProgressProjection | null {
  if (req.phaseProgress !== undefined) return req.phaseProgress;
  if (req.id === ctx.activeRunTaskId && ctx.liveRunProgress) return ctx.liveRunProgress;
  // `pipelineId?: string` — optional, never null. The `=== null` half this once
  // carried had no overlap with the declared type, so it read as a guard while
  // testing nothing.
  const pipelineId = req.pipelineId;
  if (pipelineId === undefined) return null;
  const phases = ctx.plannedPhasesOf?.(pipelineId);
  if (!phases || phases.length === 0) return null;
  // An empty override set: the task has no Run, so it has no override list to
  // subtract. The count is what the catalog plans today, which is the honest
  // answer for work that has not started.
  const total = computePlannedTotal({ phases, overrides: [], iterationCap: undefined });
  return total.phaseCount === 0 ? null : Object.freeze({ settled: 0, total: total.phaseCount });
}
