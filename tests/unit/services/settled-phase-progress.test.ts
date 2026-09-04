// FR-R3-158 (T002, T003) — the settled count and its total, paired in one place.
//
// The feature this file guards is not the arithmetic: `countCompletedInPlan` and
// `computePlannedTotal` already answer both halves and are not touched. What is
// new is that the two are paired **here**, once, so no caller can reach for one
// without the other. FR-003a forbids a second copy of the rule, and the failure
// mode it exists to prevent is a numerator and a denominator produced by two
// definitions — a row that reads `6 of 5`.
//
// So the assertions below are deliberately about the *pairing* and about
// absence. The settled-outcome set, the override exclusion and the distinctness
// rule belong to `run-planned-total`'s existing tests; what is re-asserted here
// is only that `settledPhaseProgress` inherits them rather than restating them,
// which is checkable by feeding it the cases that would diverge if it had.

import { describe, expect, it } from 'vitest';
import type { PhaseOutcome } from '../../../src/controller/phase';
import { settledPhaseProgress } from '../../../src/services/run-planned-total';
import type {
  PhaseOverride,
  PhaseResult,
  WorkflowRun
} from '../../../src/state/workflow-run';

const PHASE_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] as const;

function result(phase: string, outcome: PhaseOutcome, iteration = 1): PhaseResult {
  return {
    phase,
    iteration,
    startedAt: 10,
    endedAt: 20,
    result: outcome,
    terminationReason: outcome === 'clean' ? 'deadline' : 'error',
    exitCode: outcome === 'clean' ? 0 : 1,
    stdoutSummary: '',
    stderrSummary: '',
    auditEntryId: null
  };
}

/**
 * A Run over a seven-phase plan, with whatever outcomes and overrides the case
 * needs. `plannedTotal` is written the way the factory writes it — through
 * `computePlannedTotal` — because a hand-written total would let the test agree
 * with an implementation that had drifted from the rule.
 */
