// Feature 100 (FR-R3-016) T505 — the effective catalog is the set of Active
// versions (FR-007).
//
// The redefinition needs no resolver rewrite, which is exactly why it needs a
// test. `effective` has always meant "the rows that resolved", and the rows have
// always been whatever the projection handed over; FR-006 changes what the
// projection can hand over, so the redefinition happens entirely upstream of the
// three `resolve*Catalog` functions and none of them mentions a version. That is
// the right shape and an invisible one. Without this file the property is held up
// by a single `if (definition.body === null) continue;` in `snapshot-rows.ts` and
// nothing states what depends on it.
//
// What is pinned, end to end for each of the three kinds: a store holding one
// published definition and one saved-but-unpublished draft resolves to an
// effective catalog containing the published one only, and the draft's body
// appears nowhere in the resolution — not in `effective`, not in `records`, and
// not as a Pipeline a Workflow node can address (FR-008, FR-009).
//
// This is deliberately the full path — snapshot, then `storedRows`, then the
// resolver — rather than the resolver alone. Handing a resolver a pre-filtered
// row list would test the filter's caller and assume the filter, and the filter is
// the entire mechanism.

import { describe, expect, it } from 'vitest';
import { storedRows } from '../../../src/catalog';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { resolvePipelineCatalog } from '../../../src/config/pipeline-catalog';
import { resolveWorkflowCatalog } from '../../../src/config/workflow-catalog';
import type {
  CatalogKind,
  CatalogSnapshot,
  StoredDefinition
} from '../../../src/contracts/catalog-store';

const PUBLISHED = 'published-one';
const DRAFT_ONLY = 'draft-only-one';

/** A body that would resolve cleanly if the resolver were ever handed it. */
const PHASE_BODY = (id: string) => ({
  id,
  name: id,
  version: 1,
  instruction: 'Do the thing.',
  sideEffects: 'workspace',
  evidencePolicy: 'required'
});

const PIPELINE_BODY = (id: string) => ({
  id,
  name: id,
  version: 1,
  phases: ['plan']
});

const WORKFLOW_BODY = (id: string) => ({
  id,
  name: id,
  version: 1,
  nodes: [{ nodeId: 'a', pipelineId: 'standard' }],
  connections: [],
  startNodeIds: ['a']
});

/**
 * A store holding one Active definition and one that is Draft-only.
 *
 * The Draft-only entry is the whole subject: `activeVersionId` and `body` are
 * `null` because nothing has been published, while `draftVersionId` and
 * `draftBody` carry the operator's unfinished work (FR-004, FR-006). Its
 * `draftBody` is a body that WOULD resolve — a malformed one would drop out for
 * the wrong reason and the test would pass while proving nothing.
 */
function snapshotWith(kind: CatalogKind, body: (id: string) => unknown): CatalogSnapshot {
  const base = {
    kind,
    status: 'effective' as const,
    createdAt: 1,
    updatedAt: 1,
    versions: []
  };
  const definitions: readonly StoredDefinition[] = [
    {
      ...base,
      id: PUBLISHED,
      activeVersionId: 'v1',
      body: body(PUBLISHED),
      draftVersionId: null,
      draftBody: null
    },
    {
      ...base,
      id: DRAFT_ONLY,
      activeVersionId: null,
      body: null,
      draftVersionId: 'v1',
      draftBody: body(DRAFT_ONLY)
    }
  ];
  return {
    storeFormatVersion: 1,
    definitions,
    faults: [],
    collectable: [],
    revisions: { phase: 'r1', pipeline: 'r1', workflow: 'r1' }
  };
}

describe('T505 — the effective Phase catalog is the Active versions only (FR-007)', () => {
  const resolved = resolvePhaseCatalog({
    rows: storedRows(snapshotWith('phase', PHASE_BODY), 'phase'),
    revision: 'r1'
  });

  it('resolves the published Phase', () => {
    expect(resolved.effective.map((definition) => definition.phaseId)).toEqual([PUBLISHED]);
  });

  it('does not resolve the draft-only Phase', () => {
    expect(resolved.effective.some((definition) => definition.phaseId === DRAFT_ONLY)).toBe(false);
  });

  it('does not even give the draft-only Phase a source record', () => {
    // Not merely absent from `effective` but absent from `records` too. A draft is
    // not a row awaiting repair — the Builder reads it from the store's draft
    // pointer, and the resolver is never told it exists.
    expect(resolved.records.map((record) => record.phaseId)).toEqual([PUBLISHED]);
  });

  it('reports no error for the draft it never saw', () => {
    // The failure mode this rules out: a draft leaking in as an `invalid` row and
    // decorating the Builder with defects on work the operator is mid-way through.
    expect(resolved.records.flatMap((record) => record.errors)).toEqual([]);
  });
});

