import { describe, expect, it } from 'vitest';
import {
  PIPELINE_CATALOG_SOFT_CAP,
  PIPELINE_PHASE_SOFT_CAP,
  pipelineSourceIdentity,
  resolvePipelineCatalog
} from '../../../src/config/pipeline-catalog';
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

// Feature 099 (T496f, FR-042/FR-043) — was three layer arrays. The resolver takes
// one row list and the store's revision, so the fixture is one list and every
// call below passes `rows`. `FALLBACK_ROW` is what the old `builtIn` array
// contributed to the cases that needed a second, undisturbed id in the catalog.
const FALLBACK_ROW = { id: 'fallback', name: 'Fallback', phases: ['finalize'], version: 1 };

/** The revision the store reported for this catalog. Echoed back, never derived. */
const REVISION = 'rev-pipeline-1';

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

// Feature 099 (T496f, FR-044a) — `pipelineLayerRevision` is deleted. It hashed a
// layer's rows so the Builder could detect that the layer had moved under it. The
// store issues the revision now and this module reports it back verbatim, so
// there is no derivation left here to test; the store's own suite owns the hash,
// and the echo is asserted at the bottom of this file.

// Feature 099 (T496f, FR-043) — the precedence block is deleted whole. Its four
// cases asserted which of three layers a shared id resolved out of, that the
// losers were marked `shadowed`, that an invalid winner fell through to the next
// layer, and that the winner's scope was stamped onto the runtime def. Every one
// of those is a claim about an ordering between layers, and there is one layer;
// `shadowed` and `sourceScope` are deleted with it. Nothing weaker replaces them:
// the surviving question about two rows claiming one id is the duplicate rule
// below, which invalidates BOTH rather than ranking them.

describe('resolvePipelineCatalog — invalid rows are retained (FR-002)', () => {
  it('retains an unparseable row as a record with a synthetic id', () => {
    const result = resolvePipelineCatalog({
      rows: ['nonsense'],
      revision: REVISION,
      phaseCatalog
    });
    const record = result.records.find((entry) => entry.pipelineId === '?invalid-1');
    expect(record).toMatchObject({ pipelineId: '?invalid-1', status: 'invalid', definition: null });
    expect(record?.errors.length).toBeGreaterThan(0);
  });

  it('never projects a synthetic id into effective', () => {
    const result = resolvePipelineCatalog({
      rows: [{ name: 'No id', phases: ['finalize'] }],
      revision: REVISION,
      phaseCatalog
    });
    expect(result.effective.some((pipeline) => pipeline.pipelineId.startsWith('?invalid-'))).toBe(
      false
    );
    expect(result.records.some((record) => record.pipelineId === '?invalid-1')).toBe(true);
  });

  it('warns once when any source row requires repair', () => {
    const result = resolvePipelineCatalog({
      rows: ['nonsense'],
      revision: REVISION,
      phaseCatalog
    });
    expect(result.warnings.filter((warning) => warning.code === 'invalid-source-rows')).toHaveLength(
      1
    );
  });
});

// Feature 099 (T496f, FR-036/FR-043) — "inside one scope" is now the only place
// two rows can collide, so the rule is unqualified: one catalog, one id. The
// `duplicate-in-scope` error CODE is deliberately unchanged — it is host/webview
// parity surface and renaming it would be a contract change this feature does not
// make (recorded in tasks.md) — while what it means is now simply "twice here".
describe('resolvePipelineCatalog — duplicate ids (FR-036)', () => {
  it('invalidates both rows rather than ranking them', () => {
    const result = resolvePipelineCatalog({
      rows: [row('One'), row('Two'), FALLBACK_ROW],
      revision: REVISION,
      phaseCatalog
    });
    const collided = result.records.filter((record) => record.pipelineId === 'shared');
    expect(collided).toHaveLength(2);
    expect(collided.every((record) => record.status === 'invalid')).toBe(true);
    expect(collided.every((record) => record.definition === null)).toBe(true);
    expect(
      collided.every((record) =>
        record.errors.some((error) => error.code === 'duplicate-in-scope')
      )
    ).toBe(true);
    // The collision is confined to the id that collided: an unrelated row in the
    // same catalog is untouched. This is what the old "falls through to the next
    // scope" assertion was really protecting, with the fall-through removed.
    expect(
      result.records.find((record) => record.pipelineId === 'fallback')?.status
    ).toBe('effective');
  });

  it('does not treat two synthetic ids as duplicates of each other', () => {
    const result = resolvePipelineCatalog({
      rows: ['nonsense', 42],
      revision: REVISION,
      phaseCatalog
    });
    expect(result.records.map((record) => record.pipelineId)).toEqual([
      '?invalid-1',
      '?invalid-2'
    ]);
    expect(
      result.records.some((record) =>
        record.errors.some((error) => error.code === 'duplicate-in-scope')
      )
    ).toBe(false);
  });

  // Feature 099 (T496f, FR-043) — "allows the same id in two different scopes"
  // is deleted. There are no two scopes to hold it in, and the case it excluded
  // is now the collision above rather than a permitted arrangement.
});

