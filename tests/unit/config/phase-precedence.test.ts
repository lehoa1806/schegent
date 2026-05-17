import { describe, expect, it } from 'vitest';
import {
  projectPhasePrecedence,
  type PhasePrecedenceLayer
} from '../../../src/config/phase-precedence';
import type { PhaseDef } from '../../../src/config/pipeline-config';

function phase(id: string, fields: Partial<PhaseDef> = {}): PhaseDef {
  return Object.freeze({
    id,
    name: id,
    instruction: 'noop',
    loopable: false,
    ...fields
  } as PhaseDef);
}

describe('projectPhasePrecedence', () => {
  it('returns a plain object (not a Map) so it survives structured-clone', () => {
    const out = projectPhasePrecedence([], [], []);
    expect(typeof out).toBe('object');
    expect(out instanceof Map).toBe(false);
  });

  it('emits composite keys of the form `<phaseId>::<fieldKey>` for every entry', () => {
    const out = projectPhasePrecedence([phase('a')], [], []);
    for (const k of Object.keys(out)) {
      expect(k).toMatch(/^[a-z][a-z0-9-]{0,63}::(model|effort|timeoutSeconds|loopable|retryCondition)$/);
    }
  });

  it('treats undefined inputs as "unset" at every layer', () => {
    const out = projectPhasePrecedence([phase('a')], [phase('a')], [phase('a')]);
    for (const k of Object.keys(out)) {
      if (k.endsWith('::loopable')) {
        // loopable is a required field on PhaseDef set to false in the test
        // factory at every layer — workspace layer wins by precedence order.
        expect(out[k]).toBe('workspace');
      } else {
        expect(out[k]).toBe('unset');
      }
    }
  });

  it('case (a): only user layer sets the field → "user"', () => {
    const builtIn = [phase('p')];
    const user = [phase('p', { effort: 'high' })];
    const workspace = [phase('p')];
    const out = projectPhasePrecedence(builtIn, user, workspace);
    expect(out['p::effort']).toBe('user');
  });

  it('case (b): workspace shadows user → "workspace"', () => {
    const builtIn = [phase('p')];
    const user = [phase('p', { effort: 'medium' })];
    const workspace = [phase('p', { effort: 'high' })];
    const out = projectPhasePrecedence(builtIn, user, workspace);
    expect(out['p::effort']).toBe('workspace');
  });

  it('case (c): only built-in sets the field → "built-in"', () => {
    const builtIn = [phase('p', { effort: 'low' })];
    const user = [phase('p')];
    const workspace = [phase('p')];
    const out = projectPhasePrecedence(builtIn, user, workspace);
    expect(out['p::effort']).toBe('built-in');
  });

  it('case (d): no layer sets the field → "unset"', () => {
    const builtIn = [phase('p')];
    const user = [phase('p')];
    const workspace = [phase('p')];
    const out = projectPhasePrecedence(builtIn, user, workspace);
    expect(out['p::effort']).toBe('unset');
  });

  it('applies the same matrix to model: user-only, workspace-shadow, built-in-only, unset', () => {
    expect(
      projectPhasePrecedence([phase('p')], [phase('p', { model: 'm-u' })], [phase('p')])['p::model']
    ).toBe('user');
    expect(
      projectPhasePrecedence(
        [phase('p')],
        [phase('p', { model: 'm-u' })],
        [phase('p', { model: 'm-w' })]
      )['p::model']
    ).toBe('workspace');
    expect(
      projectPhasePrecedence([phase('p', { model: 'm-b' })], [phase('p')], [phase('p')])['p::model']
    ).toBe('built-in');
    expect(
      projectPhasePrecedence([phase('p')], [phase('p')], [phase('p')])['p::model']
    ).toBe('unset');
  });

  it('emits "unset" for effort/model when none of the three layers carry them for the phase', () => {
    const out = projectPhasePrecedence([phase('p')], [phase('p')], [phase('p')]);
    expect(out['p::effort']).toBe('unset');
    expect(out['p::model']).toBe('unset');
  });

  it('union of phase ids across layers: each unique id contributes 5 composite entries', () => {
    const builtIn = [phase('a')];
    const user = [phase('b')];
    const workspace = [phase('c')];
    const out = projectPhasePrecedence(builtIn, user, workspace);
    const keys = Object.keys(out);
    const ids = new Set(keys.map((k) => k.split('::')[0]));
    expect(ids).toEqual(new Set(['a', 'b', 'c']));
    expect(keys.length).toBe(15); // 3 ids × 5 fieldKeys
  });

  it('does not mutate frozen inputs (purity)', () => {
    const builtIn = Object.freeze([phase('p', { effort: 'high' })]);
    const user = Object.freeze([phase('p')]);
    const workspace = Object.freeze([phase('p')]);
    expect(() => projectPhasePrecedence(builtIn, user, workspace)).not.toThrow();
    // Validate that the returned projection is frozen
    const out = projectPhasePrecedence(builtIn, user, workspace);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('12-cell matrix: every (layer × set/unset × effort/model) combination resolves', () => {
    const layers: PhasePrecedenceLayer[] = ['user', 'workspace', 'built-in', 'unset'];
    const matrix: Array<{ field: 'effort' | 'model'; layer: PhasePrecedenceLayer }> = [];
    for (const f of ['effort', 'model'] as const) {
      for (const l of layers) matrix.push({ field: f, layer: l });
    }
    for (const cell of matrix) {
      const set = cell.field === 'effort' ? { effort: 'high' as const } : { model: 'm' };
      let builtIn: PhaseDef[] = [phase('p')];
      let user: PhaseDef[] = [phase('p')];
      let workspace: PhaseDef[] = [phase('p')];
      if (cell.layer === 'user') user = [phase('p', set)];
      else if (cell.layer === 'workspace') workspace = [phase('p', set)];
      else if (cell.layer === 'built-in') builtIn = [phase('p', set)];
      const out = projectPhasePrecedence(builtIn, user, workspace);
      const key = `p::${cell.field}`;
      expect(out[key]).toBe(cell.layer);
    }
  });
});
