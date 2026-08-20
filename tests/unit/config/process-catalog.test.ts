import { describe, expect, it } from 'vitest';
import { phaseDefinitionToPhaseDef, resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { loadCatalog, type CatalogConfigReader } from '../../../src/config/pipeline-config-loader';
import { resolveWorkflowCatalog } from '../../../src/config/workflow-catalog';
import { EMPTY_SNAPSHOT } from '../../fixtures/catalog-snapshot-fixture';

/** The revision the store reported for this catalog. Echoed back, never derived. */
const REVISION = 'rev-phase-1';

const row = (name: string, overrides: Record<string, unknown> = {}) => ({
  id: 'shared',
  name,
  version: 1,
  instruction: name,
  runner: 'claude',
  ...overrides
});

describe('resolvePhaseCatalog', () => {
  // Feature 099 (T496f, FR-042) — three cases lived here and are gone with the
  // layer tier, each because its subject was precedence itself:
  //
  //   - 'selects workspace over user over built-in as whole rows'
  //   - 'keeps an invalid high-scope row visible and falls through'
  //   - 'marks every same-scope duplicate invalid and falls through'
  //
  // The first two assert a winner chosen among layers; with one layer there is
  // no choosing, and a rewritten "the only row wins" would pass against any
  // implementation at all. The third's surviving half — a duplicated id
  // invalidates every row claiming it — is asserted below without the
  // fall-through clause, which had nothing left to fall through to.

  it('invalidates every row claiming a duplicated id', () => {
    const result = resolvePhaseCatalog({
      rows: [row('One'), row('Two')],
      revision: REVISION
    });
    const collided = result.records.filter((record) => record.phaseId === 'shared');
    expect(collided).toHaveLength(2);
    expect(collided.every((record) => record.status === 'invalid')).toBe(true);
    // And neither is offered: a duplicated id resolves to nothing, not to one of them.
    expect(result.effective.filter((phase) => phase.phaseId === 'shared')).toHaveLength(0);
  });

  it('emits at most one effective definition per id', () => {
    const result = resolvePhaseCatalog({ rows: [row('Only')], revision: REVISION });
    expect(result.effective.filter((phase) => phase.phaseId === 'shared')).toHaveLength(1);
  });

  it('uses a non-colliding repair handle for a row without a string identity', () => {
    const result = resolvePhaseCatalog({
      rows: [
        { name: 'Broken', instruction: 'broken' },
        { id: 'invalid-1', name: 'Legitimate', instruction: 'valid' }
      ],
      revision: REVISION
    });
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phaseId: '?invalid-1', status: 'invalid' }),
        expect.objectContaining({ phaseId: 'invalid-1', status: 'effective' })
      ])
    );
  });

  // Feature 098 T018 — the rule this exercises was re-keyed from an id list onto
  // the declared containment class, so the fixture declares `sideEffects: 'git'`
  // rather than relying on `finalize` having been one of five known ids. The id
  // is retained only so the case still reads as the one it replaced; it carries
  // no authority, and a row declaring nothing under the same id and the same
  // runner is admitted (asserted in `phase-runner-policy.test.ts`).
  //
  // Feature 099 (T496f) — the case was written as a workspace row overriding a
  // built-in one, and the quarantine was read off the losing layer. The rule was
  // never about layers: `parseRows` applies it to each row on its own. So the
  // fixture is now two rows in the one catalog, which asserts the same rule AND
  // the per-row scope the old shape could not distinguish from a layer effect.
  it('quarantines a Codex runner on a Phase declaring Git side effects', () => {
    const result = resolvePhaseCatalog({
      rows: [
        {
          id: 'finalize', name: 'Custom finalize', instruction: 'commit',
          runner: 'codex', sideEffects: 'git'
        },
        {
          id: 'commit', name: 'Other finalize', instruction: 'commit',
          runner: 'claude', sideEffects: 'git'
        }
      ],
      revision: REVISION
    });
    expect(result.records.find((record) => record.phaseId === 'finalize')).toMatchObject({
      status: 'invalid',
      errors: [expect.objectContaining({ code: 'git-metadata-write-required' })]
    });
    // Quarantine is per row: the compliant row beside it still resolves.
    expect(result.effective.find((phase) => phase.phaseId === 'commit')?.runner).toBe('claude');
    expect(result.effective.find((phase) => phase.phaseId === 'finalize')).toBeUndefined();
  });

  it('reports back the revision the store issued, verbatim', () => {
    // Feature 099 (FR-044a) — replaces 'computes deterministic semantic layer
    // revisions', which pinned `phaseLayerRevision`'s key-order stability and
    // content sensitivity. The resolver no longer computes a revision; the store
    // issues one and this carries it. Recomputing the hash here would assert
    // agreement between two copies of the same computation, and would pass
    // against a value the store never issued — so the property under test is
    // that the issued string survives the trip unaltered.
    const result = resolvePhaseCatalog({
      rows: [{ id: 'a', name: 'A', instruction: 'a' }],
      revision: 'rev-issued-by-the-store'
    });
    expect(result.revision).toBe('rev-issued-by-the-store');
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
// Feature 099 (T489) — the `scope` argument and the built-in row map are gone
// with the layer tier, so the projection reads the definition and nothing else.
// Two cases went with them:
//
//   - 'prefers the definition over a built-in row that disagrees' — with no
//     second source there is nothing to prefer it over, and the surviving half
//     (both fields carried together) is 'carries both declarations together'.
//   - 'falls back to the built-in row while one still exists' — one no longer
//     can, and a fallback to nothing is what 'omits the key entirely' asserts.

describe('phaseDefinitionToPhaseDef — containment declarations survive resolution', () => {
  const definition = (overrides: Record<string, unknown> = {}) => ({
    phaseId: 'imported-phase',
    name: 'Imported Phase',
    version: 1,
    instruction: 'Do the imported thing.',
    ...overrides
  }) as Parameters<typeof phaseDefinitionToPhaseDef>[0];

  it.each(['none', 'workspace', 'git', 'unrestricted'] as const)(
    'carries a definition declaring sideEffects: %s',
    (declared) => {
      const phase = phaseDefinitionToPhaseDef(definition({ sideEffects: declared }));
      expect(phase.sideEffects).toBe(declared);
    }
  );

  it.each(['required', 'best-effort', 'none'] as const)(
    'carries a definition declaring evidencePolicy: %s',
    (declared) => {
      const phase = phaseDefinitionToPhaseDef(definition({ evidencePolicy: declared }));
      expect(phase.evidencePolicy).toBe(declared);
    }
  );

  it('carries both declarations together', () => {
    const phase = phaseDefinitionToPhaseDef(
      definition({ sideEffects: 'git', evidencePolicy: 'best-effort' })
    );
    expect(phase.sideEffects).toBe('git');
    expect(phase.evidencePolicy).toBe('best-effort');
  });

  it('omits the key entirely when the definition declares nothing', () => {
    // Absence must stay absence here: the default belongs to the freeze
    // (FR-005), and filling it in at resolution would make an omission
    // indistinguishable from a declaration one layer earlier than intended.
    const phase = phaseDefinitionToPhaseDef(definition());
    expect(phase).not.toHaveProperty('sideEffects');
    expect(phase).not.toHaveProperty('evidencePolicy');
  });
});

describe('a workspace with no operator-authored settings has four empty catalogs (T031)', () => {
  // Feature 098 (FR-010, FR-011, SC-001) — the product's own claim on the four
  // catalogs, asserted from the outside. A store nobody has saved into plus a
  // reader that answers `undefined` to every question is exactly a fresh
  // workspace: no stored definitions, nothing in user settings, nothing in
  // workspace settings. What is left is whatever the code ships, and after that
  // feature that is nothing.
  //
  // All four are asserted in one place on purpose. The Workflow layer has shipped
  // empty since feature 086 and is the existence proof the other three are
  // following, so a regression in any one of them is most legible next to the three
  // that agree.
  //
  // Feature 099 (T496f) — `getPhases`/`getPipelines` are gone from the reader
  // and the rows come from the store, so "nothing authored" is now the empty
  // snapshot plus the two surviving settings keys answering `undefined`.
  const NO_SETTINGS: CatalogConfigReader = {
    getModels: () => undefined,
    getDefaultPipelineId: () => undefined
  };

  it('resolves zero Phases and zero Pipelines, and names no default', () => {
    const loaded = loadCatalog(EMPTY_SNAPSHOT, NO_SETTINGS);

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
    const loaded = loadCatalog(EMPTY_SNAPSHOT, NO_SETTINGS);

    expect(loaded.catalog.models).toEqual({ claude: [], codex: [], agy: [] });
  });

  it('resolves zero Workflows', () => {
    const loaded = loadCatalog(EMPTY_SNAPSHOT, NO_SETTINGS);
    const workflows = resolveWorkflowCatalog({
      rows: undefined,
      revision: EMPTY_SNAPSHOT.revisions.workflow,
      pipelineCatalog: {
        effective: loaded.pipelineCatalog.effective,
        records: loaded.pipelineCatalog.records
      }
    });

    expect(workflows.effective).toEqual([]);
    expect(workflows.records).toEqual([]);
  });

  it('holds no source rows at all, not merely no effective ones', () => {
    // Distinct from the assertions above: those read the *effective* projection,
    // which a catalog whose every row resolved away would also satisfy. This
    // reads the retained source records, so a row that exists but resolves to
    // nothing still fails it.
    //
    // Feature 099 (T496f) — was 'reports every layer of every catalog as holding
    // no rows at all', reading `builtInPhases`/`userPhases`/`workspacePhases`.
    // Those three arrays were the layer tier itself; the records they fed are
    // the two read here, and reading them is what the case was ever for.
    const loaded = loadCatalog(EMPTY_SNAPSHOT, NO_SETTINGS);

    expect(loaded.phaseCatalog.records).toEqual([]);
    expect(loaded.pipelineCatalog.records).toEqual([]);
  });
});
