import { describe, it, expect } from 'vitest';
import { transition, isLoopPhase, nextSuccessor, INVOCABLE_PHASES } from '../../../src/controller/phase';
import { BUILT_IN_PIPELINE, BUILT_IN_PHASES } from '../../../src/config/pipeline-config';

describe('Phase enum and transitions', () => {
  it('lists the seven invocable phases', () => {
    expect(INVOCABLE_PHASES).toEqual([
      'speckit-specify',
      'speckit-clarify',
      'speckit-plan',
      'speckit-tasks',
      'speckit-analyze',
      'speckit-implement',
      'finalize'
    ]);
  });

  it('marks clarify and analyze as loop phases', () => {
    expect(isLoopPhase('speckit-clarify')).toBe(true);
    expect(isLoopPhase('speckit-analyze')).toBe(true);
    expect(isLoopPhase('speckit-plan')).toBe(false);
  });

  it('walks the linear successor chain', () => {
    expect(nextSuccessor('speckit-specify')).toBe('speckit-clarify');
    expect(nextSuccessor('speckit-clarify')).toBe('speckit-plan');
    expect(nextSuccessor('speckit-plan')).toBe('speckit-tasks');
    expect(nextSuccessor('speckit-tasks')).toBe('speckit-analyze');
    expect(nextSuccessor('speckit-analyze')).toBe('speckit-implement');
    expect(nextSuccessor('speckit-implement')).toBe('finalize');
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
    const pipeline = {
      phases: BUILT_IN_PIPELINE.phases.map(
        (id) =>
          BUILT_IN_PHASES.find((p) => p.id === id) ?? {
            id,
            name: id,
            instruction: '',
            loopable: false
          }
      )
    };

    it('nextSuccessor walks the built-in pipeline when provided', () => {
      expect(nextSuccessor('speckit-specify', pipeline)).toBe('speckit-clarify');
      expect(nextSuccessor('speckit-clarify', pipeline)).toBe('speckit-plan');
      expect(nextSuccessor('speckit-analyze', pipeline)).toBe('speckit-implement');
      expect(nextSuccessor('finalize', pipeline)).toBe('done');
      expect(nextSuccessor('done', pipeline)).toBe('done');
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
