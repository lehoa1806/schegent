import { describe, expect, it } from 'vitest';
import {
  PIPELINE_CATALOG_SOFT_CAP,
  PIPELINE_PHASE_SOFT_CAP,
  pipelineLayerRevision,
  pipelineSourceIdentity,
  resolvePipelineCatalog
} from '../../../src/config/pipeline-catalog';
import type { PipelineDef } from '../../../src/config/pipeline-config';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';

const phase = (phaseId: string): PhaseDefinition => ({
  phaseId,
  name: phaseId,
  version: 1,
  instruction: phaseId
});

const phaseCatalog: readonly PhaseDefinition[] = [
  phase('speckit-specify'),
  phase('speckit-plan'),
  phase('finalize')
];

const builtIn: readonly PipelineDef[] = [
  { id: 'shared', name: 'Built in', phases: ['speckit-specify'], version: 1 },
  { id: 'fallback', name: 'Fallback', phases: ['finalize'], version: 1 }
];

const row = (name: string, overrides: Record<string, unknown> = {}) => ({
  id: 'shared',
  name,
  version: 1,
  phases: ['speckit-specify', 'speckit-plan'],
  ...overrides
});

describe('pipelineSourceIdentity', () => {
  it('prefers the portable pipelineId, then the legacy id', () => {
    expect(pipelineSourceIdentity({ pipelineId: 'portable', id: 'legacy' }, 0)).toBe('portable');
    expect(pipelineSourceIdentity({ id: 'legacy' }, 0)).toBe('legacy');
  });

  it('assigns a synthetic one-based id when the row has no usable identity', () => {
    expect(pipelineSourceIdentity(null, 0)).toBe('?invalid-1');
    expect(pipelineSourceIdentity('not-an-object', 4)).toBe('?invalid-5');
    expect(pipelineSourceIdentity({ id: '   ' }, 1)).toBe('?invalid-2');
  });
});

describe('pipelineLayerRevision', () => {
  it('is stable across key order', () => {
    const a = pipelineLayerRevision([{ id: 'a', name: 'A', phases: ['finalize'] }]);
    const b = pipelineLayerRevision([{ phases: ['finalize'], name: 'A', id: 'a' }]);
    expect(a).toBe(b);
  });

  it('changes when content changes', () => {
    const a = pipelineLayerRevision([{ id: 'a', name: 'A', phases: ['finalize'] }]);
    const b = pipelineLayerRevision([{ id: 'a', name: 'B', phases: ['finalize'] }]);
    expect(a).not.toBe(b);
  });

  it('treats an absent layer as an empty layer', () => {
    expect(pipelineLayerRevision(undefined)).toBe(pipelineLayerRevision([]));
  });
});

describe('resolvePipelineCatalog — precedence (FR-003, SC-001)', () => {
  it('selects workspace over user over built-in as whole rows', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: [row('User', { description: 'user only' })],
      workspace: [row('Workspace')],
      phaseCatalog
    });
    const shared = result.effective.find((pipeline) => pipeline.pipelineId === 'shared');
    expect(shared).toMatchObject({ name: 'Workspace' });
    expect(shared?.description).toBeUndefined();
  });

  it('emits exactly one effective record per id and marks the rest shadowed', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: [row('User')],
      workspace: [row('Workspace')],
      phaseCatalog
    });
    const shared = result.records.filter((record) => record.pipelineId === 'shared');
    expect(shared.filter((record) => record.status === 'effective')).toHaveLength(1);
    expect(shared.find((record) => record.scope === 'workspace')?.status).toBe('effective');
    expect(shared.find((record) => record.scope === 'user')?.status).toBe('shadowed');
    expect(shared.find((record) => record.scope === 'built-in')?.status).toBe('shadowed');
    expect(result.effective.filter((pipeline) => pipeline.pipelineId === 'shared')).toHaveLength(1);
  });

  it('keeps an invalid high-scope row visible and falls through to the next scope', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: [row('User')],
      workspace: [row('Workspace', { phases: [] })],
      phaseCatalog
    });
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'workspace', pipelineId: 'shared', status: 'invalid' }),
        expect.objectContaining({ scope: 'user', pipelineId: 'shared', status: 'effective' })
      ])
    );
  });

  it('projects effectivePipelineDefs in the runtime shape with the resolved sourceScope', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: [],
      workspace: [row('Workspace')],
      phaseCatalog
    });
    const shared = result.effectivePipelineDefs.find((pipeline) => pipeline.id === 'shared');
    expect(shared).toMatchObject({
      id: 'shared',
      name: 'Workspace',
      phases: ['speckit-specify', 'speckit-plan'],
      sourceScope: 'workspace'
    });
    const fallback = result.effectivePipelineDefs.find((pipeline) => pipeline.id === 'fallback');
    expect(fallback?.sourceScope).toBe('built-in');
  });
});

