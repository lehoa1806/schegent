// Feature 101 (FR-R3-017) T010 — the ten invariants of
// `specs/101-builder-surface/contracts/builder-projection.md` §A.2, asserted
// against all three catalog projections rather than against the lookup builder
// alone.
//
// The builder is one module and the fill sites are three, so a test that only
// exercised `buildBuilderLifecycleByKind` would pass on the day a projection
// forgot to spread `lifecycle` into its record — which is the actual failure
// this feature can have. Each invariant therefore runs over the projected
// records of every kind, driven by one table.
//
// The Builder is where an operator decides whether a definition is live. A badge
// that says Active on a definition with nothing published, or a history panel
// missing the version that is actually running, is a wrong answer to that
// question and not a cosmetic defect — which is why these are contract tests.

import { describe, expect, it } from 'vitest';
import type {
  CatalogVersionMetadata,
  StoredDefinition
} from '../../../../src/contracts/catalog-store';
import type { PhaseDefinition, PhaseSourceRecord } from '../../../../src/contracts/process-definitions';
import type {
  PipelineDefinition,
  PipelineSourceRecord
} from '../../../../src/contracts/pipeline-definitions';
import type {
  WorkflowDefinition,
  WorkflowSourceRecord
} from '../../../../src/contracts/workflow-definitions';
import type { ResolvedPhaseCatalog } from '../../../../src/config/process-catalog';
import type { ResolvedPipelineCatalog } from '../../../../src/config/pipeline-catalog';
import { buildBuilderLifecycleByKind } from '../../../../src/ui/sidebar/builder-lifecycle';
import { composePhaseCatalogProjection } from '../../../../src/ui/sidebar/phase-catalog-projection';
import { composePipelineCatalogProjection } from '../../../../src/ui/sidebar/pipeline-catalog-projection';
import { composeWorkflowCatalogProjection } from '../../../../src/ui/sidebar/workflow-catalog-projector';
import type { BuilderLifecycle } from '../../../../src/ui/sidebar/snapshot';

const WORKSPACE_ROOT = '/Users/operator/workspaces/some-project';
const identity = (value: string): string => value;

// ---------------------------------------------------------------------------
// Store fixtures: one definition per lifecycle state, per kind.
// ---------------------------------------------------------------------------

/**
 * Versions are written oldest-first, as the manifest holds them (099 FR-018).
 * The projection reverses; invariant 6 is what pins that it did.
 */
function version(
  versionId: string,
  createdAt: number,
  publishedAt: number | null,
  note: string | null = null
): CatalogVersionMetadata {
  return {
    versionId,
    contentHash: `sha256:${versionId.padEnd(64, '0')}`,
    createdAt,
    publishedAt,
    note
  };
}

interface DefinitionSpec {
  readonly id: string;
  readonly activeVersionId: string | null;
  readonly draftVersionId: string | null;
  readonly body: unknown | null;
  readonly draftBody: unknown | null;
  readonly versions: readonly CatalogVersionMetadata[];
}

/** A draft that was never published: no active pointer, no active body. */
const DRAFT_ONLY: DefinitionSpec = {
  id: 'never-published',
  activeVersionId: null,
  draftVersionId: 'v-draft-1',
  body: null,
  draftBody: { name: 'Never Published', note: 'first pass' },
  versions: [version('v-draft-1', 1_000, null, 'first pass')]
};

/** Published, nothing pending. Two versions so ordering is observable. */
const ACTIVE_ONLY: DefinitionSpec = {
  id: 'published-clean',
  activeVersionId: 'v-active-2',
  draftVersionId: null,
  body: { name: 'Published Clean', phaseIds: ['plan', 'build'] },
  draftBody: null,
  versions: [version('v-active-1', 2_000, 2_100), version('v-active-2', 3_000, 3_100)]
};

/** Published with a pending draft — the only state that carries `changedFields`. */
const ACTIVE_WITH_DRAFT: DefinitionSpec = {
  id: 'published-with-draft',
  activeVersionId: 'v-live',
  draftVersionId: 'v-pending',
  body: { name: 'Published With Draft', phaseIds: ['plan', 'build'] },
  draftBody: { name: 'Published With Draft', phaseIds: ['plan', 'build', 'ship'] },
  versions: [version('v-live', 4_000, 4_100), version('v-pending', 5_000, null, 'add ship')]
};

const SPECS: readonly DefinitionSpec[] = [DRAFT_ONLY, ACTIVE_ONLY, ACTIVE_WITH_DRAFT];

