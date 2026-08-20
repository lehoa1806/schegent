// Feature 100 (FR-R3-016) — what retention removed on the package path is reported,
// and reported under the kind it came from (099 FR-035, FR-059).
//
// Retention deletes files. That is the one thing in the store that is not
// append-only, so the requirement that it be *reported* is not cosmetic: an
// operator whose history was trimmed learns it from the report or not at all.
//
// A package publish touches the store six times — a draft write and a publication
// per layer — and every one of those can prune. Three failure modes are possible
// and each is asserted here with the wrong implementation it exists to catch:
//
//   - **The kind is dropped.** `PrunedVersions` carries an id, and ids are unique
//     only *within* a kind, so a report without the kind names a definition that may
//     not exist. The surface then has to guess one, and a guess is a false record.
//   - **The draft pass is silent.** `saveDraftLayer` prunes and its outcome once said
//     nothing about it, so a package import that trimmed history reported none of it
//     while the single-definition save path reported all of it.
//   - **A partial reports nothing.** The layers that published before the failure
//     still pruned; a partial that omits them loses the report for good, because
//     re-running the document plans the written rows as skips and prunes nothing.
//
// Driven through the double rather than a real store because the bound is 50: the
// claim is that the report survives the two passes, not that the store counts to 51,
// which `tests/unit/catalog/catalog-retention.test.ts` already pins.

import { describe, expect, it } from 'vitest';

import { publishPackage } from '../../../src/catalog';
import { createDefinitionSemantics } from '../../../src/config/definition-semantics';
import { FakeCatalogStore } from '../../fixtures/fake-catalog-store';
import { phaseBody, pipelineBody } from '../../fixtures/catalog-lifecycle-harness';

const PHASE_ID = 'plan';
const PIPELINE_ID = 'ship-it';
const PUBLISHED_AT = 1_700_000_000_000;

const semantics = createDefinitionSemantics({ defaultPipelineId: () => '' });

/** A self-contained document: one Phase, and the Pipeline that binds it (FR-017). */
function documentFor(store: FakeCatalogStore) {
  return {
    layers: [
      {
        kind: 'phase' as const,
        definitions: [{ id: PHASE_ID, body: phaseBody(PHASE_ID) }],
        expectedRevision: store.revisionOf('phase')
      },
      {
        kind: 'pipeline' as const,
        definitions: [{ id: PIPELINE_ID, body: pipelineBody(PIPELINE_ID, [PHASE_ID]) }],
        expectedRevision: store.revisionOf('pipeline')
      }
    ]
  };
}

function publish(store: FakeCatalogStore) {
  return publishPackage({ store, semantics }, documentFor(store));
}

describe('a package publish reports what retention removed, per kind', () => {
  it('names the kind of the layer the pruned version came from', async () => {
    const store = new FakeCatalogStore();
    // The 51st publication of this Pipeline: one version goes out of history.
    store.publishLayerVerdicts.set('pipeline', {
      outcome: 'published',
      revision: 'rev-pipeline-1',
      published: [{ id: PIPELINE_ID, activeVersionId: 'v51', publishedAt: PUBLISHED_AT }],
      skipped: [],
      pruned: [{ id: PIPELINE_ID, versionIds: ['v1'] }]
    });

    const outcome = await publish(store);

    expect(outcome.outcome).toBe('published');
    if (outcome.outcome !== 'published') return;
    // `pipeline`, not `phase`: a report that guessed the kind would name a Phase
    // called `ship-it`, which the store does not hold.
    expect(outcome.pruned).toEqual([
      { kind: 'pipeline', id: PIPELINE_ID, versionIds: ['v1'] }
    ]);
  });

  it('reports what the draft pass pruned, not only the publication', async () => {
    const store = new FakeCatalogStore();
    store.draftLayerVerdicts.set('phase', {
      outcome: 'saved',
      // The revision the double will still report when pass 2 gates against it: the
      // injected verdict stands in for the write, so the double never bumped. A
      // fabricated revision would make the Phase publication stale and turn this
      // into a test about the gate.
      revision: store.revisionOf('phase'),
      versions: [{ id: PHASE_ID, versionId: 'v51' }],
      unchanged: [],
      pruned: [{ id: PHASE_ID, versionIds: ['v1'] }]
    });

    const outcome = await publish(store);

    expect(outcome.outcome).toBe('published');
    if (outcome.outcome !== 'published') return;
    // The draft write is where an *import* prunes: it appends a version per row
    // every time the document changes, whether or not the publication that follows
    // moves anything.
    expect(outcome.pruned).toEqual([{ kind: 'phase', id: PHASE_ID, versionIds: ['v1'] }]);
  });

  it('still reports it when a later layer fails to publish', async () => {
    const store = new FakeCatalogStore();
    store.publishLayerVerdicts.set('phase', {
      outcome: 'published',
      revision: 'rev-phase-1',
      published: [{ id: PHASE_ID, activeVersionId: 'v51', publishedAt: PUBLISHED_AT }],
      skipped: [],
      pruned: [{ id: PHASE_ID, versionIds: ['v1'] }]
    });
    store.publishLayerVerdicts.set('pipeline', {
      outcome: 'refused',
      reason: 'not-writable',
      id: null
    });

    const outcome = await publish(store);

    expect(outcome).toEqual({
      outcome: 'partial',
      published: [{ kind: 'phase', ids: [PHASE_ID] }],
      draftedOnly: ['pipeline'],
      failedKind: 'pipeline',
      cause: 'not-writable',
      // The Phase layer went live and trimmed its history on the way. Recovery is
      // re-running the document, which plans the written rows as skips and prunes
      // nothing — so this is the only chance to say so.
      pruned: [{ kind: 'phase', id: PHASE_ID, versionIds: ['v1'] }]
    });
  });

  it('still reports it when the draft pass fails on a later layer', async () => {
    const store = new FakeCatalogStore();
    store.draftLayerVerdicts.set('phase', {
      outcome: 'saved',
      revision: 'rev-phase-1',
      versions: [{ id: PHASE_ID, versionId: 'v51' }],
      unchanged: [],
      pruned: [{ id: PHASE_ID, versionIds: ['v1'] }]
    });
    store.draftLayerVerdicts.set('pipeline', { outcome: 'partial', wrote: [], errno: 'EIO' });

    const outcome = await publish(store);

    expect(outcome).toEqual({
      outcome: 'partial',
      // Pass 2 never started, so nothing is live — but the Phase draft write landed
      // and pruned, and that removal is as real as a publication's.
      published: [],
      draftedOnly: ['phase'],
      failedKind: 'pipeline',
      cause: 'EIO',
      pruned: [{ kind: 'phase', id: PHASE_ID, versionIds: ['v1'] }]
    });
  });

  it('reports an empty list when nothing was pruned (positive control)', async () => {
    // Without this, every assertion above would also hold for an implementation that
    // reported a hard-coded list.
    const outcome = await publish(new FakeCatalogStore());

    expect(outcome.outcome).toBe('published');
    if (outcome.outcome !== 'published') return;
    expect(outcome.pruned).toEqual([]);
    expect(outcome.published).toEqual([
      { kind: 'phase', ids: [PHASE_ID] },
      { kind: 'pipeline', ids: [PIPELINE_ID] }
    ]);
  });
});