describe('resolvePipelineCatalog — invalid rows are retained (FR-002)', () => {
  it('retains an unparseable row as a record with a synthetic id', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: ['nonsense'],
      workspace: [],
      phaseCatalog
    });
    const record = result.records.find((entry) => entry.scope === 'user');
    expect(record).toMatchObject({ pipelineId: '?invalid-1', status: 'invalid', definition: null });
    expect(record?.errors.length).toBeGreaterThan(0);
  });

  it('never projects a synthetic id into effective', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: [{ name: 'No id', phases: ['finalize'] }],
      workspace: [],
      phaseCatalog
    });
    expect(result.effective.some((pipeline) => pipeline.pipelineId.startsWith('?invalid-'))).toBe(
      false
    );
    expect(result.records.some((record) => record.pipelineId === '?invalid-1')).toBe(true);
  });

  it('warns once when any source row requires repair', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: ['nonsense'],
      workspace: [],
      phaseCatalog
    });
    expect(result.warnings.filter((warning) => warning.code === 'invalid-source-rows')).toHaveLength(
      1
    );
  });
});

describe('resolvePipelineCatalog — duplicate ids inside one scope (FR-036)', () => {
  it('invalidates both rows and falls through to the next scope', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: [row('One'), row('Two')],
      workspace: [],
      phaseCatalog
    });
    const userRecords = result.records.filter((record) => record.scope === 'user');
    expect(userRecords).toHaveLength(2);
    expect(userRecords.every((record) => record.status === 'invalid')).toBe(true);
    expect(userRecords.every((record) => record.definition === null)).toBe(true);
    expect(
      userRecords.every((record) =>
        record.errors.some((error) => error.code === 'duplicate-in-scope')
      )
    ).toBe(true);
    expect(
      result.records.find((record) => record.scope === 'built-in' && record.pipelineId === 'shared')
        ?.status
    ).toBe('effective');
  });

  it('does not treat two synthetic ids as duplicates of each other', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: ['nonsense', 42],
      workspace: [],
      phaseCatalog
    });
    const userRecords = result.records.filter((record) => record.scope === 'user');
    expect(userRecords.map((record) => record.pipelineId)).toEqual(['?invalid-1', '?invalid-2']);
    expect(
      userRecords.some((record) =>
        record.errors.some((error) => error.code === 'duplicate-in-scope')
      )
    ).toBe(false);
  });

  it('allows the same id in two different scopes', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: [row('User')],
      workspace: [row('Workspace')],
      phaseCatalog
    });
    expect(
      result.records.some((record) => record.errors.some((e) => e.code === 'duplicate-in-scope'))
    ).toBe(false);
  });
});

describe('resolvePipelineCatalog — Phase references and bindings (FR-011)', () => {
  it('invalidates a row whose phaseIds do not resolve against the effective Phase catalog', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: [row('User', { id: 'ghost', phases: ['speckit-specify', 'made-up-phase'] })],
      workspace: [],
      phaseCatalog
    });
    const record = result.records.find((entry) => entry.pipelineId === 'ghost');
    expect(record?.status).toBe('invalid');
    expect(record?.definition).toBeNull();
    expect(record?.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'phaseIds[1]', code: 'unknown-phase' })
      ])
    );
  });

  it('invalidates a row whose bindings fail cross-reference validation', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: [
        row('User', {
          id: 'wired',
          bindings: [
            { kind: 'input', phaseIndex: 0, inputKey: 'brief', source: { from: 'pipeline-input', portId: 'missing' } }
          ]
        })
      ],
      workspace: [],
      phaseCatalog
    });
    const record = result.records.find((entry) => entry.pipelineId === 'wired');
    expect(record?.status).toBe('invalid');
    expect(record?.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'binding-unknown-input-port' })])
    );
  });

  it('keeps a fully wired row effective', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: [
        row('User', {
          id: 'wired',
          inputs: [
            { portId: 'brief', label: 'Brief', type: 'text' },
            { portId: 'spec', label: 'Spec in', type: 'pipeline-output' }
          ],
          outputs: [{ portId: 'spec', label: 'Spec out', type: 'markdown' }],
          bindings: [
            { kind: 'input', phaseIndex: 0, inputKey: 'brief', source: { from: 'pipeline-input', portId: 'brief' } },
            { kind: 'output', phaseIndex: 0, portId: 'spec', outputKey: 'spec' },
            { kind: 'input', phaseIndex: 1, inputKey: 'spec', source: { from: 'phase-output', phaseIndex: 0, portId: 'spec' } }
          ]
        })
      ],
      workspace: [],
      phaseCatalog
    });
    const record = result.records.find((entry) => entry.pipelineId === 'wired');
    expect(record?.errors).toEqual([]);
    expect(record?.status).toBe('effective');
  });
});

