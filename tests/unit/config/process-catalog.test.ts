import { describe, expect, it } from 'vitest';
import { resolvePhaseCatalog, phaseLayerRevision } from '../../../src/config/process-catalog';
import type { PhaseDef } from '../../../src/config/pipeline-config';

const builtIn: readonly PhaseDef[] = [
  { id: 'shared', name: 'Built in', instruction: 'built-in', version: 1, runner: 'claude' },
  { id: 'fallback', name: 'Fallback', instruction: 'fallback', version: 1 }
];

const row = (name: string, overrides: Record<string, unknown> = {}) => ({
  id: 'shared',
  name,
  version: 1,
  instruction: name,
  runner: 'claude',
  ...overrides
});

describe('resolvePhaseCatalog', () => {
  it('selects workspace over user over built-in as whole rows', () => {
    const result = resolvePhaseCatalog({
      builtIn,
      user: [row('User', { model: 'user-model' })],
      workspace: [row('Workspace')]
    });
    expect(result.effective.find((phase) => phase.phaseId === 'shared')).toMatchObject({
      name: 'Workspace'
    });
    expect(result.effective.find((phase) => phase.phaseId === 'shared')).not.toHaveProperty('model');
  });

  it('keeps an invalid high-scope row visible and falls through', () => {
    const result = resolvePhaseCatalog({
      builtIn,
      user: [row('User')],
      workspace: [row('Workspace', { instruction: '   ' })]
    });
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'workspace', phaseId: 'shared', status: 'invalid' }),
        expect.objectContaining({ scope: 'user', phaseId: 'shared', status: 'effective' })
      ])
    );
  });

  it('marks every same-scope duplicate invalid and falls through', () => {
    const result = resolvePhaseCatalog({
      builtIn,
      user: [row('One'), row('Two')],
      workspace: []
    });
    expect(result.records.filter((record) => record.scope === 'user')).toHaveLength(2);
    expect(result.records.filter((record) => record.scope === 'user').every((record) => record.status === 'invalid')).toBe(true);
    expect(result.records.find((record) => record.scope === 'built-in')?.status).toBe('effective');
  });

  it('emits at most one effective definition per id', () => {
    const result = resolvePhaseCatalog({ builtIn, user: [row('User')], workspace: [row('Workspace')] });
    expect(result.effective.filter((phase) => phase.phaseId === 'shared')).toHaveLength(1);
  });

  it('uses a non-colliding repair handle for a row without a string identity', () => {
    const result = resolvePhaseCatalog({
      builtIn: [],
      user: [{ name: 'Broken', instruction: 'broken' }, {
        id: 'invalid-1', name: 'Legitimate', instruction: 'valid'
      }],
      workspace: []
    });
    expect(result.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ phaseId: '?invalid-1', status: 'invalid' }),
      expect.objectContaining({ phaseId: 'invalid-1', status: 'effective' })
    ]));
  });

  it('quarantines an explicit Codex override for a Git-mutating protected id', () => {
    const result = resolvePhaseCatalog({
      builtIn: [{
        id: 'finalize', name: 'Built-in finalize', instruction: 'commit', runner: 'claude'
      }],
      user: [],
      workspace: [{
        id: 'finalize', name: 'Custom finalize', instruction: 'commit', runner: 'codex'
      }]
    });
    expect(result.records.find((record) => record.scope === 'workspace')).toMatchObject({
      status: 'invalid', errors: [expect.objectContaining({ code: 'git-metadata-write-required' })]
    });
    expect(result.effective.find((phase) => phase.phaseId === 'finalize')?.runner).toBe('claude');
  });

  it('computes deterministic semantic layer revisions', () => {
    const first = phaseLayerRevision([{ name: 'A', id: 'a' }]);
    const reorderedKeys = phaseLayerRevision([{ id: 'a', name: 'A' }]);
    expect(first).toBe(reorderedKeys);
    expect(first).not.toBe(phaseLayerRevision([{ id: 'a', name: 'B' }]));
  });
});
