// FR-R3-157 (T041) — everything a Task record captures off its Run at the moment
// the Run ends, and everything a retry has to drop again.
//
// WHY THIS MODULE EXISTS. Feature 198 established one captured field
// (`phaseProgress`) and this feature adds a second (`degradedPhases`). With one
// field the capture was a line in `QueueManager.finish()`; with two it is a
// concept, and the two halves have to stay in step in three separate ways that
// nothing else enforces:
//
//   1. Both must read the SAME Run. `finish()` resolves it by Task rather than by
//      queue, so a task finishing beside an in-flight sibling cannot be handed
//      that sibling's Run — and two independent lookups could in principle disagree
//      about a single instant. Here there is one parameter, so they cannot.
//   2. Both must be written in the SAME object literal as the terminal status, so
//      a reader never observes a row that has the status but not the evidence.
//      Spread-shaped patches make that one line instead of a branch.
//   3. Both must be CLEARED on retry, together. A stale pair reports a number the
//      new attempt has not reached; a stale mark accuses a run that is at this
//      moment working correctly. Forgetting one is silent, and the halves are
//      forty lines apart in the manager.
//
// It is a module rather than more lines in `queue-manager.ts` because the LOC
// gate refused the growth (`tests/lint/source-loc-budget.test.ts`) and was right
// to: the manager's subject is queue transitions, and this is a rule about which
// Run facts outlive their Run. Raising the file's mark would have bought two
// lines at the cost of the forcing function.
//
// The arithmetic and the list stay in their own modules — `run-planned-total.ts`
// computes over a frozen plan, `run-degradation.ts` carries a list verbatim.
// This only pairs them.
import type { FeatureRequest } from './feature-request';
import type {
  DegradedPhaseEntry,
  TaskPhaseProgressProjection
} from '../contracts/snapshot-projections';
import { degradationPatch } from '../services/run-degradation';
import { phaseProgressPatch } from '../services/run-planned-total';
import type { WorkflowRun } from '../state/workflow-run';

/**
 * What a terminating Run leaves behind on its Task row, as one spreadable patch.
 *
 * **A field the Run cannot answer for contributes no key** — not a zero, not an
 * empty list, and not a key whose value is `undefined`. Each half documents its
 * own reason (see `phaseProgressPatch` and `degradationPatch`); the shared one is
 * that a spread of an explicit `undefined` would overwrite a same-named field on
 * the record being patched, turning a missing capture into an erased one.
 *
 * `null` for the Run is ordinary, not an error: a task can reach a terminal
 * status with its Run already disposed, and then there is simply nothing to
 * capture.
 */
export function terminalCapture(run: WorkflowRun | null | undefined): TerminalCapture {
  return { ...phaseProgressPatch(run), ...degradationPatch(run) };
}

/**
 * Spelled out rather than derived from the two patch functions with indexed
 * access. `ReturnType<typeof phaseProgressPatch>['phaseProgress']` is
 * `TaskPhaseProgressProjection | undefined` — indexing an optional property adds
 * the `undefined` — so re-declaring it optional here produced `?: T | undefined`,
 * which is precisely the shape `exactOptionalPropertyTypes` exists to reject, and
 * the strictness ratchet caught it as a new diagnostic. Two named types cost two
 * imports and say the true thing.
 */
interface TerminalCapture {
  readonly phaseProgress?: TaskPhaseProgressProjection;
  readonly degradedPhases?: readonly DegradedPhaseEntry[];
}

/**
 * The same record with every captured field removed, for a task going back to
 * pending (FR-R3-158 FR-013, FR-R3-157 FR-013, contract C3.8).
 *
 * Removed, never emptied or zeroed: `[]` and `{ settled: 0, total: 0 }` read
 * identically to a correct reader but stamp the key onto the record for good,
 * after which the absent case cannot be tested and a pre-feature record no longer
 * re-persists byte-identical. Absence is the honest answer — the new attempt has
 * not run yet, so there is nothing known about it.
 */
export function withoutTerminalCapture(target: FeatureRequest): FeatureRequest {
  const { phaseProgress: _clearedProgress, degradedPhases: _clearedDegradation, ...retained } =
    target;
  return retained;
}