describe('resolvePipelineCatalog — advisory warnings (FR-019a, FR-033)', () => {
  it('warns when effective Pipelines exceed the soft cap', () => {
    const user = Array.from({ length: PIPELINE_CATALOG_SOFT_CAP + 1 }, (_unused, index) => ({
      id: `pipeline-${index}`,
      name: `Pipeline ${index}`,
      version: 1,
      phases: ['finalize']
    }));
    const result = resolvePipelineCatalog({ builtIn: [], user, workspace: [], phaseCatalog });
    expect(result.warnings.some((warning) => warning.code === 'pipeline-soft-cap')).toBe(true);
  });

  it('does not warn at exactly the soft cap', () => {
    const user = Array.from({ length: PIPELINE_CATALOG_SOFT_CAP }, (_unused, index) => ({
      id: `pipeline-${index}`,
      name: `Pipeline ${index}`,
      version: 1,
      phases: ['finalize']
    }));
    const result = resolvePipelineCatalog({ builtIn: [], user, workspace: [], phaseCatalog });
    expect(result.warnings.some((warning) => warning.code === 'pipeline-soft-cap')).toBe(false);
  });

  it('warns when a Pipeline sequence exceeds the per-Pipeline Phase soft cap', () => {
    const phases = Array.from({ length: PIPELINE_PHASE_SOFT_CAP + 1 }, () => 'finalize');
    const result = resolvePipelineCatalog({
      builtIn: [],
      user: [{ id: 'long', name: 'Long', version: 1, phases }],
      workspace: [],
      phaseCatalog
    });
    const warning = result.warnings.find((entry) => entry.code === 'pipeline-phase-soft-cap');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('long');
  });

  // T058 (FR-033) — a soft cap is advice, not enforcement. The warning above is
  // the cheap half to get right; the half that matters is that nothing is
  // silently dropped or shortened on the way past the cap, because an operator
  // who ignores the advice must still get the catalog they authored.
  it('keeps every Pipeline effective past the catalog soft cap — the cap never drops a row', () => {
    const count = PIPELINE_CATALOG_SOFT_CAP + 5;
    const user = Array.from({ length: count }, (_unused, index) => ({
      id: `pipeline-${index}`,
      name: `Pipeline ${index}`,
      version: 1,
      phases: ['finalize']
    }));
    const result = resolvePipelineCatalog({ builtIn: [], user, workspace: [], phaseCatalog });

    expect(result.effective).toHaveLength(count);
    expect(result.records).toHaveLength(count);
    for (const record of result.records) {
      expect(record.status).toBe('effective');
      expect(record.errors).toEqual([]);
    }
    // The last row past the cap resolves exactly like the first.
    expect(result.effective.at(-1)?.pipelineId).toBe(`pipeline-${count - 1}`);
  });

  it('keeps the whole sequence past the per-Pipeline Phase soft cap — the cap never truncates', () => {
    const length = PIPELINE_PHASE_SOFT_CAP + 7;
    const phases = Array.from({ length }, () => 'finalize');
    const result = resolvePipelineCatalog({
      builtIn: [],
      user: [{ id: 'long', name: 'Long', version: 1, phases }],
      workspace: [],
      phaseCatalog
    });

    const definition = result.effective.find((entry) => entry.pipelineId === 'long');
    expect(definition?.phaseIds).toHaveLength(length);
    expect(result.effectivePipelineDefs.find((def) => def.id === 'long')?.phases).toHaveLength(
      length
    );
  });

  it('reports a soft-cap breach as a warning only — the record stays valid and effective', () => {
    const phases = Array.from({ length: PIPELINE_PHASE_SOFT_CAP + 1 }, () => 'finalize');
    const result = resolvePipelineCatalog({
      builtIn: [],
      user: [{ id: 'long', name: 'Long', version: 1, phases }],
      workspace: [],
      phaseCatalog
    });

    const record = result.records.find((entry) => entry.pipelineId === 'long');
    expect(record?.status).toBe('effective');
    expect(record?.errors).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toContain('pipeline-phase-soft-cap');
  });

  it('warns — never errors — when a recommendedNext id has no effective definition', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: [row('User', { id: 'suggester', recommendedNext: ['fallback', 'not-a-pipeline'] })],
      workspace: [],
      phaseCatalog
    });
    const record = result.records.find((entry) => entry.pipelineId === 'suggester');
    expect(record?.status).toBe('effective');
    expect(record?.errors).toEqual([]);
    const warning = result.warnings.find(
      (entry) => entry.code === 'pipeline-recommended-next-unresolved'
    );
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('not-a-pipeline');
    expect(warning?.message).not.toContain('fallback');
  });
});

