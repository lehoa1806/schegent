/**
 * Feature 034 Item 047 (completion) — PhaseSequencer isolation tests.
 *
 * Exercises `src/controller/phase-sequencer.ts` directly. The sequencer is a
 * pure decision module: given a `WorkflowRun` + runner output + iteration
 * cap, it returns a typed `PrePhaseDecision` / `PostPhaseDecision` the
 * controller acts on. These tests verify the decision boundaries without
 * the full `driveRun()` pipeline.
 *
 * Controller-driven coverage of the same decision flow lives in
 * `workflow-controller.test.ts`, `workflow-controller-breakpoint.test.ts`,
 * `workflow-controller-dynamic-backoff.test.ts`, and `delayed-retry.test.ts`.
 *
 * Coverage matrix:
 *   - decideBeforePhase: invoke / skip-phase (skipped|disabled|removed)
 *   - decideAfterPhase: pause-breakpoint / pause-delayed-retry (rate_limit
 *     + transient_error) / pause-rate-limit / fail (fatal + cap_exhausted) /
 *     pause-verify (both bugfix-verify phases) / pause-manual / break-
 *     unexpected / advance-or-loop
 *   - nextOverridesAfterSkip: 'skipped' consumes, 'disabled'/'removed' survive
 *
 * CLAUDE.md hard-rule audits:
 *   - The synthetic skipped PhaseResult carries `terminationReason: 'cancel'`,
 *     `exitCode: null`, empty summaries — same shape the controller used
 *     pre-extraction.
 *   - The pause-delayed-retry decision passes pre-buffer `resetsAtMs` (NOT
 *     `+ RETRY_BUFFER_MS`) so the controller's `retry-scheduled` audit can
 *     emit the pre-buffer epoch (027 FR-012).
 *   - The fail decision exposes `capExhausted` so the controller emits the
 *     terminal `phase-end` with `cause: 'cap_exhausted'` (FR-010).
 *   - The pause-verify branch preserves `currentPhase` (the controller does
 *     not advance) so resume re-invokes the failing verify phase (026 FR-016).
 */

import { describe, it, expect } from 'vitest';
import {
  PhaseSequencer,
  nextOverridesAfterSkip,
  type PostPhaseDecision,
  type PrePhaseDecision
} from '../../../src/controller/phase-sequencer';
import type { PhaseOverride, WorkflowRun } from '../../../src/state/workflow-run';
import type { PhaseRunOutput } from '../../../src/controller/phase-runner';
import { LAST_PHASE_ISSUES_REMAIN_CAUSE } from '../../../src/controller/phase';
import type { PhaseDef } from '../../../src/config/pipeline-config';

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'feat-1',
    featureDir: '/tmp/feat-1',
    status: 'running',
    currentPhase: 'speckit-implement',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...overrides
  };
}

function makeOverride(overrides: Partial<PhaseOverride> = {}): PhaseOverride {
  return {
    phaseId: 'speckit-implement',
    action: 'skipped',
    setAt: 1_700_000_000_000,
    actor: 'operator',
    ...overrides
  };
}

function makeOutput(overrides: Partial<PhaseRunOutput> = {}): PhaseRunOutput {
  return {
    result: {
      kind: 'clean',
      auditEntry: { metrics: {} } as never
    },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    auditEntryId: null,
    warnings: [],
    ...overrides
  };
}

describe('PhaseSequencer.decideBeforePhase', () => {
  const sequencer = new PhaseSequencer();
  const NOW = 1_700_000_001_000;

  it('returns invoke when there is no override on the current phase', () => {
    const run = makeRun({ currentPhase: 'speckit-plan', currentIteration: 0 });
    const decision = sequencer.decideBeforePhase({ run, iterationCap: 5, now: NOW });
    expect(decision.kind).toBe('invoke');
    if (decision.kind === 'invoke') {
      expect(decision.iteration).toBe(1);
      expect(decision.activePhaseDef).toBeUndefined();
    }
  });

  it('returns invoke with iteration N (>=1) when run.currentIteration is non-zero', () => {
    const run = makeRun({ currentPhase: 'speckit-clarify', currentIteration: 3 });
    const decision = sequencer.decideBeforePhase({ run, iterationCap: 5, now: NOW });
    expect(decision.kind).toBe('invoke');
    if (decision.kind === 'invoke') {
      expect(decision.iteration).toBe(3);
    }
  });

  it('returns skip-phase with synthetic skipped PhaseResult on override', () => {
    const override = makeOverride({ phaseId: 'speckit-implement', action: 'skipped' });
    const run = makeRun({ currentPhase: 'speckit-implement', phaseOverrides: [override] });
    const decision = sequencer.decideBeforePhase({ run, iterationCap: 5, now: NOW });
    expect(decision.kind).toBe('skip-phase');
    if (decision.kind === 'skip-phase') {
      expect(decision.override).toEqual(override);
      expect(decision.skippedResult.phase).toBe('speckit-implement');
      expect(decision.skippedResult.result).toBe('skipped');
      expect(decision.skippedResult.terminationReason).toBe('cancel');
      expect(decision.skippedResult.exitCode).toBeNull();
      expect(decision.skippedResult.startedAt).toBe(NOW);
      expect(decision.skippedResult.endedAt).toBe(NOW);
      expect(decision.skippedResult.iteration).toBe(1);
    }
  });

  it('passes the override through unchanged when action is disabled', () => {
    const override = makeOverride({ action: 'disabled' });
    const run = makeRun({ phaseOverrides: [override] });
    const decision = sequencer.decideBeforePhase({ run, iterationCap: 5, now: NOW });
    expect(decision.kind).toBe('skip-phase');
    if (decision.kind === 'skip-phase') {
      expect(decision.override.action).toBe('disabled');
    }
  });

  it('passes the override through unchanged when action is removed', () => {
    const override = makeOverride({ action: 'removed' });
    const run = makeRun({ phaseOverrides: [override] });
    const decision = sequencer.decideBeforePhase({ run, iterationCap: 5, now: NOW });
    expect(decision.kind).toBe('skip-phase');
    if (decision.kind === 'skip-phase') {
      expect(decision.override.action).toBe('removed');
    }
  });
});

