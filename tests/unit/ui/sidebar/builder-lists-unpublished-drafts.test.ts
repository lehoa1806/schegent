// BUG-001 (101) — a definition saved and never published must stay in the Builder's
// Library (101 US1 AS1/AS3, US2 AS3).
//
// The defect this pins, reported for all three kinds: creating a definition in
// the Builder and pressing Save made the row VANISH. A Builder save writes a
// *draft* of one definition (101 FR-026a), and a brand-new definition has no
// active version, so its manifest entry is `activeVersionId: null, body: null`.
// `storedRows` skips a null body, so the definition produced no source row, no
// source record, and no projected record — while the draft write did move the
// kind's derived revision, so the webview re-adopted `catalog.records` and
// replaced the row the operator had just saved with nothing. The operator was
// told the save succeeded and watched their work disappear.
//
// The two properties are asserted together, in one file, because either alone is
// satisfiable by a wrong fix: listing the draft is worthless if it also becomes
// launchable (100 FR-009, hard rule 64), and keeping it out of the effective
// catalog is what `effective-is-active-only.test.ts` already covers. What is new
// here is that the row EXISTS and is badged `draft`.
//
// The path is deliberately end to end — snapshot, then the selectors, then the
// resolver, then the host→webview projection — because every one of those four
// layers dropped the definition and a test entering half way would assume the
// half that was broken.

import { describe, expect, it } from 'vitest';
import { storedDraftOnlyRows, storedRows } from '../../../../src/catalog';
import { resolvePhaseCatalog } from '../../../../src/config/process-catalog';
import { resolvePipelineCatalog } from '../../../../src/config/pipeline-catalog';
import { resolveWorkflowCatalog } from '../../../../src/config/workflow-catalog';
import { buildBuilderLifecycleByKind } from '../../../../src/ui/sidebar/builder-lifecycle';
import { composePhaseCatalogProjection } from '../../../../src/ui/sidebar/phase-catalog-projection';
import { projectPipelineCatalog } from '../../../../src/ui/sidebar/pipeline-catalog-projection';
import { projectWorkflowCatalog } from '../../../../src/ui/sidebar/workflow-catalog-projector';
import { buildLaunchProjection } from '../../../../src/ui/sidebar/launch-projection';
import type { CatalogSnapshot, StoredDefinition } from '../../../../src/contracts/catalog-store';

const identity = (value: string): string => value;
const MODELS = { claude: [], codex: [], agy: [] } as const;

const PUBLISHED_PHASE = 'plan';
const DRAFT_PHASE = 'new-phase';
const PUBLISHED_PIPELINE = 'standard';
const DRAFT_PIPELINE = 'new-pipeline';
const PUBLISHED_WORKFLOW = 'main';
const DRAFT_WORKFLOW = 'new-workflow';

const phaseBody = (id: string) => ({
  id,
  name: `Phase ${id}`,
  version: 1,
  instruction: 'Do the thing.',
  sideEffects: 'workspace',
  evidencePolicy: 'required'
});

const pipelineBody = (id: string) => ({
  id,
  name: `Pipeline ${id}`,
  version: 1,
  phases: [PUBLISHED_PHASE]
});

const workflowBody = (id: string) => ({
  id,
  name: `Workflow ${id}`,
  version: 1,
  nodes: [{ nodeId: 'a', pipelineId: PUBLISHED_PIPELINE }],
  connections: [],
  startNodeIds: ['a']
});

/**
 * An entry the operator has published: an active pointer and an active body.
 *
 * `versions` carries the one version so the lifecycle projection has something to
 * mark active — an empty list would make invariant 6 vacuous here.
 */
function active(kind: StoredDefinition['kind'], id: string, body: unknown): StoredDefinition {
  return {
    kind,
    id,
    status: 'effective',
    activeVersionId: 'v1',
    body,
    draftVersionId: null,
    draftBody: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    versions: [
      { versionId: 'v1', contentHash: `sha256:${'1'.repeat(64)}`, createdAt: 1_000, publishedAt: 1_100, note: null }
    ]
  };
}

/**
 * The subject: saved once, never published (100 FR-004, FR-006).
 *
 * `body` and `activeVersionId` are `null` because publication is the only thing
 * that sets them, and the `draftBody` is one that WOULD resolve cleanly — a
 * malformed one would be absent for the wrong reason and the test would pass
 * while proving nothing.
 */
function draftOnly(kind: StoredDefinition['kind'], id: string, body: unknown): StoredDefinition {
  return {
    kind,
    id,
    status: 'effective',
    activeVersionId: null,
    body: null,
    draftVersionId: 'v1',
    draftBody: body,
    createdAt: 2_000,
    updatedAt: 2_000,
    versions: [
      { versionId: 'v1', contentHash: `sha256:${'2'.repeat(64)}`, createdAt: 2_000, publishedAt: null, note: null }
    ]
  };
}

