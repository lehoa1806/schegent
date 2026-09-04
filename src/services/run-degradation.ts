// FR-R3-157 (T033) — a Run's degraded marks, as a patch a Task record can be
// written with.
//
// WHY IT IS A SEPARATE MODULE FROM `run-planned-total.ts`. It could have been a
// third export there, beside `plannedTotalPatch` and `phaseProgressPatch`, and the
// shape is deliberately identical to theirs. It is not, because that module's
// subject is arithmetic over a frozen plan — `countCompletedInPlan`,
// `computePlannedTotal`, `excludedPhaseIds` — and this is a list carried verbatim.
// Putting them together would suggest the two are computed the same way, and the
// next person to change one would look for a denominator here that does not exist.
//
// The capture is the whole point. Runs are held one per queue and disposed when
// the next task starts, so a mark that lives only on the Run reads blank on every
// finished row in production while passing every unit test that keeps the Run
// alive. That is the defect feature 198 was raised to fix, restated for this
// field, and it is contract C4.
import type { DegradedPhaseEntry } from '../contracts/snapshot-projections';
import type { WorkflowRun } from '../state/workflow-run';

/**
 * The spreadable patch recording a Run's degraded phases onto the Task record,
 * for use in the *same* object literal that writes the terminal status.
 *
 * Spread-shaped on `phaseProgressPatch`'s precedent
 * (`src/services/run-planned-total.ts`), and for the same reason: the two cases
 * the call site faces become one line rather than a branch.
 *
 * **A run that degraded nowhere gets no key** — not an empty list, and not a key
 * whose value is `undefined`. All three read as "not degraded" to a correct
 * reader (`snapshot-projections.ts` says so of the first two), so the choice is
 * not about reader semantics. It is about what gets written: an empty list on
 * every clean task puts the key on every record the product has ever stored, from
 * which point the absent case cannot be tested and a pre-feature record no longer
 * re-persists byte-identical. The second is worse — a spread of an explicit
 * `undefined` overwrites a sibling of the same name at the call site.
 *
 * Both the no-Run and the empty-list cases are ordinary, not errors: a task can
 * reach a terminal status with its Run already disposed, and most tasks finish
 * having degraded nothing.
 */
export function degradationPatch(
  run: WorkflowRun | null | undefined
): { degradedPhases?: readonly DegradedPhaseEntry[] } {
  const degraded = run?.degradedPhases;
  return degraded === undefined || degraded.length === 0 ? {} : { degradedPhases: degraded };
}