// Feature 082 (US3, T041) — FR-035.
//
// An execution default naming a model the operator's catalog does not offer is
// advice, not a defect: the identifier stays stored and visible so switching
// back to a backend that has it restores the choice instead of finding it
// silently rewritten.
describe('resolvePipelineCatalog — unavailable execution-default model (FR-035)', () => {
  const modelRow = (model: string, overrides: Record<string, unknown> = {}) =>
    row('Modelled', {
      id: 'modelled',
      executionDefaults: { runner: 'claude', model },
      ...overrides
    });

  it('warns and preserves the stored identifier rather than replacing it', () => {
    const result = resolvePipelineCatalog({
      builtIn: [],
      user: [modelRow('retired-model')],
      workspace: [],
      phaseCatalog,
      availableModels: { claude: ['current-model'] }
    });
    const record = result.records.find((entry) => entry.pipelineId === 'modelled');
    expect(record?.status).toBe('effective');
    expect(record?.errors).toEqual([]);
    expect(record?.definition?.executionDefaults?.model).toBe('retired-model');
    const warning = result.warnings.find((entry) => entry.code === 'pipeline-model-unavailable');
    expect(warning).toBeDefined();
    expect(warning?.message).toContain('retired-model');
    expect(warning?.message).toContain('modelled');
  });

  it('stays silent when the model is offered by the runner it names', () => {
    const result = resolvePipelineCatalog({
      builtIn: [],
      user: [modelRow('current-model')],
      workspace: [],
      phaseCatalog,
      availableModels: { claude: ['current-model'], codex: [] }
    });
    expect(result.warnings.some((entry) => entry.code === 'pipeline-model-unavailable')).toBe(false);
  });

  it('resolves an unnamed runner against the supplied default', () => {
    const result = resolvePipelineCatalog({
      builtIn: [],
      user: [row('Modelled', { id: 'modelled', executionDefaults: { model: 'retired-model' } })],
      workspace: [],
      phaseCatalog,
      availableModels: { claude: ['current-model'] },
      defaultRunnerKind: 'claude'
    });
    expect(result.warnings.some((entry) => entry.code === 'pipeline-model-unavailable')).toBe(true);
  });

  it('treats an absent or empty model list as unknown availability, not as unavailable', () => {
    for (const availableModels of [undefined, { claude: [] }]) {
      const result = resolvePipelineCatalog({
        builtIn: [],
        user: [modelRow('retired-model')],
        workspace: [],
        phaseCatalog,
        ...(availableModels !== undefined ? { availableModels } : {})
      });
      expect(
        result.warnings.some((entry) => entry.code === 'pipeline-model-unavailable'),
        `availableModels=${JSON.stringify(availableModels)} must not warn`
      ).toBe(false);
    }
  });
});

describe('resolvePipelineCatalog — revisions and immutability', () => {
  it('reports a SHA-256 layer revision per writable scope', () => {
    const user = [row('User')];
    const workspace = [row('Workspace')];
    const result = resolvePipelineCatalog({ builtIn, user, workspace, phaseCatalog });
    expect(result.revisions.user).toBe(pipelineLayerRevision(user));
    expect(result.revisions.workspace).toBe(pipelineLayerRevision(workspace));
    expect(Object.keys(result.revisions).sort()).toEqual(['user', 'workspace']);
  });

  it('freezes the resolution and its collections', () => {
    const result = resolvePipelineCatalog({ builtIn, user: [], workspace: [], phaseCatalog });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.effective)).toBe(true);
    expect(Object.isFrozen(result.effectivePipelineDefs)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
    expect(Object.isFrozen(result.revisions)).toBe(true);
  });

  it('resolves the built-in layer with no configured layers present', () => {
    const result = resolvePipelineCatalog({
      builtIn,
      user: undefined,
      workspace: undefined,
      phaseCatalog
    });
    expect(result.effective.map((pipeline) => pipeline.pipelineId)).toEqual(['shared', 'fallback']);
    expect(result.warnings).toEqual([]);
  });
});