function storedDefinition(kind: StoredDefinition['kind'], spec: DefinitionSpec): StoredDefinition {
  return {
    kind,
    id: spec.id,
    status: 'effective',
    activeVersionId: spec.activeVersionId,
    body: spec.body,
    draftVersionId: spec.draftVersionId,
    draftBody: spec.draftBody,
    createdAt: 1_000,
    updatedAt: 6_000,
    versions: spec.versions
  };
}

const DEFINITIONS: readonly StoredDefinition[] = [
  ...SPECS.map((spec) => storedDefinition('phase', spec)),
  ...SPECS.map((spec) => storedDefinition('pipeline', spec)),
  ...SPECS.map((spec) => storedDefinition('workflow', spec))
];

const LIFECYCLE = buildBuilderLifecycleByKind(DEFINITIONS);

// ---------------------------------------------------------------------------
// Catalog fixtures: one source record per stored definition, per kind.
//
// A draft-only definition has no active body and therefore no resolved row of
// its own (100 FR-021, `storedRows` skips it). The Builder still lists it — that
// is US6 — but the row it lists is not produced here, so this table covers the
// two states a resolver does emit and invariant 0 is asserted over those.
// ---------------------------------------------------------------------------

const RESOLVED: readonly DefinitionSpec[] = [ACTIVE_ONLY, ACTIVE_WITH_DRAFT];

const phaseDefinition = (id: string): PhaseDefinition => ({
  phaseId: id,
  name: `Phase ${id}`,
  version: 1,
  instruction: 'do the thing'
});

const phaseRecord = (spec: DefinitionSpec, index: number): PhaseSourceRecord => ({
  key: `${spec.id}::${String(index)}`,
  phaseId: spec.id,
  status: 'effective',
  definition: phaseDefinition(spec.id),
  display: {},
  errors: []
});

const PHASE_CATALOG: ResolvedPhaseCatalog = {
  records: RESOLVED.map(phaseRecord),
  effective: RESOLVED.map((spec) => phaseDefinition(spec.id)),
  effectivePhaseDefs: [],
  revision: 'rev-phase',
  warnings: []
};

const pipelineDefinition = (id: string): PipelineDefinition => ({
  pipelineId: id,
  name: `Pipeline ${id}`,
  version: 1,
  phaseIds: [ACTIVE_ONLY.id],
  inputs: [],
  outputs: [],
  bindings: [],
  recommendedNext: []
});

const pipelineRecord = (spec: DefinitionSpec, index: number): PipelineSourceRecord => ({
  key: `${spec.id}::${String(index)}`,
  pipelineId: spec.id,
  status: 'effective',
  definition: pipelineDefinition(spec.id),
  display: {},
  errors: []
});

const PIPELINE_CATALOG: ResolvedPipelineCatalog = {
  records: RESOLVED.map(pipelineRecord),
  effective: RESOLVED.map((spec) => pipelineDefinition(spec.id)),
  effectivePipelineDefs: [],
  revision: 'rev-pipeline',
  warnings: []
};

const workflowDefinition = (id: string): WorkflowDefinition => ({
  workflowId: id,
  name: `Workflow ${id}`,
  version: 1,
  nodes: [],
  connections: [],
  startNodeIds: []
});

/**
 * The Workflow composer swallows a throw into `state: 'error'` with no records
 * (C9), which is right for a host whose catalog resolution failed and wrong for
 * a test whose fixture is malformed — the second reads as the first. Rethrowing
 * makes a fixture defect a failure here rather than four "no projected record"
 * assertions pointing at the wrong thing.
 */
const rethrow = (message: string): never => {
  throw new Error(message);
};

const workflowRecord = (spec: DefinitionSpec, index: number): WorkflowSourceRecord => ({
  key: `${spec.id}::${String(index)}`,
  workflowId: spec.id,
  status: 'effective',
  definition: workflowDefinition(spec.id),
  display: {},
  nodePipelineIds: [],
  errors: []
});

const WORKFLOW_CATALOG = {
  records: RESOLVED.map(workflowRecord),
  effective: RESOLVED.map((spec) => workflowDefinition(spec.id)),
  revision: 'rev-workflow',
  warnings: []
};

// ---------------------------------------------------------------------------
// One table, three kinds. Every invariant below runs over all of it.
// ---------------------------------------------------------------------------

interface ProjectedRecord {
  readonly id: string;
  readonly lifecycle?: BuilderLifecycle;
}