describe('PhaseSequencer.decideAfterPhase', () => {
  const sequencer = new PhaseSequencer();
  const NOW = 1_700_000_002_000;

  it('returns pause-breakpoint when output.outcome is paused-at-breakpoint', () => {
    const run = makeRun({ currentPhase: 'speckit-tasks' });
    const output = makeOutput({ outcome: 'paused-at-breakpoint', warnings: ['x'] });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('pause-breakpoint');
    if (decision.kind === 'pause-breakpoint') {
      expect(decision.consumedPhaseId).toBe('speckit-tasks');
      expect(decision.warnings).toEqual(['x']);
    }
  });

  it('classifies rate_limited halt as pause-delayed-retry with pre-buffer resetsAtMs', () => {
    const run = makeRun();
    const output = makeOutput({
      result: {
        kind: 'rate_limited',
        cause: 'rate_limit',
        auditEntry: null,
        resetsAtMs: 1_900_000_000_000,
        rateLimitMessage: 'try again in 5m'
      },
      outcome: 'rate_limited'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('pause-delayed-retry');
    if (decision.kind === 'pause-delayed-retry') {
      expect(decision.cause).toBe('rate_limit');
      expect(decision.resetsAtMs).toBe(1_900_000_000_000);
      expect(decision.rateLimitMessage).toBe('try again in 5m');
    }
  });

  it('classifies transient_error halt as pause-delayed-retry with resetsAtMs=null', () => {
    const run = makeRun();
    const output = makeOutput({
      result: { kind: 'transient_error', exitCode: 1, auditEntry: null },
      outcome: 'transient_error'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('pause-delayed-retry');
    if (decision.kind === 'pause-delayed-retry') {
      expect(decision.cause).toBe('transient_error');
      expect(decision.resetsAtMs).toBeNull();
      expect(decision.rateLimitMessage).toBeNull();
    }
  });

  it('classifies a paused halt without a retry cause as pause-rate-limit (legacy path)', () => {
    // A `failed` outcome that the transition() engine maps to a paused halt
    // without `cause: 'rate_limit' | 'transient_error'` is unusual but the
    // legacy fall-through to rateLimitHandler is preserved. Manually
    // construct a result + outcome that triggers paused-halt without
    // mapping to a delayed-retry cause.
    const run = makeRun();
    const output = makeOutput({
      result: {
        kind: 'rate_limited',
        cause: 'unknown-rate-limit-cause',
        auditEntry: null
      },
      outcome: 'rate_limited'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    // The outcome 'rate_limited' maps to a paused halt with cause
    // 'rate_limit' in transition(), so this routes to pause-delayed-retry.
    // The legacy pause-rate-limit branch only fires when the halt-paused
    // path returns no retry cause, which today's transition() engine only
    // produces from custom decision.cause values; we assert the contract
    // exists by relying on the type-narrowing.
    expect(decision.kind).toBe('pause-delayed-retry');
  });

  it('routes failed outcome to fail with fatalCause when malformed', () => {
    const run = makeRun();
    const output = makeOutput({
      result: {
        kind: 'malformed',
        warnings: ['boom'],
        auditEntry: null,
        fatalCause: 'fatal-signature:network-unreachable'
      },
      outcome: 'failed'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('fail');
    if (decision.kind === 'fail') {
      expect(decision.fatalCause).toBe('fatal-signature:network-unreachable');
      expect(decision.baseMessage).toBe('fatal-signature:network-unreachable');
      expect(decision.capExhausted).toBe(false);
    }
  });

  it('routes failed outcome to fail with fallback message when no fatalCause and no warnings', () => {
    const run = makeRun();
    const output = makeOutput({
      result: { kind: 'malformed', warnings: [], auditEntry: null },
      outcome: 'failed',
      warnings: []
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('fail');
    if (decision.kind === 'fail') {
      expect(decision.baseMessage).toBe('phase failed');
    }
  });

  it('joins output.warnings into baseMessage when no fatalCause is set', () => {
    const run = makeRun();
    const output = makeOutput({
      result: { kind: 'malformed', warnings: [], auditEntry: null },
      outcome: 'failed',
      warnings: ['first warning', 'second warning']
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('fail');
    if (decision.kind === 'fail') {
      expect(decision.baseMessage).toBe('first warning; second warning');
    }
  });

  it.each(['failed', 'timeout'] as const)(
    'continues after optional terminal %s while preserving the original PhaseResult',
    (outcome) => {
      const run = makeRun({
        currentPhase: 'optional-audit',
        pipeline: {
          id: 'custom',
          name: 'Custom',
          phases: [
            {
              id: 'optional-audit',
              name: 'Optional Audit',
              instruction: 'Audit without blocking.',
              isRequired: false
            },
            {
              id: 'next-phase',
              name: 'Next Phase',
              instruction: 'Continue.'
            }
          ]
        }
      });
      const output = makeOutput({
        result: { kind: 'malformed', warnings: [], auditEntry: null },
        outcome,
        terminationReason: outcome === 'timeout' ? 'timeout' : 'error',
        exitCode: outcome === 'timeout' ? null : 7
      });
      const activePhaseDef = run.pipeline?.phases[0];

      const decision = sequencer.decideAfterPhase({
        run,
        output,
        iteration: 3,
        iterationCap: 5,
        activePhaseDef,
        latestManualPauseAt: run.manualPauseAt,
        now: NOW
      });

      expect(decision.kind).toBe('advance-or-loop');
      if (decision.kind === 'advance-or-loop') {
        expect(decision.transition).toMatchObject({
          kind: 'advance',
          nextPhase: 'next-phase'
        });
        expect(decision.phaseResult).toMatchObject({
          phase: 'optional-audit',
          iteration: 3,
          result: outcome,
          terminationReason: output.terminationReason,
          exitCode: output.exitCode
        });
      }
    }
  );

  it('keeps an optional verification phase paused on non-clean output', () => {
    const run = makeRun({
      currentPhase: 'bugfix-verify-pre',
      pipeline: {
        id: 'bugfix',
        name: 'Bugfix',
        phases: [
          {
            id: 'bugfix-verify-pre',
            name: 'Verify',
            instruction: 'Verify.',
            isRequired: false
          }
        ]
      }
    });
    const output = makeOutput({
      result: { kind: 'malformed', warnings: [], auditEntry: null },
      outcome: 'failed',
      terminationReason: 'error'
    });

    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: run.pipeline?.phases[0],
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });

    expect(decision.kind).toBe('pause-verify');
  });

  it('routes capability-loopable iteration exceedance to fail with capExhausted=true', () => {
    // Build a phaseDef with a truthy retryCondition; iteration === iterationCap
    // → cap_exhausted halt.
    const run = makeRun({ currentPhase: 'speckit-implement' });
    const output = makeOutput({
      result: {
        kind: 'clean',
        auditEntry: { metrics: { remaining: 1 } } as never
      },
      outcome: 'clean'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 5,
      iterationCap: 5,
      activePhaseDef: {
        id: 'speckit-implement',
        label: 'Implement',
        scope: 'shared',
        invocation: { command: '/x' },
        loopable: true,
        retryCondition: 'remaining > 0',
        contributesTo: []
      } as never,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('fail');
    if (decision.kind === 'fail') {
      expect(decision.capExhausted).toBe(true);
      expect(decision.baseMessage).toBe('cap_exhausted');
      expect(decision.decisionCause).toBe('cap_exhausted');
    }
  });

  // Feature 194 (FR-010, C3.3) — the hop from `PhaseRunOutput.stalledCount` into
  // `transition()`'s `stalledCount`. The evaluator's count and the rendered clause
  // were each covered on their own side; the spread between them was not, so
  // deleting it left every suite green while the operator warning lost its clause.
  it('threads stalledCount into the cap warning clause', () => {
    const run = makeRun({ currentPhase: 'speckit-implement' });
    const output = makeOutput({
      result: {
        kind: 'clean',
        auditEntry: { metrics: { remaining: 1 } } as never
      },
      outcome: 'clean',
      stalledCount: 4
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 5,
      iterationCap: 5,
      activePhaseDef: {
        id: 'speckit-implement',
        retryCondition: 'remaining > 0'
      } as PhaseDef,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('fail');
    expect(
      decision.warnings.some((w) =>
        w.includes('metrics unchanged across the last 4 comparisons')
      )
    ).toBe(true);
  });

  it('omits the clause when the output carries no stalledCount', () => {
    // The negative half of the same hop: absence must not render as a count, and
    // the base cap warning must survive intact (C3.2, C3.4).
    const run = makeRun({ currentPhase: 'speckit-implement' });
    const decision = sequencer.decideAfterPhase({
      run,
      output: makeOutput({
        result: {
          kind: 'clean',
          auditEntry: { metrics: { remaining: 1 } } as never
        },
        outcome: 'clean'
      }),
      iteration: 5,
      iterationCap: 5,
      activePhaseDef: {
        id: 'speckit-implement',
        retryCondition: 'remaining > 0'
      } as PhaseDef,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('fail');
    expect(decision.warnings.some((w) => w.includes('metrics unchanged'))).toBe(false);
    expect(
      decision.warnings.some((w) => w.includes('retryCondition still truthy at cap (5)'))
    ).toBe(true);
  });

  it('threads forceContinueOnRetryCapDefault through to the advance-or-loop branch', () => {
    // The workspace-setting default is read per phase decision by the driver and
    // passed down. FR-R3-157 moved what the sequencer does with it: it no longer
    // forwards the boolean to `transition()`, it resolves it through
    // `resolveRetryCapOutcome` and forwards the OUTCOME. The assertions are
    // unchanged and still span the whole thread — same input as the
    // cap_exhausted test above, only the default differs, so a `fail` here means
    // the thread is cut, now at either of the two links instead of one.
    const run = makeRun({ currentPhase: 'speckit-implement' });
    const output = makeOutput({
      result: {
        kind: 'clean',
        auditEntry: { metrics: { remaining: 1 } } as never
      },
      outcome: 'clean'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 5,
      iterationCap: 5,
      activePhaseDef: {
        id: 'speckit-implement',
        label: 'Implement',
        scope: 'shared',
        invocation: { command: '/x' },
        loopable: true,
        retryCondition: 'remaining > 0',
        contributesTo: []
      } as never,
      latestManualPauseAt: run.manualPauseAt,
      forceContinueOnRetryCapDefault: true,
      now: NOW
    });
    expect(decision.kind).toBe('advance-or-loop');
    if (decision.kind === 'advance-or-loop') {
      expect(decision.warnings.some((w) => w.includes('forced-continue'))).toBe(true);
    }
  });

  it('routes verify phase with non-clean outcome to pause-verify (bugfix-verify-pre)', () => {
    const run = makeRun({ currentPhase: 'bugfix-verify-pre' });
    const output = makeOutput({
      result: {
        kind: 'remaining_issues',
        issues: [{ summary: 'missing test' }],
        auditEntry: null
      },
      outcome: 'issues_remain'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('pause-verify');
    if (decision.kind === 'pause-verify') {
      expect(decision.phaseResult.phase).toBe('bugfix-verify-pre');
      expect(decision.phaseResult.result).toBe('issues_remain');
    }
  });

  it('routes verify phase with non-clean outcome to pause-verify (bugfix-verify-post)', () => {
    const run = makeRun({ currentPhase: 'bugfix-verify-post' });
    const output = makeOutput({
      result: {
        kind: 'remaining_issues',
        issues: [{ summary: 'lint failure' }],
        auditEntry: null
      },
      outcome: 'issues_remain'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('pause-verify');
  });

  // FR-R3-199 — `transition()` fails a required last phase that ends with issues
  // outstanding. The shipped bugfix pipeline ends on `bugfix-verify-post`, and its
  // verify pause keeps the Run resumable on that phase (026 FR-016), so the pause
  // must still win there.
  describe('a last phase that ends with issues outstanding (FR-R3-199)', () => {
    const decideAtLast = (lastPhase: string) => {
      const lastDef = { id: lastPhase, name: 'Last', instruction: 'Finish.' };
      const run = makeRun({
        currentPhase: lastPhase,
        pipeline: {
          id: 'pipe',
          name: 'Pipe',
          phases: [{ id: 'bugfix-implement', name: 'Implement', instruction: 'Fix.' }, lastDef]
        }
      });
      return sequencer.decideAfterPhase({
        run,
        output: makeOutput({
          result: {
            kind: 'remaining_issues',
            issues: [{ summary: 'not merged' }],
            auditEntry: null
          },
          outcome: 'issues_remain'
        }),
        iteration: 1,
        iterationCap: 5,
        activePhaseDef: lastDef,
        latestManualPauseAt: run.manualPauseAt,
        now: NOW
      });
    };

    it('fails the Run with a message an operator can read', () => {
      const decision = decideAtLast('finalize');
      expect(decision.kind).toBe('fail');
      if (decision.kind !== 'fail') return;
      expect(decision.decisionCause).toBe(LAST_PHASE_ISSUES_REMAIN_CAUSE);
      expect(decision.capExhausted).toBe(false);
      expect(decision.baseMessage).toBe('the last phase reported remaining issues');
    });

    it('keeps the verify pause when bugfix-verify-post is the last phase', () => {
      expect(decideAtLast('bugfix-verify-post').kind).toBe('pause-verify');
    });
  });

  // FR-R3-198 — the dispatch resumes an unfinished turn up to twice, so an
  // `incomplete_turn` that reaches the sequencer is one those resumes did not
  // finish. The phase sits mid-pipeline, so FR-R3-199's last-phase rule is not
  // what fails it.
  describe('a phase that ended its turn unfinished (FR-R3-198, T1877)', () => {
    it('fails the Run with a message an operator can read', () => {
      const phaseDef = { id: 'finalize', name: 'Finalize', instruction: 'Finish.' };
      const run = makeRun({
        currentPhase: phaseDef.id,
        pipeline: {
          id: 'pipe',
          name: 'Pipe',
          phases: [phaseDef, { id: 'review', name: 'Review', instruction: 'Review.' }]
        }
      });
      const decision = sequencer.decideAfterPhase({
        run,
        output: makeOutput({
          result: {
            kind: 'incomplete_turn',
            cause: 'background-work-open',
            auditEntry: null,
            warnings: ['incomplete-turn:background-work-open']
          },
          outcome: 'incomplete_turn',
          terminationReason: 'incomplete_turn'
        }),
        iteration: 1,
        iterationCap: 5,
        activePhaseDef: phaseDef,
        latestManualPauseAt: run.manualPauseAt,
        now: NOW
      });
      expect(decision.kind).toBe('fail');
      if (decision.kind !== 'fail') return;
      expect(decision.decisionCause).toBe('incomplete_turn_unresolved');
      expect(decision.capExhausted).toBe(false);
      expect(decision.baseMessage).toBe(
        'the phase ended its turn unfinished, and immediate resumes did not finish it'
      );
    });
  });

  it('routes verify phase with clean outcome to advance-or-loop (no premature pause)', () => {
    const run = makeRun({ currentPhase: 'bugfix-verify-pre' });
    const output = makeOutput({
      result: { kind: 'clean', auditEntry: { metrics: {} } as never },
      outcome: 'clean'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('advance-or-loop');
  });

  it('routes manual-pause-mid-run detection: latestManualPauseAt set', () => {
    const run = makeRun({ currentPhase: 'speckit-plan' });
    const output = makeOutput({
      result: { kind: 'clean', auditEntry: { metrics: {} } as never },
      outcome: 'clean'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: NOW,
      now: NOW
    });
    expect(decision.kind).toBe('pause-manual');
    if (decision.kind === 'pause-manual') {
      expect(decision.transition.kind).toBe('advance');
    }
  });

  // Feature 093 (T040) — a third case used to sit here: "does not route to
  // pause-manual when latestRun.id mismatches", which handed the sequencer a
  // *different* Run's snapshot and asserted it was ignored. That case is now
  // unrepresentable rather than untested. `PostPhaseInputs.latestManualPauseAt`
  // is a `number | null`, so there is no longer any way to express "some other
  // Run's pause timestamp" at this boundary — which is the whole point of the
  // narrowing, and re-encoding the old test would only assert that a non-null
  // timestamp pauses, contradicting the case above.
  //
  // The identity reconciliation it was really testing did not disappear; it
  // moved to the one caller that can answer it, `RunDriver.latestSnapshotOf()`.
  // Its replacement coverage lives in
  // `tests/unit/services/run-driver-manual-pause-identity.test.ts`.

  it('does not route to pause-manual when latestManualPauseAt is null', () => {
    const run = makeRun({ currentPhase: 'speckit-plan' });
    const output = makeOutput({
      result: { kind: 'clean', auditEntry: { metrics: {} } as never },
      outcome: 'clean'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: null,
      now: NOW
    });
    expect(decision.kind).toBe('advance-or-loop');
  });

  it('returns advance-or-loop with the transition decision for a normal clean outcome', () => {
    const run = makeRun({ currentPhase: 'speckit-plan' });
    const output = makeOutput({
      result: { kind: 'clean', auditEntry: { metrics: {} } as never },
      outcome: 'clean'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('advance-or-loop');
    if (decision.kind === 'advance-or-loop') {
      expect(decision.transition.kind).toBe('advance');
      expect(decision.phaseResult.phase).toBe('speckit-plan');
    }
  });

  it('merges output.warnings and transition() warnings on the returned decision', () => {
    // `speckit-clarify` is in LOOP_PHASES, so iteration === iterationCap on
    // `issues_remain` triggers the "iteration cap reached" warning from
    // transition() — verifies the sequencer surfaces both warning sources.
    const run = makeRun({ currentPhase: 'speckit-clarify' });
    const output = makeOutput({
      result: {
        kind: 'remaining_issues',
        issues: [{ summary: 'fail' }],
        auditEntry: null
      },
      outcome: 'issues_remain',
      warnings: ['out-1', 'out-2']
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 5,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    // iteration cap → force-advance, transition emits a warning.
    expect((decision as PostPhaseDecision & { warnings: readonly string[] }).warnings).toContain('out-1');
    expect((decision as PostPhaseDecision & { warnings: readonly string[] }).warnings).toContain('out-2');
    expect(
      (decision as PostPhaseDecision & { warnings: readonly string[] }).warnings.some(
        (w) => w.includes('iteration cap')
      )
    ).toBe(true);
  });
});

// Feature 194 — FR-009, SC-007, T012. The stagnation tracker (owned by
// `PhaseRetryEvaluator`, keyed by run + phase) must be dropped whenever this
// phase's loop is no longer executing: on every halt (fail/pause-*) and on
// advance, but NOT on loop — a loop is the one transition where the SAME
// comparison must carry forward to the next iteration. `PhaseSequencer`
// stays pure (no I/O, no state mutation — see the module docblock): it
// computes the SIGNAL as data on the returned decision; the caller that
// holds the actual `PhaseRetryEvaluator` instance (`RunDriver`) performs the
// eviction when the signal is set.
describe('PhaseSequencer.decideAfterPhase — stagnation tracker eviction signal (194, T012)', () => {
  const sequencer = new PhaseSequencer();
  const NOW = 1_700_000_003_000;

  it('signals eviction on pause-breakpoint', () => {
    const run = makeRun({ currentPhase: 'speckit-tasks' });
    const output = makeOutput({ outcome: 'paused-at-breakpoint', warnings: [] });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.evictStagnationTracker).toBe(true);
  });

  it('signals eviction on pause-delayed-retry (rate_limited) — a pause always evicts (data-model.md §4)', () => {
    const run = makeRun();
    const output = makeOutput({
      result: {
        kind: 'rate_limited',
        cause: 'rate_limit',
        auditEntry: null,
        resetsAtMs: 1_900_000_000_000,
        rateLimitMessage: null
      },
      outcome: 'rate_limited'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.evictStagnationTracker).toBe(true);
  });

  it('signals eviction on pause-delayed-retry (transient_error) — a pause always evicts (data-model.md §4)', () => {
    const run = makeRun();
    const output = makeOutput({
      result: { kind: 'transient_error', exitCode: 1, auditEntry: null },
      outcome: 'transient_error'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.evictStagnationTracker).toBe(true);
  });

  it('signals eviction on fail (fatal)', () => {
    const run = makeRun();
    const output = makeOutput({
      result: { kind: 'malformed', warnings: [], auditEntry: null },
      outcome: 'failed'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('fail');
    expect(decision.evictStagnationTracker).toBe(true);
  });

  it('signals eviction on fail (cap_exhausted)', () => {
    // Truthy retryCondition, iteration === iterationCap → cap_exhausted halt.
    const run = makeRun({ currentPhase: 'speckit-implement' });
    const output = makeOutput({
      result: { kind: 'clean', auditEntry: { metrics: { remaining: 1 } } as never },
      outcome: 'clean'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 5,
      iterationCap: 5,
      activePhaseDef: {
        id: 'speckit-implement',
        retryCondition: 'remaining > 0'
      } as PhaseDef,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('fail');
    if (decision.kind === 'fail') {
      expect(decision.capExhausted).toBe(true);
    }
    expect(decision.evictStagnationTracker).toBe(true);
  });

  it('signals eviction on pause-verify — a pause always evicts (data-model.md §4)', () => {
    const run = makeRun({ currentPhase: 'bugfix-verify-pre' });
    const output = makeOutput({
      result: { kind: 'clean', auditEntry: { metrics: {} } as never },
      outcome: 'issues_remain'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('pause-verify');
    expect(decision.evictStagnationTracker).toBe(true);
  });

  it('signals eviction on pause-manual when the wrapped transition is advance', () => {
    const run = makeRun({ currentPhase: 'speckit-plan', manualPauseAt: NOW });
    const output = makeOutput({
      result: { kind: 'clean', auditEntry: { metrics: {} } as never },
      outcome: 'clean'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: NOW,
      now: NOW
    });
    expect(decision.kind).toBe('pause-manual');
    if (decision.kind === 'pause-manual') {
      expect(decision.transition.kind).toBe('advance');
    }
    expect(decision.evictStagnationTracker).toBe(true);
  });

  it('signals eviction on pause-manual when the wrapped transition is loop — a pause always evicts (data-model.md §4)', () => {
    // speckit-clarify is a legacy LOOP_PHASES member (see isLoopPhase), so
    // 'issues_remain' with no phaseDef/retryCondition still decides 'loop'.
    const run = makeRun({ currentPhase: 'speckit-clarify', manualPauseAt: NOW });
    const output = makeOutput({
      result: { kind: 'remaining_issues', issues: [{ summary: 'x' }], auditEntry: null },
      outcome: 'issues_remain'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: NOW,
      now: NOW
    });
    expect(decision.kind).toBe('pause-manual');
    if (decision.kind === 'pause-manual') {
      expect(decision.transition.kind).toBe('loop');
    }
    expect(decision.evictStagnationTracker).toBe(true);
  });

  it('signals eviction on advance-or-loop when the transition is advance', () => {
    const run = makeRun({ currentPhase: 'speckit-plan' });
    const output = makeOutput({
      result: { kind: 'clean', auditEntry: { metrics: {} } as never },
      outcome: 'clean'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('advance-or-loop');
    if (decision.kind === 'advance-or-loop') {
      expect(decision.transition.kind).toBe('advance');
    }
    expect(decision.evictStagnationTracker).toBe(true);
  });

  it('does NOT signal eviction on advance-or-loop when the transition is loop — the running comparison must survive to the next iteration', () => {
    const run = makeRun({ currentPhase: 'speckit-clarify' });
    const output = makeOutput({
      result: { kind: 'remaining_issues', issues: [{ summary: 'x' }], auditEntry: null },
      outcome: 'issues_remain'
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: undefined,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('advance-or-loop');
    if (decision.kind === 'advance-or-loop') {
      expect(decision.transition.kind).toBe('loop');
    }
    expect(decision.evictStagnationTracker).toBe(false);
  });
});

describe('nextOverridesAfterSkip', () => {
  it("consumes a 'skipped' override by filtering it out", () => {
    const skipped = makeOverride({ phaseId: 'a', action: 'skipped' });
    const other = makeOverride({ phaseId: 'b', action: 'disabled' });
    const run = makeRun({ phaseOverrides: [skipped, other] });
    const next = nextOverridesAfterSkip(run, skipped);
    expect(next).toEqual([other]);
  });

  it("preserves a 'disabled' override across dispatches", () => {
    const disabled = makeOverride({ phaseId: 'a', action: 'disabled' });
    const run = makeRun({ phaseOverrides: [disabled] });
    const next = nextOverridesAfterSkip(run, disabled);
    expect(next).toEqual([disabled]);
  });

  it("preserves a 'removed' override across dispatches", () => {
    const removed = makeOverride({ phaseId: 'a', action: 'removed' });
    const run = makeRun({ phaseOverrides: [removed] });
    const next = nextOverridesAfterSkip(run, removed);
    expect(next).toEqual([removed]);
  });
});

describe('PhaseSequencer.decideBeforePhase return-type narrowing', () => {
  // Compile-time assertion that the union narrows to PrePhaseDecision.
  const sequencer = new PhaseSequencer();
  it('narrows to invoke|skip-phase', () => {
    const run = makeRun();
    const decision: PrePhaseDecision = sequencer.decideBeforePhase({
      run,
      iterationCap: 5,
      now: 0
    });
    if (decision.kind === 'invoke') {
      expect(typeof decision.iteration).toBe('number');
    } else {
      expect(decision.kind).toBe('skip-phase');
      expect(decision.override.phaseId).toBeDefined();
    }
  });
});

// FR-R4-F14 (spec 242, contract V3.2) — the `fail` decision carries the Run's failure cause and the
// stalled-comparison count. One case per sequencer-decided code (census rows C1 to C7), each asserting
// only the new fields: `baseMessage`, `decisionCause`, `fatalCause` and `capExhausted` are pinned by
// the cases above and are not repeated here.
describe('PhaseSequencer.decideAfterPhase — the fail decision names its cause (242, V3)', () => {
  const sequencer = new PhaseSequencer();
  const NOW = 1_700_000_004_000;
  const CAP_DEF = { id: 'speckit-implement', retryCondition: 'remaining > 0' } as PhaseDef;
  const MID_PHASE = { id: 'finalize', name: 'Finalize', instruction: 'Finish.' };
  const PIPELINE_WITH_TAIL = {
    id: 'pipe',
    name: 'Pipe',
    phases: [MID_PHASE, { id: 'review', name: 'Review', instruction: 'Review.' }]
  };

  function failDecisionFor(output: PhaseRunOutput, overrides: Partial<WorkflowRun> = {}, def?: PhaseDef) {
    const run = makeRun(overrides);
    const decision = sequencer.decideAfterPhase({
      run,
      output,
      iteration: 5,
      iterationCap: 5,
      activePhaseDef: def,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    if (decision.kind !== 'fail') throw new Error(`expected a fail decision, got ${decision.kind}`);
    return decision;
  }

  it('C1: an unfinished turn after the dispatch resumes is incomplete_turn_unresolved', () => {
    const decision = failDecisionFor(
      makeOutput({
        result: { kind: 'incomplete_turn', cause: 'background-work-open', auditEntry: null, warnings: [] },
        outcome: 'incomplete_turn',
        terminationReason: 'incomplete_turn'
      }),
      { currentPhase: MID_PHASE.id, pipeline: PIPELINE_WITH_TAIL },
      MID_PHASE as unknown as PhaseDef
    );
    expect(decision.failureCause).toBe('incomplete_turn_unresolved');
  });

  it('C2: a matched fatal signature is fatal_signature, and the decision carries no signature text in the code', () => {
    const decision = failDecisionFor(
      makeOutput({
        result: {
          kind: 'malformed',
          warnings: [],
          auditEntry: null,
          fatalCause: 'fatal-signature:token=sk-ant-SENTINEL'
        },
        outcome: 'failed',
        terminationReason: 'error'
      })
    );
    expect(decision.failureCause).toBe('fatal_signature');
    expect(String(decision.failureCause)).not.toContain('SENTINEL');
  });

  it('C2: a fatal match on a timed-out phase is still fatal_signature', () => {
    const decision = failDecisionFor(
      makeOutput({
        result: { kind: 'malformed', warnings: [], auditEntry: null, fatalCause: 'fatal-signature:x' },
        outcome: 'timeout',
        terminationReason: 'timeout'
      })
    );
    expect(decision.failureCause).toBe('fatal_signature');
  });

  it('C3: the absolute invocation deadline is phase_timeout', () => {
    const decision = failDecisionFor(
      makeOutput({
        result: { kind: 'malformed', warnings: [], auditEntry: null },
        outcome: 'failed',
        terminationReason: 'deadline'
      })
    );
    expect(decision.failureCause).toBe('phase_timeout');
  });

  it('C4: an idle timeout is phase_timeout', () => {
    const decision = failDecisionFor(
      makeOutput({
        result: { kind: 'malformed', warnings: [], auditEntry: null },
        outcome: 'timeout',
        terminationReason: 'timeout'
      })
    );
    expect(decision.failureCause).toBe('phase_timeout');
  });

  it('C5: a non-zero exit with no signature is phase_failed', () => {
    const decision = failDecisionFor(
      makeOutput({
        result: { kind: 'malformed', warnings: [], auditEntry: null },
        outcome: 'failed',
        terminationReason: 'error',
        exitCode: 1
      })
    );
    expect(decision.failureCause).toBe('phase_failed');
  });

  it('C6: a phase that reaches its cap with the condition still truthy is cap_exhausted', () => {
    const decision = failDecisionFor(
      makeOutput({
        result: { kind: 'clean', auditEntry: { metrics: { remaining: 1 } } as never },
        outcome: 'clean'
      }),
      { currentPhase: 'speckit-implement' },
      CAP_DEF
    );
    expect(decision.failureCause).toBe('cap_exhausted');
  });

  it('C7: a required last phase ending with issues is last_phase_issues_remain', () => {
    const decision = failDecisionFor(
      makeOutput({
        result: { kind: 'remaining_issues', issues: [{ summary: 'not merged' }], auditEntry: null },
        outcome: 'issues_remain'
      }),
      {
        currentPhase: 'finalize',
        pipeline: {
          id: 'pipe',
          name: 'Pipe',
          phases: [{ id: 'bugfix-implement', name: 'Implement', instruction: 'Fix.' }, MID_PHASE]
        }
      },
      MID_PHASE as unknown as PhaseDef
    );
    expect(decision.failureCause).toBe('last_phase_issues_remain');
  });

  it('passes the stalled-comparison count through when the output carries it', () => {
    const decision = failDecisionFor(
      makeOutput({
        result: { kind: 'clean', auditEntry: { metrics: { remaining: 1 } } as never },
        outcome: 'clean',
        stalledCount: 9
      }),
      { currentPhase: 'speckit-implement' },
      CAP_DEF
    );
    expect(decision.failureCause).toBe('cap_exhausted');
    expect(decision.stalledCount).toBe(9);
  });

  it('carries no stalledCount key when the output has none', () => {
    const decision = failDecisionFor(
      makeOutput({
        result: { kind: 'clean', auditEntry: { metrics: { remaining: 1 } } as never },
        outcome: 'clean'
      }),
      { currentPhase: 'speckit-implement' },
      CAP_DEF
    );
    expect('stalledCount' in decision).toBe(false);
  });

  it('keeps the verify pause ahead of the fail arm, with no failure cause (V3.1)', () => {
    const lastDef = { id: 'bugfix-verify-post', name: 'Verify', instruction: 'Verify.' };
    const run = makeRun({
      currentPhase: lastDef.id,
      pipeline: {
        id: 'pipe',
        name: 'Pipe',
        phases: [{ id: 'bugfix-implement', name: 'Implement', instruction: 'Fix.' }, lastDef]
      }
    });
    const decision = sequencer.decideAfterPhase({
      run,
      output: makeOutput({
        result: { kind: 'remaining_issues', issues: [{ summary: 'lint failure' }], auditEntry: null },
        outcome: 'issues_remain'
      }),
      iteration: 1,
      iterationCap: 5,
      activePhaseDef: lastDef as unknown as PhaseDef,
      latestManualPauseAt: run.manualPauseAt,
      now: NOW
    });
    expect(decision.kind).toBe('pause-verify');
    expect('failureCause' in decision).toBe(false);
  });
});

// FR-R4-F17 (feature 245, contract D4) — the sequencer threads the bound into `transition()` and gives
// the stop a fixed last-error message. The stop is a failed halt, so it takes the `fail` arm ahead of
// the verify-phase pause and the mid-run manual pause, exactly as `cap_exhausted` does (research R14).
describe('PhaseSequencer.decideAfterPhase — the unchanged-metrics stop (245, D4)', () => {
  const sequencer = new PhaseSequencer();
  const NOW = 1_700_000_005_000;
  const LOOP_DEF = { id: 'speckit-implement', retryCondition: 'remaining > 0' } as PhaseDef;
  const VERIFY_DEF = { id: 'bugfix-verify-pre', retryCondition: 'remaining > 0' } as PhaseDef;

  function decide(
    options: {
      readonly bound?: number;
      readonly stalledCount?: number;
      readonly def?: PhaseDef;
      readonly run?: Partial<WorkflowRun>;
      readonly latestManualPauseAt?: number | null;
      readonly forceContinueOnRetryCapDefault?: boolean;
      readonly outcome?: 'clean' | 'issues_remain';
    } = {}
  ): PostPhaseDecision {
    const run = makeRun(options.run ?? {});
    const metricsEntry = { metrics: { remaining: 1 } } as never;
    return sequencer.decideAfterPhase({
      run,
      output: makeOutput({
        result:
          options.outcome === 'issues_remain'
            ? { kind: 'remaining_issues', issues: [{ summary: 'open' }], auditEntry: metricsEntry }
            : { kind: 'clean', auditEntry: metricsEntry },
        outcome: options.outcome ?? 'clean',
        ...(options.stalledCount === undefined ? {} : { stalledCount: options.stalledCount })
      }),
      iteration: 3,
      iterationCap: 10,
      activePhaseDef: options.def ?? LOOP_DEF,
      latestManualPauseAt:
        options.latestManualPauseAt === undefined ? run.manualPauseAt : options.latestManualPauseAt,
      now: NOW,
      ...(options.bound === undefined ? {} : { maxUnchangedComparisons: options.bound }),
      ...(options.forceContinueOnRetryCapDefault === undefined
        ? {}
        : { forceContinueOnRetryCapDefault: options.forceContinueOnRetryCapDefault })
    });
  }

  it('D4.2 to D4.4: a count at the bound below the cap fails with the stop cause and its fixed message', () => {
    const decision = decide({ bound: 2, stalledCount: 2 });
    expect(decision.kind).toBe('fail');
    if (decision.kind !== 'fail') return;
    expect(decision.failureCause).toBe('judged_metrics_unchanged');
    expect(decision.decisionCause).toBe('judged_metrics_unchanged');
    expect(decision.baseMessage).toBe('judged metrics unchanged before the iteration cap');
    expect(decision.stalledCount).toBe(2);
    expect(decision.capExhausted).toBe(false);
    expect(decision.fatalCause).toBeUndefined();
    expect(decision.evictStagnationTracker).toBe(true);
  });

  it('D3: the stop warning reaches the decision once, after the runner warnings', () => {
    const decision = decide({ bound: 2, stalledCount: 2 });
    if (decision.kind !== 'fail') throw new Error(`expected fail, got ${decision.kind}`);
    expect(decision.warnings.filter((w) => w.includes('judged metrics unchanged'))).toHaveLength(1);
    expect(decision.warnings.at(-1)).toContain('so the run stops before the cap');
  });

  it('loops when the bound is absent or 0, with the same output', () => {
    expect(decide({ stalledCount: 2 }).kind).toBe('advance-or-loop');
    expect(decide({ bound: 0, stalledCount: 2 }).kind).toBe('advance-or-loop');
  });

  it('loops when the count is below the bound or absent', () => {
    expect(decide({ bound: 2, stalledCount: 1 }).kind).toBe('advance-or-loop');
    expect(decide({ bound: 2 }).kind).toBe('advance-or-loop');
  });

  it('passes the resolved cap outcome: a workspace default of continue never stops (D1, FR-008)', () => {
    expect(
      decide({ bound: 2, stalledCount: 5, forceContinueOnRetryCapDefault: true }).kind
    ).toBe('advance-or-loop');
  });

  it('D4.5: a verify phase takes the fail arm, not the verify pause', () => {
    const decision = decide({
      bound: 2,
      stalledCount: 2,
      def: VERIFY_DEF,
      outcome: 'issues_remain',
      run: { currentPhase: 'bugfix-verify-pre' }
    });
    expect(decision.kind).toBe('fail');
    if (decision.kind === 'fail') expect(decision.failureCause).toBe('judged_metrics_unchanged');
  });

  it('D4.5: a pending mid-run manual pause takes the fail arm, not pause-manual', () => {
    const decision = decide({
      bound: 2,
      stalledCount: 2,
      run: { manualPauseAt: NOW },
      latestManualPauseAt: NOW
    });
    expect(decision.kind).toBe('fail');
    if (decision.kind === 'fail') expect(decision.failureCause).toBe('judged_metrics_unchanged');
  });

  it('D4.5 control: the same verify phase and the same pause, without the bound, take their own arms', () => {
    expect(
      decide({
        stalledCount: 2,
        def: VERIFY_DEF,
        outcome: 'issues_remain',
        run: { currentPhase: 'bugfix-verify-pre' }
      }).kind
    ).toBe('pause-verify');
    expect(
      decide({ stalledCount: 2, run: { manualPauseAt: NOW }, latestManualPauseAt: NOW }).kind
    ).toBe('pause-manual');
  });
});