describe('T505 — the effective Pipeline catalog is the Active versions only (FR-007)', () => {
  const phaseCatalog = resolvePhaseCatalog({
    rows: [{ ...(PHASE_BODY('plan') as object) }],
    revision: 'r1'
  });
  const resolved = resolvePipelineCatalog({
    rows: storedRows(snapshotWith('pipeline', PIPELINE_BODY), 'pipeline'),
    revision: 'r1',
    phaseCatalog: phaseCatalog.effective
  });

  it('resolves the published Pipeline', () => {
    expect(resolved.effective.map((definition) => definition.pipelineId)).toEqual([PUBLISHED]);
  });

  it('does not resolve the draft-only Pipeline', () => {
    expect(resolved.records.map((record) => record.pipelineId)).toEqual([PUBLISHED]);
  });

  it('cannot be launched from a draft: the draft id is in neither list', () => {
    // FR-009 restated as an assertion. `effective` is what the launch surface
    // offers, `records` is what the Builder lists, and an unpublished Pipeline is
    // in neither.
    const everyId = [
      ...resolved.effective.map((definition) => definition.pipelineId),
      ...resolved.records.map((record) => record.pipelineId)
    ];
    expect(everyId).not.toContain(DRAFT_ONLY);
  });
});

describe('T505 — the effective Workflow catalog is the Active versions only (FR-007)', () => {
  const pipelineCatalog = {
    effective: [
      {
        pipelineId: 'standard',
        name: 'Standard',
        version: 1,
        phaseIds: ['plan'],
        inputs: [],
        outputs: [],
        bindings: [],
        recommendedNext: []
      }
    ],
    records: [
      {
        key: 'standard::0',
        pipelineId: 'standard',
        status: 'effective' as const,
        definition: {
          pipelineId: 'standard',
          name: 'Standard',
          version: 1,
          phaseIds: ['plan'],
          inputs: [],
          outputs: [],
          bindings: [],
          recommendedNext: []
        },
        display: {},
        errors: []
      }
    ]
  };
  const resolved = resolveWorkflowCatalog({
    rows: storedRows(snapshotWith('workflow', WORKFLOW_BODY), 'workflow'),
    revision: 'r1',
    pipelineCatalog
  });

  it('resolves the published Workflow', () => {
    expect(resolved.effective.map((definition) => definition.workflowId)).toEqual([PUBLISHED]);
  });

  it('does not resolve the draft-only Workflow', () => {
    expect(resolved.records.map((record) => record.workflowId)).toEqual([PUBLISHED]);
  });
});

describe('T505 — publication is the only way into the effective catalog', () => {
  it('the same definition resolves once its draft becomes the active version', () => {
    // The other half of the property, and the one that proves the tests above are
    // about the pointer rather than about the body: nothing changes but which
    // field holds it, and the definition appears.
    const snapshot = snapshotWith('phase', PHASE_BODY);
    const published: CatalogSnapshot = {
      ...snapshot,
      definitions: snapshot.definitions.map((definition) =>
        definition.id === DRAFT_ONLY
          ? {
              ...definition,
              activeVersionId: 'v1',
              body: definition.draftBody,
              draftVersionId: null,
              draftBody: null
            }
          : definition
      )
    };
    const resolved = resolvePhaseCatalog({
      rows: storedRows(published, 'phase'),
      revision: 'r1'
    });
    expect(resolved.effective.map((definition) => definition.phaseId).sort()).toEqual(
      [PUBLISHED, DRAFT_ONLY].sort()
    );
  });

  it('a draft body is never read by the projection the resolvers consume', () => {
    // The mechanism, asserted directly at the seam. Every kind, one statement: the
    // projection reads `body` and nothing else, so a change that fell back to
    // `draftBody` would put unpublished work in front of the runner.
    for (const [kind, body] of [
      ['phase', PHASE_BODY],
      ['pipeline', PIPELINE_BODY],
      ['workflow', WORKFLOW_BODY]
    ] as const) {
      const rows = storedRows(snapshotWith(kind, body), kind);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(DRAFT_ONLY);
    }
  });
});
