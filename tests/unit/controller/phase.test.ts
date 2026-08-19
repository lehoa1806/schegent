import { describe, it, expect } from 'vitest';
import {
  transition,
  isLoopPhase,
  nextSuccessor,
  FORCE_CONTINUE_NOTIFY_TAG
} from '../../../src/controller/phase';
import { FIXTURE_PHASES } from '../../fixtures/process-catalog-fixture';

// Feature 098 (T080) — `lists the nine invocable phases` stood at the head of this
// describe. It asserted the contents of `INVOCABLE_PHASES`, which T038 deleted:
// there is no fixed set of Phase ids the host can invoke, because an operator's
// Phase id is data. The hardcoded successor chain below is the module's own
// no-pipeline fallback and is asserted as such, not as a vocabulary.
describe('Phase enum and transitions', () => {
  it('marks clarify, analyze, implement, and review as loop phases', () => {
    expect(isLoopPhase('speckit-clarify')).toBe(true);
    expect(isLoopPhase('speckit-analyze')).toBe(true);
    expect(isLoopPhase('speckit-implement')).toBe(true);
    expect(isLoopPhase('speckit-review')).toBe(true);
    expect(isLoopPhase('speckit-plan')).toBe(false);
    expect(isLoopPhase('speckit-checklist')).toBe(false);
  });

  it('walks the linear successor chain', () => {
    expect(nextSuccessor('speckit-specify')).toBe('speckit-clarify');
    expect(nextSuccessor('speckit-clarify')).toBe('speckit-plan');
    expect(nextSuccessor('speckit-plan')).toBe('speckit-tasks');
    expect(nextSuccessor('speckit-tasks')).toBe('speckit-checklist');
    expect(nextSuccessor('speckit-checklist')).toBe('speckit-analyze');
    expect(nextSuccessor('speckit-analyze')).toBe('speckit-implement');
    expect(nextSuccessor('speckit-implement')).toBe('speckit-review');
    expect(nextSuccessor('speckit-review')).toBe('finalize');
    expect(nextSuccessor('finalize')).toBe('done');
    expect(nextSuccessor('done')).toBe('done');
  });

  it('advances on clean outcome', () => {
    const result = transition({ phase: 'speckit-specify', outcome: 'clean', iteration: 1, iterationCap: 10 });
    expect(result.kind).toBe('advance');
    if (result.kind === 'advance') {
      expect(result.nextPhase).toBe('speckit-clarify');
      expect(result.nextIteration).toBe(1);
    }
  });

  it('loops clarify when issues remain and iteration < cap', () => {
    const result = transition({ phase: 'speckit-clarify', outcome: 'issues_remain', iteration: 2, iterationCap: 10 });
    expect(result.kind).toBe('loop');
    if (result.kind === 'loop') {
      expect(result.nextIteration).toBe(3);
    }
  });

  it('force-advances clarify at iteration cap with warning', () => {
    const result = transition({
      phase: 'speckit-clarify',
      outcome: 'issues_remain',
      iteration: 10,
      iterationCap: 10
    });
    expect(result.kind).toBe('advance');
    if (result.kind === 'advance') {
      expect(result.nextPhase).toBe('speckit-plan');
    }
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('halts with paused on rate_limited', () => {
    const result = transition({ phase: 'speckit-specify', outcome: 'rate_limited', iteration: 1, iterationCap: 10 });
    expect(result.kind).toBe('halt');
    if (result.kind === 'halt') {
      expect(result.status).toBe('paused');
    }
  });

  it('halts with failed on failed and timeout', () => {
    const failed = transition({ phase: 'speckit-plan', outcome: 'failed', iteration: 1, iterationCap: 10 });
    expect(failed.kind).toBe('halt');
    if (failed.kind === 'halt') expect(failed.status).toBe('failed');

    const timeout = transition({ phase: 'speckit-plan', outcome: 'timeout', iteration: 1, iterationCap: 10 });
    expect(timeout.kind).toBe('halt');
    if (timeout.kind === 'halt') expect(timeout.status).toBe('failed');
  });

  it.each(['failed', 'timeout'] as const)(
    'advances after a terminal %s outcome when the phase is explicitly optional',
    (outcome) => {
      const result = transition({
        phase: 'speckit-plan',
        outcome,
        iteration: 2,
        iterationCap: 10,
        phaseDef: { id: 'speckit-plan', isRequired: false }
      });

      expect(result.kind).toBe('advance');
      if (result.kind === 'advance') {
        expect(result.nextPhase).toBe('speckit-tasks');
      }
      expect(result.warnings).toEqual([
        `optional phase speckit-plan ${outcome}; continuing`
      ]);
    }
  );

  it.each([undefined, true] as const)(
    'keeps failed outcomes fail-stop when isRequired is %s',
    (isRequired) => {
      const result = transition({
        phase: 'speckit-plan',
        outcome: 'failed',
        iteration: 1,
        iterationCap: 10,
        phaseDef: {
          id: 'speckit-plan',
          ...(isRequired === undefined ? {} : { isRequired })
        }
      });

      expect(result.kind).toBe('halt');
      if (result.kind === 'halt') expect(result.status).toBe('failed');
    }
  );

  it.each(['rate_limited', 'transient_error'] as const)(
    'does not bypass retry policy for optional %s outcomes',
    (outcome) => {
      const result = transition({
        phase: 'speckit-plan',
        outcome,
        iteration: 1,
        iterationCap: 10,
        phaseDef: { id: 'speckit-plan', isRequired: false }
      });

      expect(result.kind).toBe('halt');
      if (result.kind === 'halt') expect(result.status).toBe('paused');
    }
  );

  it('advances skipped phases without treating them as failed', () => {
    const result = transition({
      phase: 'speckit-plan',
      outcome: 'skipped',
      iteration: 1,
      iterationCap: 10
    });

    expect(result.kind).toBe('advance');
    if (result.kind === 'advance') {
      expect(result.nextPhase).toBe('speckit-tasks');
    }
  });

  it('issues_remain on a non-loop phase advances normally', () => {
    const result = transition({ phase: 'speckit-plan', outcome: 'issues_remain', iteration: 1, iterationCap: 10 });
    expect(result.kind).toBe('advance');
  });

  describe('catalog-driven dispatch', () => {
    // Feature 098 (T080) — the pipeline under test was assembled from
    // `BUILT_IN_PIPELINE.phases` resolved against `BUILT_IN_PHASES`, so the
    // successor assertions read as facts about the speckit sequence when what
    // they establish is that `nextSuccessor` walks whatever sequence it is
    // handed. The fixture rows carry ids the product does not recognise, which is
    // the point: the walk cannot be coming from anywhere but the argument.
    const pipeline = { phases: FIXTURE_PHASES };
    const [first, second, third] = FIXTURE_PHASES;
    const last = FIXTURE_PHASES[FIXTURE_PHASES.length - 1];

    it('nextSuccessor walks the pipeline it is given', () => {
      expect(nextSuccessor(first.id, pipeline)).toBe(second.id);
      expect(nextSuccessor(second.id, pipeline)).toBe(third.id);
      expect(nextSuccessor(last.id, pipeline)).toBe('done');
      expect(nextSuccessor('done', pipeline)).toBe('done');
      // The hardcoded fallback chain does not leak in: `speckit-specify` is not a
      // member of this pipeline, so it terminates rather than advancing to
      // `speckit-clarify`.
      expect(nextSuccessor('speckit-specify', pipeline)).toBe('done');
    });

    it('nextSuccessor returns done for unknown phase id within a pipeline', () => {
      expect(nextSuccessor('not-a-phase', pipeline)).toBe('done');
    });

    it('isLoopPhase consults the PhaseDef.retryCondition when supplied', () => {
      expect(isLoopPhase('foo', { id: 'foo', retryCondition: 'open_questions > 0' })).toBe(true);
      expect(isLoopPhase('foo', { id: 'foo', retryCondition: undefined })).toBe(false);
    });
  });

  describe('retryCondition truth table (010, T023, US2)', () => {
    const PHASE_DEF = {
      id: 'security-audit',
      retryCondition: 'open_questions > 0'
    };

    it('clean + truthy expression loops (overrides CLEAR) — FR-010', () => {
      const result = transition({
        phase: 'security-audit',
        outcome: 'clean',
        iteration: 1,
        iterationCap: 5,
        phaseDef: PHASE_DEF,
        metrics: { open_questions: 2 }
      });
      expect(result.kind).toBe('loop');
      if (result.kind === 'loop') {
        expect(result.nextIteration).toBe(2);
      }
    });

    it('open_questions + falsy expression advances — FR-010', () => {
      const result = transition({
        phase: 'security-audit',
        outcome: 'issues_remain',
        iteration: 1,
        iterationCap: 5,
        phaseDef: PHASE_DEF,
        metrics: { open_questions: 0 }
      });
      expect(result.kind).toBe('advance');
    });

    it('cap reached + truthy expression halts failed with cause cap_exhausted — FR-010, SC-009', () => {
      const result = transition({
        phase: 'security-audit',
        outcome: 'clean',
        iteration: 5,
        iterationCap: 5,
        phaseDef: PHASE_DEF,
        metrics: { open_questions: 3 }
      });
      expect(result.kind).toBe('halt');
      if (result.kind === 'halt') {
        expect(result.status).toBe('failed');
        expect(result.cause).toBe('cap_exhausted');
      }
    });

    describe('forceContinueOnRetryCap', () => {
      // The escape hatch is scoped to cap exhaustion and nothing else: a phase
      // whose retryCondition never went falsy advances instead of halting, and
      // says so under a notification tag. It is NOT a way past a `failed` or
      // `timeout` outcome — those are terminal before the cap is ever read.
      const CAP_EXHAUSTED = {
        phase: 'security-audit',
        outcome: 'clean',
        iteration: 5,
        iterationCap: 5,
        metrics: { open_questions: 3 }
      } as const;

      it('advances past the cap and tags the warning when the phase opts in', () => {
        const result = transition({
          ...CAP_EXHAUSTED,
          phaseDef: { ...PHASE_DEF, forceContinueOnRetryCap: true }
        });

        expect(result.kind).toBe('advance');
        if (result.kind !== 'advance') return;
        expect(result.nextPhase).toBe(nextSuccessor('security-audit', undefined));
        expect(result.warnings.some((w) => w.startsWith(FORCE_CONTINUE_NOTIFY_TAG))).toBe(true);
        expect(result.warnings.join(' ')).toContain('UNVERIFIED');
      });

      it('advances when only the workspace default opts in', () => {
        const result = transition({
          ...CAP_EXHAUSTED,
          phaseDef: PHASE_DEF,
          forceContinueOnRetryCapDefault: true
        });

        expect(result.kind).toBe('advance');
      });

      it('lets an explicit phase `false` override a workspace default of true', () => {
        const result = transition({
          ...CAP_EXHAUSTED,
          phaseDef: { ...PHASE_DEF, forceContinueOnRetryCap: false },
          forceContinueOnRetryCapDefault: true
        });

        expect(result.kind).toBe('halt');
        if (result.kind === 'halt') expect(result.cause).toBe('cap_exhausted');
      });

      it('still halts a terminal outcome — the hatch never reaches the cap branch', () => {
        const result = transition({
          ...CAP_EXHAUSTED,
          outcome: 'failed',
          phaseDef: { ...PHASE_DEF, forceContinueOnRetryCap: true },
          forceContinueOnRetryCapDefault: true
        });

        expect(result.kind).toBe('halt');
        if (result.kind !== 'halt') return;
        expect(result.status).toBe('failed');
        expect(result.warnings.some((w) => w.startsWith(FORCE_CONTINUE_NOTIFY_TAG))).toBe(false);
      });

      it('defaults off — an unset field with no default keeps the halt', () => {
        const result = transition({ ...CAP_EXHAUSTED, phaseDef: PHASE_DEF });

        expect(result.kind).toBe('halt');
        if (result.kind === 'halt') expect(result.cause).toBe('cap_exhausted');
      });
    });

    it('failed outcome bypasses retryCondition (FR-010)', () => {
      const result = transition({
        phase: 'security-audit',
        outcome: 'failed',
        iteration: 2,
        iterationCap: 5,
        phaseDef: PHASE_DEF,
        metrics: { open_questions: 9 }
      });
      expect(result.kind).toBe('halt');
      if (result.kind === 'halt') {
        expect(result.status).toBe('failed');
        expect(result.cause).toBeUndefined();
      }
    });

    it('clean + falsy expression advances normally', () => {
      const result = transition({
        phase: 'security-audit',
        outcome: 'clean',
        iteration: 1,
        iterationCap: 5,
        phaseDef: PHASE_DEF,
        metrics: { open_questions: 0 }
      });
      expect(result.kind).toBe('advance');
    });
  });
});
