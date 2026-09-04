// FR-R3-158 (T005, FR-003a) — the two pairing sites must agree, exactly.
//
// This file exists to fail if anyone ever pairs the count with a total a second
// time. Before this feature `projectRunProgress` was the only site that put the
// two numbers together; the feature adds a per-Task pair, and the way that goes
// wrong is not a bad formula but a second one — the same question answered twice
// and allowed to drift.
//
// So `projectRunProgress` is rewritten to obtain both numbers FROM
// `settledPhaseProgress` rather than to compute its own. This test pins that
// rewrite: it is not asserting that two independent implementations happen to
// match today, it is asserting there is one implementation. If a future change
// restores a private `countCompletedInPlan(run)` call inside the projector, the
// arithmetic would still agree here — so the cases below are deliberately the
// ones where an override set, a repeated phase, or a stale result makes two
// plausible-looking rules diverge.

import { describe, expect, it } from 'vitest';
import type { PhaseOutcome } from '../../../../src/controller/phase';
import { settledPhaseProgress } from '../../../../src/services/run-planned-total';
import type {
  PhaseOverride,
  PhaseResult,
  WorkflowRun
} from '../../../../src/state/workflow-run';
import { projectRunProgress } from '../../../../src/ui/sidebar/run-projector';

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

function override(phaseId: string): PhaseOverride {
  return { phaseId, action: 'disabled', setAt: 5, actor: 'operator' };
}

function makeRun(args: {
  readonly ids: readonly string[];
  readonly completed: readonly PhaseResult[];
  readonly overrides?: readonly PhaseOverride[];
  readonly withPlan?: boolean;
}): WorkflowRun {
  const overrides = args.overrides ?? [];
  const excluded = new Set(overrides.map((o) => o.phaseId));
  const phaseCount = args.ids.filter((id) => !excluded.has(id)).length;
  // Omit the pair of plan keys rather than setting them to `undefined`: under
  // `exactOptionalPropertyTypes` those are different states, and an absent plan
  // is the case this fixture exists to produce.
  const plan =
    args.withPlan === false
      ? {}
      : {
          pipeline: {
            id: 'agreement-plan',
            name: 'Agreement Plan',
            phases: args.ids.map((id) => ({ id, name: id, instruction: `${id} prompt.` }))
          },
          plannedTotal: { phaseCount, iterationCap: 10, maxPhaseInvocations: phaseCount }
        };
  return {
    id: 'run-agreement',
    featureId: '198-failed-task-phases-settled',
    featureDir: '/workspace/specs/198',
    status: 'running',
    currentPhase: args.ids[0] ?? '',
    currentIteration: 1,
    startedAt: 1,
    lastTransitionAt: 2,
    phasesCompleted: [...args.completed],
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

const IDS = ['a', 'b', 'c', 'd', 'e'] as const;

/** The cases where two plausible rules diverge, not the cases where any rule agrees. */
const DIVERGENCE_CASES: readonly { readonly name: string; readonly run: WorkflowRun }[] = [
  {
    name: 'a plain partial run',
    run: makeRun({ ids: IDS, completed: [result('a', 'clean'), result('b', 'clean')] })
  },
  {
    name: 'an override excluded from both sides',
    run: makeRun({
      ids: IDS,
      overrides: [override('d'), override('e')],
      completed: [result('a', 'clean'), result('d', 'skipped'), result('e', 'skipped')]
    })
  },
  {
    name: 'a phase that looped, recording one result per iteration',
    run: makeRun({
      ids: IDS,
      completed: [
        result('a', 'issues_remain', 1),
        result('a', 'issues_remain', 2),
        result('a', 'clean', 3)
      ]
    })
  },
  {
    name: 'a result naming a phase the frozen plan does not list',
    run: makeRun({
      ids: IDS,
      completed: [result('a', 'clean'), result('gone-from-the-plan', 'clean')]
    })
  },
  {
    name: 'a run that settled everything',
    run: makeRun({ ids: IDS, completed: IDS.map((id) => result(id, 'clean')) })
  },
  {
    name: 'a run that settled nothing',
    run: makeRun({ ids: IDS, completed: [result('a', 'failed')] })
  }
];

describe('FR-R3-158 (FR-003a) — one pairing rule, two call sites', () => {
  for (const { name, run } of DIVERGENCE_CASES) {
    it(`agrees with settledPhaseProgress for ${name}`, () => {
      const runProgress = projectRunProgress(run);
      const taskProgress = settledPhaseProgress(run);

      expect(runProgress).not.toBeNull();
      expect(taskProgress).not.toBeNull();
      expect({
        settled: runProgress!.phasesCompleted,
        total: runProgress!.phaseCount
      }).toEqual({ settled: taskProgress!.settled, total: taskProgress!.total });
    });
  }

  it('agrees on absence too — neither reports a figure for a run with no frozen plan', () => {
    // Both must answer "unknown" for the same input. A projector that returned a
    // zero pair here while the Task pair returned null would put a `0 of 0` on
    // one surface and nothing on the other, from one Run.
    const planless = makeRun({ ids: IDS, completed: [], withPlan: false });

    expect(projectRunProgress(planless)).toBeNull();
    expect(settledPhaseProgress(planless)).toBeNull();
  });

  it('keeps the four fields the Run projection carries beyond the pair', () => {
    // The rewrite changes where two numbers come from, not what the projection
    // is. `iterationCap` and `maxPhaseInvocations` are still read off the Run's
    // frozen total, and `percent` is still clamped once, here.
    const run = makeRun({ ids: IDS, completed: [result('a', 'clean')] });

    expect(projectRunProgress(run)).toEqual({
      phasesCompleted: 1,
      phaseCount: 5,
      iterationCap: 10,
      maxPhaseInvocations: 5,
      percent: 20
    });
  });
});