interface Kind {
  readonly name: string;
  /** With the store wired. */
  readonly records: () => readonly ProjectedRecord[];
  /** Without it — the host that resolved a catalog but has no manifest behind it. */
  readonly recordsWithoutStore: () => readonly ProjectedRecord[];
}

const KINDS: readonly Kind[] = [
  {
    name: 'phase',
    records: () =>
      composePhaseCatalogProjection(PHASE_CATALOG, {
        sanitize: identity,
        availableModels: { claude: [], codex: [], agy: [] },
        defaultRunnerKind: 'claude',
        lifecycle: LIFECYCLE.phase
      })!.records.map((record) => ({ id: record.phaseId, ...record })),
    recordsWithoutStore: () =>
      composePhaseCatalogProjection(PHASE_CATALOG, {
        sanitize: identity,
        availableModels: { claude: [], codex: [], agy: [] },
        defaultRunnerKind: 'claude'
      })!.records.map((record) => ({ id: record.phaseId, ...record }))
  },
  {
    name: 'pipeline',
    records: () =>
      composePipelineCatalogProjection(() => PIPELINE_CATALOG, {
        sanitize: identity,
        availableModels: { claude: [], codex: [], agy: [] },
        defaultRunnerKind: 'claude',
        lifecycle: LIFECYCLE.pipeline
      })!.records.map((record) => ({ id: record.pipelineId, ...record })),
    recordsWithoutStore: () =>
      composePipelineCatalogProjection(() => PIPELINE_CATALOG, {
        sanitize: identity,
        availableModels: { claude: [], codex: [], agy: [] },
        defaultRunnerKind: 'claude'
      })!.records.map((record) => ({ id: record.pipelineId, ...record }))
  },
  {
    name: 'workflow',
    records: () =>
      composeWorkflowCatalogProjection(
        {
          getWorkflowCatalog: () => WORKFLOW_CATALOG,
          getBuilderLifecycle: () => LIFECYCLE
        },
        identity,
        rethrow
      )!.records.map((record) => ({ id: record.workflowId, ...record })),
    recordsWithoutStore: () =>
      composeWorkflowCatalogProjection(
        { getWorkflowCatalog: () => WORKFLOW_CATALOG },
        identity,
        rethrow
      )!.records.map((record) => ({ id: record.workflowId, ...record }))
  }
];

function lifecycleOf(records: readonly ProjectedRecord[], id: string): BuilderLifecycle {
  const record = records.find((candidate) => candidate.id === id);
  expect(record, `no projected record for ${id}`).toBeDefined();
  expect(record!.lifecycle, `no lifecycle on ${id}`).toBeDefined();
  return record!.lifecycle!;
}

