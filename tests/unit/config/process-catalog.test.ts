import { describe, expect, it } from 'vitest';
import {
  phaseDefinitionToPhaseDef,
  phaseLayerRevision,
  resolvePhaseCatalog
} from '../../../src/config/process-catalog';
import type { PhaseDef } from '../../../src/config/pipeline-config';
import { loadCatalog, type CatalogConfigReader } from '../../../src/config/pipeline-config-loader';
import { BUILT_IN_WORKFLOWS } from '../../../src/config/workflow-config';
import { resolveWorkflowCatalog } from '../../../src/config/workflow-catalog';

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

  // Feature 098 T018 — the rule this exercises was re-keyed from an id list onto
  // the declared containment class, so the fixture now declares `sideEffects:
  // 'git'` rather than relying on `finalize` having been one of five known ids.
  // The id is retained only so the case still reads as the one it replaced; it
  // carries no authority, and a row declaring nothing under the same id and the
  // same runner is admitted (asserted in `phase-runner-policy.test.ts`).
  it('quarantines an explicit Codex override for a Phase declaring Git side effects', () => {
    const result = resolvePhaseCatalog({
      builtIn: [{
        id: 'finalize', name: 'Built-in finalize', instruction: 'commit',
        runner: 'claude', sideEffects: 'git'
      }],
      user: [],
      workspace: [{
        id: 'finalize', name: 'Custom finalize', instruction: 'commit',
        runner: 'codex', sideEffects: 'git'
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

// Feature 098 T011 — the site that silently dropped the declaration
// (research.md R3, FR-004).
//
// `phaseDefinitionToPhaseDef` spread `builtIn?.sideEffects`, and `builtIn` is
// non-`undefined` only when `scope === 'built-in'`. So an imported Phase's
// declared containment class was discarded here, one layer *before* the snapshot
// ever saw it — which is why fixing `snapshotPhaseDef` alone would not have been
// enough: the field arrived at the freeze already absent, and the freeze would
// have applied its default to a Phase that had in fact declared something.
//
// The `built-in` cases below still assert the old precedence, because Stage 1
// lands on a build where the built-in layer still exists. They are written as
// `definition ?? builtIn` rather than as either operand alone, so they stay
// correct after Stage 3 empties that layer and the right operand goes dead.

describe('phaseDefinitionToPhaseDef — containment declarations survive resolution', () => {
  const definition = (overrides: Record<string, unknown> = {}) => ({
    phaseId: 'imported-phase',
    name: 'Imported Phase',
    version: 1,
    instruction: 'Do the imported thing.',
    ...overrides
  }) as Parameters<typeof phaseDefinitionToPhaseDef>[0];

  /** No built-in row for the id under test, which is the imported-Phase case. */
  const noBuiltIns = new Map<string, PhaseDef>();

  it.each(['none', 'workspace', 'git', 'unrestricted'] as const)(
    'carries a user-scope definition declaring sideEffects: %s',
    (declared) => {
      const phase = phaseDefinitionToPhaseDef(
        definition({ sideEffects: declared }),
        'user',
        noBuiltIns
      );
      expect(phase.sideEffects).toBe(declared);
    }
  );

  it.each(['required', 'best-effort', 'none'] as const)(
    'carries a workspace-scope definition declaring evidencePolicy: %s',
    (declared) => {
      const phase = phaseDefinitionToPhaseDef(
        definition({ evidencePolicy: declared }),
        'workspace',
        noBuiltIns
      );
      expect(phase.evidencePolicy).toBe(declared);
    }
  );

  it('carries both declarations together', () => {
    const phase = phaseDefinitionToPhaseDef(
      definition({ sideEffects: 'git', evidencePolicy: 'best-effort' }),
      'user',
      noBuiltIns
    );
    expect(phase.sideEffects).toBe('git');
    expect(phase.evidencePolicy).toBe('best-effort');
  });

  it('omits the key entirely when the definition declares nothing', () => {
    // Absence must stay absence here: the default belongs to the freeze
    // (FR-005), and filling it in at resolution would make an omission
    // indistinguishable from a declaration one layer earlier than intended.
    const phase = phaseDefinitionToPhaseDef(definition(), 'user', noBuiltIns);
    expect(phase).not.toHaveProperty('sideEffects');
    expect(phase).not.toHaveProperty('evidencePolicy');
  });

  it('prefers the definition over a built-in row that disagrees', () => {
    const builtInRow: PhaseDef = {
      id: 'imported-phase',
      name: 'Built-in',
      instruction: 'built-in',
      version: 1,
      sideEffects: 'unrestricted',
      evidencePolicy: 'none'
    };
    const phase = phaseDefinitionToPhaseDef(
      definition({ sideEffects: 'workspace', evidencePolicy: 'required' }),
      'built-in',
      new Map([[builtInRow.id, builtInRow]])
    );
    expect(phase.sideEffects).toBe('workspace');
    expect(phase.evidencePolicy).toBe('required');
  });

  it('falls back to the built-in row while one still exists', () => {
    const builtInRow: PhaseDef = {
      id: 'imported-phase',
      name: 'Built-in',
      instruction: 'built-in',
      version: 1,
      sideEffects: 'git',
      evidencePolicy: 'best-effort'
    };
    const phase = phaseDefinitionToPhaseDef(
      definition(),
      'built-in',
      new Map([[builtInRow.id, builtInRow]])
    );
    expect(phase.sideEffects).toBe('git');
    expect(phase.evidencePolicy).toBe('best-effort');
  });
});

describe('a workspace with no operator-authored settings has four empty catalogs (T031)', () => {
  // Feature 098 (FR-010, FR-011, SC-001) — the product's own claim on the four
  // catalogs, asserted from the outside. A reader that answers `undefined` to every
  // question is exactly a fresh workspace: nothing in user settings, nothing in
  // workspace settings. What is left is whatever the code ships, and after this
  // feature that is nothing.
  //
  // All four are asserted in one place on purpose. The Workflow layer has shipped
  // empty since feature 086 and is the existence proof the other three are
  // following, so a regression in any one of them is most legible next to the three
  // that agree.
  const NO_SETTINGS: CatalogConfigReader = {
    getPhases: () => undefined,
    getPipelines: () => undefined,
    getModels: () => undefined,
    getDefaultPipelineId: () => undefined
  };

  it('resolves zero Phases and zero Pipelines, and names no default', () => {
    const loaded = loadCatalog(NO_SETTINGS);

    expect(loaded.catalog.phases).toEqual([]);
    expect(loaded.catalog.pipelines).toEqual([]);
    expect(loaded.catalog.phasesById.size).toBe(0);
    expect(loaded.catalog.pipelinesById.size).toBe(0);
    expect(loaded.defaultPipelineId).toBe('');
    // Empty is the honest answer, not a failure: nothing is reported as an error
    // and no substituted set is flagged.
    expect(loaded.errors).toEqual([]);
    expect(loaded.usedFallback).toBe(false);
  });

  it('offers no models for any backend', () => {
    const loaded = loadCatalog(NO_SETTINGS);

    expect(loaded.catalog.models).toEqual({ claude: [], codex: [], agy: [] });
  });

  it('resolves zero Workflows', () => {
    const loaded = loadCatalog(NO_SETTINGS);
    const workflows = resolveWorkflowCatalog({
      builtIn: BUILT_IN_WORKFLOWS,
      user: undefined,
      workspace: undefined,
      pipelineCatalog: {
        effective: loaded.pipelineCatalog.effective,
        records: loaded.pipelineCatalog.records
      }
    });

    expect(workflows.effective).toEqual([]);
    expect(workflows.records).toEqual([]);
  });

  it('reports every layer of every catalog as holding no rows at all', () => {
    // Distinct from the assertions above: those read the *effective* projection,
    // which an empty built-in layer and a shadowed-everything layer would both
    // satisfy. This reads the retained source records, so a row that exists but
    // resolves away still fails it.
    const loaded = loadCatalog(NO_SETTINGS);

    expect(loaded.builtInPhases).toEqual([]);
    expect(loaded.userPhases).toEqual([]);
    expect(loaded.workspacePhases).toEqual([]);
    expect(loaded.phaseCatalog.records).toEqual([]);
    expect(loaded.pipelineCatalog.records).toEqual([]);
  });
});