/** One store holding a published and an unpublished definition of every kind. */
const SNAPSHOT: CatalogSnapshot = {
  storeFormatVersion: 1,
  definitions: [
    active('phase', PUBLISHED_PHASE, phaseBody(PUBLISHED_PHASE)),
    draftOnly('phase', DRAFT_PHASE, phaseBody(DRAFT_PHASE)),
    active('pipeline', PUBLISHED_PIPELINE, pipelineBody(PUBLISHED_PIPELINE)),
    draftOnly('pipeline', DRAFT_PIPELINE, pipelineBody(DRAFT_PIPELINE)),
    active('workflow', PUBLISHED_WORKFLOW, workflowBody(PUBLISHED_WORKFLOW)),
    draftOnly('workflow', DRAFT_WORKFLOW, workflowBody(DRAFT_WORKFLOW))
  ],
  faults: [],
  collectable: [],
  revisions: { phase: 'r-phase', pipeline: 'r-pipeline', workflow: 'r-workflow' }
};

const LIFECYCLE = buildBuilderLifecycleByKind(SNAPSHOT.definitions);

const PHASE_CATALOG = resolvePhaseCatalog({
  rows: storedRows(SNAPSHOT, 'phase'),
  draftOnlyRows: storedDraftOnlyRows(SNAPSHOT, 'phase'),
  revision: SNAPSHOT.revisions.phase
});

const PIPELINE_CATALOG = resolvePipelineCatalog({
  rows: storedRows(SNAPSHOT, 'pipeline'),
  draftOnlyRows: storedDraftOnlyRows(SNAPSHOT, 'pipeline'),
  revision: SNAPSHOT.revisions.pipeline,
  phaseCatalog: PHASE_CATALOG.effective
});

const WORKFLOW_CATALOG = resolveWorkflowCatalog({
  rows: storedRows(SNAPSHOT, 'workflow'),
  draftOnlyRows: storedDraftOnlyRows(SNAPSHOT, 'workflow'),
  revision: SNAPSHOT.revisions.workflow,
  pipelineCatalog: PIPELINE_CATALOG
});

const PHASE_PROJECTION = composePhaseCatalogProjection(PHASE_CATALOG, {
  sanitize: identity,
  availableModels: MODELS,
  defaultRunnerKind: 'claude',
  lifecycle: LIFECYCLE.phase
})!;

const PIPELINE_PROJECTION = projectPipelineCatalog(PIPELINE_CATALOG, {
  sanitize: identity,
  availableModels: MODELS,
  defaultRunnerKind: 'claude',
  lifecycle: LIFECYCLE.pipeline
});

const WORKFLOW_PROJECTION = projectWorkflowCatalog(WORKFLOW_CATALOG, {
  sanitize: identity,
  effectivePipelines: PIPELINE_CATALOG.effective,
  lifecycle: LIFECYCLE.workflow
});

interface Kind {
  readonly name: string;
  readonly publishedId: string;
  readonly draftId: string;
  readonly ids: () => readonly string[];
  readonly effectiveIds: () => readonly string[];
  readonly recordOf: (id: string) => {
    readonly key: string;
    readonly status: string;
    readonly display: Readonly<Record<string, unknown>>;
    readonly errors: readonly unknown[];
    readonly lifecycle?: { readonly state: string; readonly activeVersionId?: string; readonly expectedDraftVersion: string };
  };
  readonly resolvedRecordIds: () => readonly string[];
  readonly warnings: () => readonly { readonly code: string }[];
}

const KINDS: readonly Kind[] = [
  {
    name: 'phase',
    publishedId: PUBLISHED_PHASE,
    draftId: DRAFT_PHASE,
    ids: () => PHASE_PROJECTION.records.map((record) => record.phaseId),
    effectiveIds: () => PHASE_PROJECTION.effective.map((definition) => definition.phaseId),
    recordOf: (id) => PHASE_PROJECTION.records.find((record) => record.phaseId === id)!,
    resolvedRecordIds: () => PHASE_CATALOG.records.map((record) => record.phaseId),
    warnings: () => PHASE_CATALOG.warnings
  },
  {
    name: 'pipeline',
    publishedId: PUBLISHED_PIPELINE,
    draftId: DRAFT_PIPELINE,
    ids: () => PIPELINE_PROJECTION.records.map((record) => record.pipelineId),
    effectiveIds: () => PIPELINE_PROJECTION.effective.map((definition) => definition.pipelineId),
    recordOf: (id) => PIPELINE_PROJECTION.records.find((record) => record.pipelineId === id)!,
    resolvedRecordIds: () => PIPELINE_CATALOG.records.map((record) => record.pipelineId),
    warnings: () => PIPELINE_CATALOG.warnings
  },
  {
    name: 'workflow',
    publishedId: PUBLISHED_WORKFLOW,
    draftId: DRAFT_WORKFLOW,
    ids: () => WORKFLOW_PROJECTION.records.map((record) => record.workflowId),
    effectiveIds: () => WORKFLOW_PROJECTION.effective.map((definition) => definition.workflowId),
    recordOf: (id) => WORKFLOW_PROJECTION.records.find((record) => record.workflowId === id)!,
    resolvedRecordIds: () => WORKFLOW_CATALOG.records.map((record) => record.workflowId),
    warnings: () => WORKFLOW_CATALOG.warnings
  }
];

