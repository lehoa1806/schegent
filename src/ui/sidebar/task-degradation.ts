// FR-R3-157 — how a Task row learns it is degraded.
//
// Its own module rather than more of `queue-projector.ts`, on
// `task-phase-progress.ts`'s precedent directly beside it: the projector's job is
// to shape a queue's rows, and this is one field's resolution with its own rule
// about which record may answer. It also keeps the projector inside the 300-line
// bound `tests/lint/source-loc-budget.test.ts` holds every sidebar projector to.
//
// Separate from `task-phase-progress.ts` for the reason `run-degradation.ts` is
// separate from `run-planned-total.ts`: that resolution is arithmetic over a
// frozen plan with four sources and a rule about what `0 of 0` would wrongly
// imply; this is a list carried verbatim from one of two records. Filing them
// together would suggest the next person should look here for a denominator.

import type { DegradedPhaseEntry } from '../../contracts/snapshot-projections';
import type { FeatureRequest } from '../../queue/feature-request';
import type { WorkflowRun } from '../../state/workflow-run';

/** The one reading this resolution takes from outside the Task record. */
export interface TaskDegradationContext {
  /**
   * Source 2 — the marks the queue's live Run has accumulated so far. Answers for
   * exactly one row, the one `activeRunTaskId` names; any other row reading it
   * would be reporting a different task's degradation.
   *
   * Absent on a caller with no run wiring, and absent for a Run that degraded
   * nowhere — the same answer either way, since absence means not degraded.
   */
  readonly liveRunDegradedPhases?: readonly DegradedPhaseEntry[];
}

/**
 * Build the reading from the queue's own Run, for the snapshot composer to hand
 * over without knowing how a row uses it.
 *
 * Returns an object with **no key** for a Run that degraded nowhere, so the
 * context spreads clean rather than carrying an explicit `undefined` — the same
 * discipline `degradationPatch` applies on the write side, and for the same
 * reason: `exactOptionalPropertyTypes` distinguishes the two, and a spread of an
 * explicit `undefined` overwrites a same-named sibling.
 */
export function degradationContext(run: WorkflowRun | null): TaskDegradationContext {
  const degraded = run?.degradedPhases;
  return degraded === undefined || degraded.length === 0 ? {} : { liveRunDegradedPhases: degraded };
}

/**
 * FR-R3-157 (FR-011a, FR-011b, contract C4.10) — the phases one Task row carried
 * past their retry cap, from exactly two sources in this order:
 *
 *   1. The value captured onto the task when its Run reached a terminal status.
 *      It wins outright, including over a live Run that says something else: the
 *      capture is what this attempt did, while a Run still in the store is at
 *      best the same thing and at worst a later attempt's.
 *   2. The live Run's accumulated list — **only while the task is in flight**, so
 *      an operator watching a long run sees the mark at the moment the phase is
 *      let through rather than minutes later when the task ends.
 *
 * There is no third source and no fallback. Absence means NOT degraded, which is
 * an answer, so there is nothing left to guess at.
 *
 * **Why a terminal task never reads source 2.** Runs are held one per queue and
 * disposed when the next task starts, so whether a finished task's Run is still
 * in the store is a fact about queue timing rather than about the task. A row
 * that consulted it would read degraded while the Run survived and clean the
 * instant an unrelated task began — the disposal-dependent answer feature 198 was
 * raised to end, restated for this field (research.md D5).
 *
 * `isInFlight` is the projector's existing predicate, the queue's single routing
 * decision already computed once per row for `currentPhase` and `pauseCause`.
 * C4.10's "no status branch" is FR-002's prohibition on giving a status its own
 * ARITHMETIC, and none is given here: in both branches the value is a verbatim
 * list, never recomputed. This adds no branch the queue had not already made.
 */
export function resolveTaskDegradation(
  req: FeatureRequest,
  ctx: TaskDegradationContext & { readonly activeRunTaskId?: string | null },
  isInFlight: boolean
): { degradedPhases?: readonly DegradedPhaseEntry[] } {
  const captured = req.degradedPhases;
  if (captured !== undefined && captured.length > 0) return { degradedPhases: captured };
  if (!isInFlight || req.id !== ctx.activeRunTaskId) return {};
  const live = ctx.liveRunDegradedPhases;
  return live === undefined || live.length === 0 ? {} : { degradedPhases: live };
}
