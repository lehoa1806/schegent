// Feature 254 (FR-R4-F07, P-T1 host half; contract P2; data-model §6; FR-014, SC-005) — a package whose
// Workflow is invalid writes nothing.
//
// `publishPackage` validates the WHOLE document, with every candidate overlaid on the catalog, before
// it takes pass 1 (`src/catalog/package-publish.ts`), so a defect anywhere means no draft is written
// for any layer. That has been true of the host since feature 100. What the webview did with it was
// the defect: it sent the layers one request at a time, so the Phase layer, valid on its own, had
// already been drafted and published by the time the Workflow layer was refused. Sending every layer
// in one request (FR-013) is only worth anything if the host's refusal really leaves the store alone,
// so this file counts the store's two write calls behind the REAL `publishPackage` and asserts zero.
//
// This is a pin, green at baseline (TA8): the host half of P-T1 needs no source change. Its webview
// half, the defects reaching their rows, is in `process-import-state.test.ts`.

import { describe, expect, it } from 'vitest';

import { publishPackage, type CatalogStore } from '../../src/catalog';
import { createDefinitionSemantics } from '../../src/config/definition-semantics';
import type { PackagePublishRequest } from '../../src/contracts/catalog-lifecycle';
import { FakeCatalogStore } from '../fixtures/fake-catalog-store';
import { phaseBody, pipelineBody, workflowBody } from '../fixtures/catalog-lifecycle-harness';

const semantics = createDefinitionSemantics({ defaultPipelineId: () => '' });

/** The fixture store behind a decorator that counts the two calls that write. */
function countingStore(inner: FakeCatalogStore): {
  readonly store: CatalogStore;
  readonly counts: { saveDraftLayer: number; publishLayer: number };
} {
  const counts = { saveDraftLayer: 0, publishLayer: 0 };
  const store: CatalogStore = {
    read: () => inner.read(),
    applyLifecycleWrite: (write) => inner.applyLifecycleWrite(write),
    saveDraftLayer: (request) => {
      counts.saveDraftLayer += 1;
      return inner.saveDraftLayer(request);
    },
    publishLayer: (request) => {
      counts.publishLayer += 1;
      return inner.publishLayer(request);
    },
    readVersion: (kind, id, versionId) => inner.readVersion(kind, id, versionId),
    listVersions: (kind, id) => inner.listVersions(kind, id),
    listDefinitions: (kind) => inner.listDefinitions(kind)
  };
  return { store, counts };
}

/** Three layers: two Phases, the Pipeline that binds them, and a Workflow over that Pipeline. */
function packageOf(
  inner: FakeCatalogStore,
  workflow: unknown
): PackagePublishRequest {
  return {
    layers: [
      {
        kind: 'phase',
        expectedRevision: inner.revisionOf('phase'),
        definitions: [
          { id: 'plan', body: phaseBody('plan') },
          { id: 'build', body: phaseBody('build') }
        ]
      },
      {
        kind: 'pipeline',
        expectedRevision: inner.revisionOf('pipeline'),
        definitions: [{ id: 'ship-it', body: pipelineBody('ship-it', ['plan', 'build']) }]
      },
      {
        kind: 'workflow',
        expectedRevision: inner.revisionOf('workflow'),
        definitions: [{ id: 'flow', body: workflow }]
      }
    ]
  };
}

describe('Feature 254 — a package with an invalid Workflow writes nothing (P-T1 host half, FR-014)', () => {
  it('is refused validation-failed with zero draft writes and zero publications', async () => {
    const inner = new FakeCatalogStore();
    const { store, counts } = countingStore(inner);
    // The Workflow starts at a node it does not declare.
    const invalid = workflowBody('flow', 'ship-it', { startNodeIds: ['ghost'] });

    const outcome = await publishPackage({ store, semantics }, packageOf(inner, invalid));

    expect(outcome.outcome).toBe('refused');
    if (outcome.outcome !== 'refused') return;
    expect(outcome.refusal.reason).toBe('validation-failed');
    expect(counts).toEqual({ saveDraftLayer: 0, publishLayer: 0 });
    // And the store itself holds nothing of the document.
    for (const kind of ['phase', 'pipeline', 'workflow'] as const) {
      expect(inner.idsOf(kind)).toEqual([]);
    }
  });

  it('reports every defect with its kind, id, field and code', async () => {
    const inner = new FakeCatalogStore();
    const { store } = countingStore(inner);
    const invalid = workflowBody('flow', 'ship-it', { startNodeIds: ['ghost'] });

    const outcome = await publishPackage({ store, semantics }, packageOf(inner, invalid));

    if (outcome.outcome !== 'refused') throw new Error('expected a refusal');
    const { defects } = outcome.refusal;
    expect(defects.length).toBeGreaterThan(0);
    for (const defect of defects) {
      expect(defect.kind).toMatch(/^(phase|pipeline|workflow)$/);
      expect(defect.id.length).toBeGreaterThan(0);
      expect(defect.field.length).toBeGreaterThan(0);
      expect(defect.code.length).toBeGreaterThan(0);
    }
    expect(defects.some((defect) => defect.kind === 'workflow' && defect.id === 'flow')).toBe(true);
    // The valid layers are not blamed for the Workflow's defect.
    expect(defects.some((defect) => defect.kind === 'phase')).toBe(false);
  });

  it('control: the same package with a valid Workflow does write (the counts are not vacuously zero)', async () => {
    const inner = new FakeCatalogStore();
    const { store, counts } = countingStore(inner);

    const outcome = await publishPackage(
      { store, semantics },
      packageOf(inner, workflowBody('flow', 'ship-it'))
    );

    expect(outcome.outcome).toBe('published');
    expect(counts.saveDraftLayer).toBe(3);
    expect(counts.publishLayer).toBe(3);
    expect(inner.idsOf('workflow')).toEqual(['flow']);
  });
});