describe('resolvePipelineCatalog — Phase references and bindings (FR-011)', () => {
  it('invalidates a row whose phaseIds do not resolve against the effective Phase catalog', () => {
    const result = resolvePipelineCatalog({
      rows: [row('User', { id: 'ghost', phases: ['speckit-specify', 'made-up-phase'] })],
      revision: REVISION,
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
      rows: [
        row('User', {
          id: 'wired',
          bindings: [
            { kind: 'input', phaseIndex: 0, inputKey: 'brief', source: { from: 'pipeline-input', portId: 'missing' } }
          ]
        })
      ],
      revision: REVISION,
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
      rows: [
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
      revision: REVISION,
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
    const result = resolvePipelineCatalog({ rows: user, revision: REVISION, phaseCatalog });
    expect(result.warnings.some((warning) => warning.code === 'pipeline-soft-cap')).toBe(true);
  });

  it('does not warn at exactly the soft cap', () => {
    const user = Array.from({ length: PIPELINE_CATALOG_SOFT_CAP }, (_unused, index) => ({
      id: `pipeline-${index}`,
      name: `Pipeline ${index}`,
      version: 1,
      phases: ['finalize']
    }));
    const result = resolvePipelineCatalog({ rows: user, revision: REVISION, phaseCatalog });
    expect(result.warnings.some((warning) => warning.code === 'pipeline-soft-cap')).toBe(false);
  });

  it('warns when a Pipeline sequence exceeds the per-Pipeline Phase soft cap', () => {
    const phases = Array.from({ length: PIPELINE_PHASE_SOFT_CAP + 1 }, () => 'finalize');
    const result = resolvePipelineCatalog({
      rows: [{ id: 'long', name: 'Long', version: 1, phases }],
      revision: REVISION,
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
    const result = resolvePipelineCatalog({ rows: user, revision: REVISION, phaseCatalog });

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
      rows: [{ id: 'long', name: 'Long', version: 1, phases }],
      revision: REVISION,
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
      rows: [{ id: 'long', name: 'Long', version: 1, phases }],
      revision: REVISION,
      phaseCatalog
    });

    const record = result.records.find((entry) => entry.pipelineId === 'long');
    expect(record?.status).toBe('effective');
    expect(record?.errors).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toContain('pipeline-phase-soft-cap');
  });

  it('warns — never errors — when a recommendedNext id has no effective definition', () => {
    // `fallback` is present as a row so that it RESOLVES: the warning must name
    // only the ids that do not, which is what distinguishes it from a warning
    // that simply echoes every id a Pipeline recommends. It reached the catalog
    // through the built-in layer before feature 099; a row is where it comes
    // from now, and the case is unchanged in what it asserts.
    const result = resolvePipelineCatalog({
      rows: [
        row('User', { id: 'suggester', recommendedNext: ['fallback', 'not-a-pipeline'] }),
        FALLBACK_ROW
      ],
      revision: REVISION,
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
      rows: [modelRow('retired-model')],
      revision: REVISION,
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
      rows: [modelRow('current-model')],
      revision: REVISION,
      phaseCatalog,
      availableModels: { claude: ['current-model'], codex: [] }
    });
    expect(result.warnings.some((entry) => entry.code === 'pipeline-model-unavailable')).toBe(false);
  });

  it('resolves an unnamed runner against the supplied default', () => {
    const result = resolvePipelineCatalog({
      rows: [row('Modelled', { id: 'modelled', executionDefaults: { model: 'retired-model' } })],
      revision: REVISION,
      phaseCatalog,
      availableModels: { claude: ['current-model'] },
      defaultRunnerKind: 'claude'
    });
    expect(result.warnings.some((entry) => entry.code === 'pipeline-model-unavailable')).toBe(true);
  });

  it('treats an absent or empty model list as unknown availability, not as unavailable', () => {
    for (const availableModels of [undefined, { claude: [] }]) {
      const result = resolvePipelineCatalog({
        rows: [modelRow('retired-model')],
        revision: REVISION,
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
  // Feature 099 (T496f, FR-044a) — was a hash per writable scope, derived here.
  // The store issues one revision for the catalog and this resolver reports it
  // back; deriving it a second time in the test would assert agreement between
  // two copies of the same computation rather than that the store's value
  // survives the trip.
  it('reports back the revision the store issued, verbatim', () => {
    const result = resolvePipelineCatalog({
      rows: [row('Stored')],
      revision: 'rev-issued-by-the-store',
      phaseCatalog
    });
    expect(result.revision).toBe('rev-issued-by-the-store');
  });

  it('freezes the resolution and its collections', () => {
    const result = resolvePipelineCatalog({ rows: [], revision: REVISION, phaseCatalog });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.effective)).toBe(true);
    expect(Object.isFrozen(result.effectivePipelineDefs)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
  });

  // Feature 099 (T496f, FR-001a) — was "resolves the built-in layer with no
  // configured layers present". Absent rows are the empty store a workspace
  // nobody has saved into presents, and the honest resolution is the empty one.
  it('resolves an absent row list as an empty catalog, not as a failure', () => {
    const result = resolvePipelineCatalog({
      rows: undefined,
      revision: REVISION,
      phaseCatalog
    });
    expect(result.effective).toEqual([]);
    expect(result.records).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.revision).toBe(REVISION);
  });
});
