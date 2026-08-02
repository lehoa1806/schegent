import { describe, expect, it } from 'vitest';
import { projectPhasePrecedence } from '../../../src/config/phase-precedence';
import type { PhaseDef } from '../../../src/config/pipeline-config';

function phase(id: string, fields: Partial<PhaseDef> = {}): PhaseDef {
  return Object.freeze({ id, name: id, instruction: 'noop', ...fields });
}

describe('projectPhasePrecedence', () => {
  it('returns a frozen structured-clone-safe object', () => {
    const out = projectPhasePrecedence([], [], []);
    expect(typeof out).toBe('object');
    expect(out instanceof Map).toBe(false);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('emits the six reserved composite field keys', () => {
    const out = projectPhasePrecedence([phase('a')], [], []);
    expect(Object.keys(out)).toHaveLength(6);
    for (const key of Object.keys(out)) {
      expect(key).toMatch(
        /^[a-z][a-z0-9-]{0,63}::(model|effort|timeoutSeconds|loopable|retryCondition|runner)$/
      );
    }
  });

  it('uses workspace over user over built-in whole-row selection', () => {
    const out = projectPhasePrecedence(
      [phase('p', { effort: 'low' })],
      [phase('p', { effort: 'medium' })],
      [phase('p', { effort: 'high' })]
    );
    expect(out['p::effort']).toBe('workspace');
  });

  it('does not fall through individual fields on the selected row', () => {
    const out = projectPhasePrecedence(
      [phase('p', { effort: 'low' })],
      [phase('p', { effort: 'medium' })],
      [phase('p')]
    );
    expect(out['p::effort']).toBe('unset');
  });

  it('uses user when no workspace source row exists', () => {
    const out = projectPhasePrecedence(
      [phase('p', { model: 'built-in-model' })],
      [phase('p', { model: 'user-model' })],
      []
    );
    expect(out['p::model']).toBe('user');
  });

  it('uses built-in when no writable source row exists', () => {
    const out = projectPhasePrecedence([phase('p', { runner: 'claude' })], [], []);
    expect(out['p::runner']).toBe('built-in');
  });

  it('emits six entries for each id in the layer union', () => {
    const out = projectPhasePrecedence([phase('a')], [phase('b')], [phase('c')]);
    expect(new Set(Object.keys(out).map((key) => key.split('::')[0]))).toEqual(
      new Set(['a', 'b', 'c'])
    );
    expect(Object.keys(out)).toHaveLength(18);
  });

  it('does not mutate frozen inputs', () => {
    const builtIn = Object.freeze([phase('p', { effort: 'high' })]);
    const user = Object.freeze([phase('p')]);
    const workspace = Object.freeze([phase('p')]);
    expect(() => projectPhasePrecedence(builtIn, user, workspace)).not.toThrow();
  });
});