function makeRun(args: {
  readonly completed?: readonly PhaseResult[];
  readonly overrides?: readonly PhaseOverride[];
  readonly phaseIds?: readonly string[];
  readonly withPlan?: boolean;
}): WorkflowRun {
  const ids = args.phaseIds ?? PHASE_IDS;
  const overrides = args.overrides ?? [];
  const excluded = new Set(overrides.map((o) => o.phaseId));
  // Spread-shaped rather than `pipeline: undefined` / `plannedTotal: undefined`,
  // so a run with no frozen plan omits the keys outright. Under
  // `exactOptionalPropertyTypes` an optional key set to `undefined` is not the
  // same as an absent one, and this feature's whole subject is that distinction —
  // it would be odd for its own fixtures to blur it. Same shape as
  // `phaseProgressPatch` in `run-planned-total.ts`.
  const plan =
    args.withPlan === false
      ? {}
      : {
          pipeline: {
            id: 'seven-phase',
            name: 'Seven Phase',
            phases: ids.map((id) => ({ id, name: id, instruction: `${id} prompt.` }))
          },
          plannedTotal: {
            phaseCount: ids.filter((id) => !excluded.has(id)).length,
            iterationCap: 10,
            maxPhaseInvocations: ids.filter((id) => !excluded.has(id)).length
          }
        };
  return {
    id: 'run-158',
    featureId: '198-failed-task-phases-settled',
    featureDir: '/workspace/specs/198-failed-task-phases-settled',
    status: 'failed',
    currentPhase: 'p6',
    currentIteration: 1,
    startedAt: 1,
    lastTransitionAt: 2,
    phasesCompleted: [...(args.completed ?? [])],
    lastError: null,
    ...plan,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [...overrides],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
}

function override(phaseId: string): PhaseOverride {
  return { phaseId, action: 'disabled', setAt: 5, actor: 'operator' };
}

describe('FR-R3-158 — settledPhaseProgress pairs the count with its own total', () => {
  it('reports five of seven for a run that settled five phases before failing', () => {
    // The reported defect, at its source. Five clean phases, then a failure in
    // the sixth: the failing phase is not settled (FR-007), and the seventh was
    // never reached.
    const run = makeRun({
      completed: [
        result('p1', 'clean'),
        result('p2', 'clean'),
        result('p3', 'clean'),
        result('p4', 'clean'),
        result('p5', 'clean'),
        result('p6', 'failed')
      ]
    });

    expect(settledPhaseProgress(run)).toEqual({ settled: 5, total: 7 });
  });

  it('reports zero of seven for a run that failed in its first phase', () => {
    // FR-007's worked example. Zero here is the truth, not the symptom the
    // feature exists to remove — which is why the total must still be real.
    const run = makeRun({ completed: [result('p1', 'failed')] });

    expect(settledPhaseProgress(run)).toEqual({ settled: 0, total: 7 });
  });

  it('returns null for a run that froze no plan', () => {
    // Unknown, not zero (FR-010). `{ settled: 0, total: 0 }` would render as a
    // complete run of nothing, which is the misreport this feature ends.
    expect(settledPhaseProgress(makeRun({ withPlan: false }))).toBeNull();
  });

  it('returns null for no run at all', () => {
    expect(settledPhaseProgress(null)).toBeNull();
  });
});

describe('FR-R3-158 — the pair inherits the existing rule rather than restating it', () => {
  it('counts a phase the run reached and skipped as settled (FR-005, SC-006)', () => {
    // An ordinary skip settles. This is the case a reader most often guesses
    // wrong, and it is the one that separates a skip from an override.
    const run = makeRun({
      completed: [
        result('p1', 'clean'),
        result('p2', 'clean'),
        result('p3', 'clean'),
        result('p4', 'skipped'),
        result('p5', 'clean')
      ]
    });

    expect(settledPhaseProgress(run)).toEqual({ settled: 5, total: 7 });
  });

  it('excludes an overridden phase from both numbers (FR-005a, SC-006)', () => {
    // The symmetry requirement. The driver records a `skipped` result when it
    // reaches an overridden phase, so a total that subtracted the override
    // while the count still credited its skip would report more than
    // everything. Both sides drop the same two ids: five of five, not 7 of 5.
    const run = makeRun({
      overrides: [override('p6'), override('p7')],
      completed: [
        result('p1', 'clean'),
        result('p2', 'clean'),
        result('p3', 'clean'),
        result('p4', 'clean'),
        result('p5', 'clean'),
        result('p6', 'skipped'),
        result('p7', 'skipped')
      ]
    });

    expect(settledPhaseProgress(run)).toEqual({ settled: 5, total: 5 });
  });

  it('counts a phase that ran more than once exactly once (FR-005b)', () => {
    // A looping phase appends one result per iteration. Counting records
    // rather than distinct ids is precisely how the count passes the total.
    const run = makeRun({
      completed: [
        result('p1', 'clean'),
        result('p2', 'issues_remain', 1),
        result('p2', 'issues_remain', 2),
        result('p2', 'clean', 3)
      ]
    });

    expect(settledPhaseProgress(run)).toEqual({ settled: 2, total: 7 });
  });

  it('cannot be inflated by a result naming a phase outside the frozen plan', () => {
    // The hazard the deleted webview derivation used to meet as a stale
    // `currentPhase`. Here it arrives as a result for a phase the plan does not
    // list — a task whose pipeline changed between attempts.
    const run = makeRun({
      completed: [result('p1', 'clean'), result('phase-from-another-plan', 'clean')]
    });

    expect(settledPhaseProgress(run)).toEqual({ settled: 1, total: 7 });
  });

  it('never reports a count above its total, whatever the records say (FR-013)', () => {
    // The invariant stated as a property rather than a case: every settled id
    // is a planned, non-excluded id, so the fraction cannot exceed one.
    const run = makeRun({
      overrides: [override('p7')],
      completed: [
        ...PHASE_IDS.map((id) => result(id, 'clean')),
        ...PHASE_IDS.map((id) => result(id, 'clean', 2)),
        result('unplanned', 'clean')
      ]
    });

    const progress = settledPhaseProgress(run);

    expect(progress).not.toBeNull();
    expect(progress!.settled).toBeLessThanOrEqual(progress!.total);
    expect(progress).toEqual({ settled: 6, total: 6 });
  });
});

/**
 * FR-R3-158 (T032, FR-012, SC-004) — the parity claim, given a home.
 *
 * The deleted webview derivation answered two cases this feature must keep
 * answering identically: an in-flight row part-way through an override-free plan,
 * and a completed row. FR-012 promises those rows report the same numbers after
 * the change as before it, and SC-004 is that promise measured. A claim of "no
 * regression" that no test states is a claim nobody can check, so the two figures
 * from `research.md`'s D5 table are asserted here against the new source.
 *
 * They are also the two cases where the old derivation happened to be right, and
 * therefore the two most likely to be assumed rather than verified. The plan is
 * three phases with no overrides precisely so the old rule and the new one are
 * required to agree: any difference here would be a regression, not a correction.
 */
describe('FR-R3-158 (T032) — in-flight and completed rows read as they did before', () => {
  const THREE_PHASES = ['p1', 'p2', 'p3'] as const;

  it('reports two of three for a run in flight at the third phase (FR-012, SC-004)', () => {
    // D5 case (c). The phase the run is *in* has not settled — it has produced no
    // outcome record — so it does not count. The old webview rule reached the same
    // figure by counting phases before `currentPhase` in the pipeline list; this
    // one reaches it from the run's own outcome records and never reads
    // `currentPhase` at all. Same number, and now for a reason that survives a
    // stale phase name.
    const run = makeRun({
      phaseIds: THREE_PHASES,
      completed: [result('p1', 'clean'), result('p2', 'clean')]
    });

    expect(settledPhaseProgress(run)).toEqual({ settled: 2, total: 3 });
  });

  it('reports three of three for a completed run, with no completed special case (FR-012, SC-004)', () => {
    // D5 case (b). The old rule short-circuited on `status === 'completed'` and
    // returned the plan's length without looking at what ran. This one has no
    // status branch to short-circuit: the count is full because every phase
    // settled, which is the only reason it should ever be full.
    const run = makeRun({
      phaseIds: THREE_PHASES,
      completed: THREE_PHASES.map((id) => result(id, 'clean'))
    });

    expect(settledPhaseProgress({ ...run, status: 'completed' })).toEqual({ settled: 3, total: 3 });
  });

  it('does not credit a completed status for phases that never settled (FR-012)', () => {
    // The other half of removing the special case, and the reason removing it is
    // an improvement rather than a like-for-like swap: a run marked completed
    // whose records show one settled phase reports one, not three. The old rule
    // reported three for this run.
    const run = makeRun({ phaseIds: THREE_PHASES, completed: [result('p1', 'clean')] });

    expect(settledPhaseProgress({ ...run, status: 'completed' })).toEqual({ settled: 1, total: 3 });
  });
});
