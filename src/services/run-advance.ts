// FR-R3-157 (T028) — the Run a completed phase transitions into.
//
// WHY IT IS A MODULE. This was thirty lines inside `RunDriver.drive()`, and
// `tests/lint/drive-loop-loc-budget.test.ts` holds that method to a shrink-only
// target with no raise path: "extract another arm and lower the number in the same
// change". Adding the degraded append inline would have grown both `drive()` and
// the file past their gates, and the only permitted response to that is extraction
// (plan.md risk table). So the arm moved, whole, rather than the numbers moving.
//
// It is also the right seam on its own terms. Every line here answers one question
// — *given a phase that just ended and the decision about where the Run goes next,
// what is the next persisted Run?* — and it answers it as a pure function of its
// inputs, which is what makes the one-write guarantee below testable at all.
import type { TransitionResult } from '../controller/phase';
import type { PhaseResult, WorkflowRun } from '../state/workflow-run';

export interface AdvanceInputs {
  /** The Run as last persisted, before this phase's result is folded in. */
  readonly run: WorkflowRun;
  /** Where the sequencer decided the Run goes next. */
  readonly decision: TransitionResult;
  /** The result of the phase that just ended. */
  readonly phaseResult: PhaseResult;
  /**
   * An optional phase ended `failed` or `timeout` and the Run advances anyway.
   * Clears the delayed-retry fields: the failure was tolerated, so nothing is
   * owed a retry.
   */
  readonly optionalTerminalContinued: boolean;
  /**
   * The next phase runs on a different backend. Drops the captured CLI session,
   * which is scoped to the backend that created it and means nothing to another.
   */
  readonly crossesRunnerBoundary: boolean;
  /** The transition's timestamp, passed in so this stays a pure function. */
  readonly now: number;
}

/**
 * Fold one completed phase and its transition decision into the next Run.
 *
 * The returned Run is what a single `persistTransition` call writes. That
 * single-write property is contract C3.3 and it is load-bearing: `phasesCompleted`
 * and `degradedPhases` describe the same event, and a Run persisted with one but
 * not the other is a Run whose phase ended with its degradation unrecorded —
 * indistinguishable from a clean phase to every later reader, which is exactly what
 * FR-006 forbids. Both appends therefore happen here, in one object, and there is
 * no second write for a crash or a lost fence to land between.
 */
export function advancedRun(inputs: AdvanceInputs): WorkflowRun {
  const { run, decision, phaseResult, optionalTerminalContinued, crossesRunnerBoundary, now } =
    inputs;
  return {
    ...run,
    currentPhase: decision.kind === 'advance' ? decision.nextPhase : run.currentPhase,
    currentIteration:
      decision.kind === 'advance' || decision.kind === 'loop'
        ? decision.nextIteration
        : run.currentIteration,
    lastTransitionAt: now,
    phasesCompleted: [...run.phasesCompleted, phaseResult],
    // FR-R3-157 (C3.3) — appended, never replaced: the list is the record of
    // every phase this Run carried past its cap, in the order they happened, and
    // a later degradation must not displace an earlier one. Absent when nothing
    // degraded, which is how a reader tells "not degraded" from "degraded here".
    ...(decision.kind === 'advance' && decision.degraded !== undefined
      ? { degradedPhases: [...(run.degradedPhases ?? []), decision.degraded] }
      : {}),
    ...(optionalTerminalContinued
      ? {
          delayedRetryCount: 0,
          pendingRetryAt: null,
          pendingRetryCause: null
        }
      : {}),
    ...(crossesRunnerBoundary
      ? {
          lastCliSessionId: undefined,
          lastCliSessionRunnerKind: undefined
        }
      : {})
  };
}