describe.each(KINDS)('builder projection invariants — $name', (kind) => {
  it('0: attaches lifecycle to every record, or to none at all', () => {
    const wired = kind.records();
    expect(wired.length).toBe(RESOLVED.length);
    expect(wired.every((record) => record.lifecycle !== undefined)).toBe(true);

    const unwired = kind.recordsWithoutStore();
    expect(unwired.length).toBe(RESOLVED.length);
    expect(unwired.every((record) => record.lifecycle === undefined)).toBe(true);
  });

  it('1: state is the shared oracle, not a local reading of the pointers', () => {
    const records = kind.records();
    expect(lifecycleOf(records, ACTIVE_ONLY.id).state).toBe('active');
    expect(lifecycleOf(records, ACTIVE_WITH_DRAFT.id).state).toBe('active-with-draft');
  });

  it('2: activeVersionId is the stored id, and is a key that is absent when null', () => {
    const lifecycle = lifecycleOf(kind.records(), ACTIVE_ONLY.id);
    expect(lifecycle.activeVersionId).toBe(ACTIVE_ONLY.activeVersionId);
    // The draft-only case has no resolved row here, so the rule is asserted at
    // the builder: absent as a key, never `''` and never `null`.
    const draftOnly = buildBuilderLifecycleByKind(DEFINITIONS)[
      kind.name as 'phase' | 'pipeline' | 'workflow'
    ](DRAFT_ONLY.id)!;
    expect('activeVersionId' in draftOnly).toBe(false);
  });

  it('3: activeVersionId is undefined exactly when the state is draft', () => {
    const lookup = LIFECYCLE[kind.name as 'phase' | 'pipeline' | 'workflow'];
    for (const spec of SPECS) {
      const lifecycle = lookup(spec.id)!;
      expect(lifecycle.activeVersionId === undefined).toBe(lifecycle.state === 'draft');
    }
  });

  it('4: versions is non-empty for every definition, in every state', () => {
    const lookup = LIFECYCLE[kind.name as 'phase' | 'pipeline' | 'workflow'];
    for (const spec of SPECS) {
      expect(lookup(spec.id)!.versions.length).toBeGreaterThan(0);
    }
  });

  it('5: exactly one version is active when a pointer is present, none when it is not', () => {
    const lookup = LIFECYCLE[kind.name as 'phase' | 'pipeline' | 'workflow'];
    for (const spec of SPECS) {
      const lifecycle = lookup(spec.id)!;
      const active = lifecycle.versions.filter((entry) => entry.isActive);
      expect(active.length).toBe(lifecycle.activeVersionId === undefined ? 0 : 1);
      if (lifecycle.activeVersionId !== undefined) {
        expect(active[0]!.versionId).toBe(lifecycle.activeVersionId);
      }
    }
  });

  it('6: versions are newest-first — the surface does not sort', () => {
    const lifecycle = lifecycleOf(kind.records(), ACTIVE_ONLY.id);
    expect(lifecycle.versions.map((entry) => entry.versionId)).toEqual([
      'v-active-2',
      'v-active-1'
    ]);
    const times = lifecycle.versions.map((entry) => entry.createdAt);
    expect(times).toEqual([...times].sort((left, right) => right - left));
  });

  it('7: changedFields is present exactly for active-with-draft', () => {
    const lookup = LIFECYCLE[kind.name as 'phase' | 'pipeline' | 'workflow'];
    for (const spec of SPECS) {
      const lifecycle = lookup(spec.id)!;
      expect('changedFields' in lifecycle).toBe(lifecycle.state === 'active-with-draft');
    }
    expect(lookup(ACTIVE_WITH_DRAFT.id)!.changedFields).toEqual({
      kind: 'changed',
      fields: [
        { field: 'phaseIds', change: 'collection', added: ['ship'], removed: [], reordered: [] }
      ]
    });
  });

  it('8: no contentHash and no version body reaches the projection', () => {
    const serialized = JSON.stringify(kind.records());
    expect(serialized).not.toContain('contentHash');
    expect(serialized).not.toContain('sha256:');
    // The bodies are what the version records hold; only their ids may travel.
    expect(serialized).not.toContain('Published Clean');
    expect(serialized).not.toContain('Published With Draft');
  });

  it('9: no workspace path reaches the projection', () => {
    const serialized = JSON.stringify(kind.records());
    expect(serialized).not.toContain(WORKSPACE_ROOT);
    expect(serialized).not.toContain('/definitions/');
    expect(serialized).not.toContain('.schegent');
  });
});

describe('builder lifecycle lookup', () => {
  it('keys by kind, so one id in two kinds gets two answers', () => {
    // `published-clean` exists in all three kinds with the same id. If the lookup
    // were built over one flat index the last kind written would answer for all
    // three, and a Pipeline would show a Phase's version history.
    const shared: readonly StoredDefinition[] = [
      storedDefinition('phase', ACTIVE_ONLY),
      { ...storedDefinition('pipeline', ACTIVE_ONLY), activeVersionId: 'v-active-1' }
    ];
    const byKind = buildBuilderLifecycleByKind(shared);
    expect(byKind.phase(ACTIVE_ONLY.id)!.activeVersionId).toBe('v-active-2');
    expect(byKind.pipeline(ACTIVE_ONLY.id)!.activeVersionId).toBe('v-active-1');
    expect(byKind.workflow(ACTIVE_ONLY.id)).toBeUndefined();
  });

  it('answers undefined for an id the store does not hold', () => {
    expect(LIFECYCLE.phase('no-such-definition')).toBeUndefined();
  });

  it('projects the draft token, folded once, never the raw pointer', () => {
    // FR-012 — what a lifecycle write echoes back. `no-draft` for a definition
    // with no draft is the fold the webview must never repeat, and the raw
    // `draftVersionId` is deliberately absent so it cannot.
    expect(LIFECYCLE.phase(ACTIVE_ONLY.id)!.expectedDraftVersion).toBe('no-draft');
    expect(LIFECYCLE.phase(ACTIVE_WITH_DRAFT.id)!.expectedDraftVersion).toBe('v-pending');
    expect(LIFECYCLE.phase(DRAFT_ONLY.id)!.expectedDraftVersion).toBe('v-draft-1');
    expect('draftVersionId' in LIFECYCLE.phase(ACTIVE_WITH_DRAFT.id)!).toBe(false);
  });
});