describe.each(KINDS)('BUG-001 (101) — an unpublished save stays listed — $name', (kind) => {
  it('lists the never-published definition in the Builder', () => {
    // THE BUG, in one assertion. Before the fix this array held the published id
    // alone and the operator's saved work was simply gone from the surface.
    expect(kind.ids()).toContain(kind.draftId);
  });

  it('keeps the published definition listed beside it', () => {
    expect(kind.ids()).toContain(kind.publishedId);
  });

  it('badges it Draft, with no active version to show', () => {
    // 101 US1 AS3 — the Draft badge and the em-dash active-version cell are both
    // read off `lifecycle`, so the row is useless without it.
    const lifecycle = kind.recordOf(kind.draftId).lifecycle;
    expect(lifecycle?.state).toBe('draft');
    expect(lifecycle?.activeVersionId).toBeUndefined();
  });

  it('carries the draft token the next save must echo', () => {
    // Without this the row renders and Save is ungated: 101 FR-039's staleness
    // check needs the token that the draft pointer currently holds.
    expect(kind.recordOf(kind.draftId).lifecycle?.expectedDraftVersion).toBe('v1');
  });

  it('reports the row as valid, not as a row awaiting repair', () => {
    // `status` is a VALIDITY badge and `lifecycle.state` is the lifecycle; a clean
    // draft is `effective` on the first and `draft` on the second. Reporting it
    // `invalid` would decorate work in progress with defects it does not have.
    expect(kind.recordOf(kind.draftId).status).toBe('effective');
    expect(kind.recordOf(kind.draftId).errors).toEqual([]);
  });

  it('keys it apart from every resolved row', () => {
    // The Builder's `{#each}` is keyed on this, and two rows sharing a key is a
    // render error rather than a wrong badge.
    const keys = [kind.publishedId, kind.draftId].map((id) => kind.recordOf(id).key);
    expect(new Set(keys).size).toBe(2);
    expect(kind.recordOf(kind.draftId).key.startsWith('draft::')).toBe(true);
  });

  it('shows the draft body, not an empty row', () => {
    expect(kind.recordOf(kind.draftId).display.name).toBe(
      kind.name === 'phase'
        ? `Phase ${DRAFT_PHASE}`
        : kind.name === 'pipeline'
          ? `Pipeline ${DRAFT_PIPELINE}`
          : `Workflow ${DRAFT_WORKFLOW}`
    );
  });

  it('does not put it in the effective catalog (100 FR-007, FR-009)', () => {
    expect(kind.effectiveIds()).toEqual([kind.publishedId]);
  });

  it('does not put it in the resolver record list the launch and export paths read', () => {
    // The draft row is a Builder row. `records` on the RESOLUTION is what
    // `launch-projection`, `definition-semantics`, `preflight-service` and
    // `export-service` read, and an unpublished definition must be absent there.
    expect(kind.resolvedRecordIds()).toEqual([kind.publishedId]);
  });

  it('adds no catalog warning for work in progress', () => {
    expect(kind.warnings()).toEqual([]);
  });
});

describe('BUG-001 (101) — listing a draft does not make it launchable (hard rule 64)', () => {
  const launch = buildLaunchProjection(PIPELINE_PROJECTION, WORKFLOW_PROJECTION)!;

  it('offers the published Pipeline only', () => {
    expect(launch.pipelines.state).toBe('entries');
    expect(
      launch.pipelines.state === 'entries' ? launch.pipelines.entries.map((entry) => entry.id) : []
    ).toEqual([PUBLISHED_PIPELINE]);
  });

  it('offers the published Workflow only', () => {
    expect(
      launch.workflows.state === 'entries' ? launch.workflows.entries.map((entry) => entry.id) : []
    ).toEqual([PUBLISHED_WORKFLOW]);
  });
});
