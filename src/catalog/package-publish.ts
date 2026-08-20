// Feature 100 (FR-R3-016) T504, T504b — one document, one confirmation.
//
// A package publish is what an imported YAML document becomes: several definitions
// of several kinds that only make sense together. Publishing them one at a time
// would ask the operator to confirm nine times and would fail eight of those nine —
// a Pipeline published before the Phases it binds has no Phases to bind (FR-040).
//
// The shape is **two ordered passes**, both Phases → Pipelines → Workflows:
//
//   1. `saveDraftLayer` per layer — writes the version records and the draft
//      pointers. Moves no active pointer, so nothing becomes triggerable here.
//   2. `publishLayer` per layer — moves the active pointers.
//
// Two passes rather than one publish per layer because of what sits between them:
// the whole document is validated once, before either pass, against the active
// catalog with every candidate overlaid on it (FR-017). Within one pass the order
// is what makes the *second* pass work — when the Pipeline layer publishes, the
// Phases it binds are already live.
//
// Each write carries its own `expectedRevision` and its own single declared intent
// (FR-036). Pass 2 cannot reuse pass 1's revision: a draft write moves the revision
// for its kind, so pass 2 gates on what pass 1 returned.
//
// **Nothing here deletes anything, on any path** (FR-038). Whichever prefix landed
// stays written and is reported (FR-037); recovery is a re-run of the same document,
// which plans the written rows as skips (FR-039).

import type {
  CandidateDefinition,
  DefinitionSemantics
} from './ports';
import type {
  PackagePublishedLayer,
  PackagePublishOutcome,
  PackagePublishRequest,
  PackageRefusal,
  PrunedVersions,
  ValidationDefect
} from '../contracts/catalog-lifecycle';
import type {
  CatalogKind,
  CatalogLayerPruned,
  PublishLayerOutcome,
  SaveDraftLayerOutcome
} from '../contracts/catalog-store';
import type { CatalogStore } from './catalog-store';

export interface PackagePublishPorts {
  readonly store: CatalogStore;
  readonly semantics: DefinitionSemantics;
}

/**
 * Phases, then Pipelines, then Workflows (FR-035).
 *
 * Declared here rather than borrowed from `CATALOG_KINDS`, whose order happens to
 * match today. This is a *dependency* order and is load-bearing in both passes; a
 * reordering of that constant for an unrelated reason must not silently become a
 * reordering of a package publish.
 *
 * A total `Record` rather than an array, so a fourth kind added to `CatalogKind`
 * stops this file compiling. An array would accept the new kind silently and sort it
 * to index -1 — ahead of the Phases everything else depends on, which is the one
 * sequence FR-035 exists to pin.
 */
const LAYER_RANK: Readonly<Record<CatalogKind, number>> = {
  phase: 0,
  pipeline: 1,
  workflow: 2
};

interface RefusalDetail {
  readonly defects?: readonly ValidationDefect[];
  readonly storeReason?: string;
}

function refusal(
  reason: PackageRefusal['reason'],
  kind: CatalogKind | null,
  detail: RefusalDetail = {}
): PackagePublishOutcome {
  const refused: PackageRefusal = {
    reason,
    kind,
    defects: detail.defects ?? [],
    ...(detail.storeReason === undefined ? {} : { storeReason: detail.storeReason })
  };
  return { outcome: 'refused', refusal: refused };
}

export async function publishPackage(
  ports: PackagePublishPorts,
  request: PackagePublishRequest
): Promise<PackagePublishOutcome> {
  const { store, semantics } = ports;

  // A layer with no definitions is dropped rather than written: an empty layer write
  // would move that kind's revision for nothing, invalidating another window's
  // in-flight gate over a document that said nothing about that kind.
  const layers = [...request.layers]
    .filter((layer) => layer.definitions.length > 0)
    .sort((left, right) => LAYER_RANK[left.kind] - LAYER_RANK[right.kind]);

  if (layers.length === 0) {
    return { outcome: 'published', published: [], pruned: [] };
  }

  const read = await store.read();
  if (read.outcome === 'unavailable') {
    return refusal('store-refused', null, { storeReason: read.fault.fault });
  }

  // Validate, then move (FR-016). The candidate set is the **whole document**, so a
  // Pipeline binding a Phase that arrives in the same import validates against what
  // the publication is about to make live rather than against what is live now
  // (FR-017). The union is a projection alive for this one call and persisted
  // nowhere (FR-018).
  const candidates: readonly CandidateDefinition[] = layers.flatMap((layer) =>
    layer.definitions.map((definition) => ({
      kind: layer.kind,
      id: definition.id,
      body: definition.body
    }))
  );
  const defects = semantics.defectsOf(read.snapshot, candidates);
  if (defects.length > 0) {
    // Every defect in the document, not the first one found (FR-019, SC-003). An
    // operator fixing an imported file wants the whole list in one pass.
    return refusal('validation-failed', null, { defects });
  }

  // ---- Pass 1: write the drafts -------------------------------------------------

  /** The revision each kind reached after its draft write — pass 2's gate. */
  const revisions = new Map<CatalogKind, string>();
  const draftedOnly: CatalogKind[] = [];

  /**
   * Everything retention removed, across both passes and every kind (FR-035).
   *
   * Accumulated across the whole operation rather than per layer because every
   * return below reports it, including the `partial` ones: a removal performed by a
   * layer that landed is not undone by a later layer failing, and a re-run of the
   * document prunes nothing (FR-039), so a report dropped here is lost.
   *
   * The store's per-layer shape carries no kind — it is answering about one layer,
   * which the caller named — so the kind is stamped on here, where the layer is
   * still in hand.
   */
  const pruned: PrunedVersions[] = [];
  const recordPruned = (kind: CatalogKind, entries: readonly CatalogLayerPruned[]): void => {
    for (const entry of entries) {
      pruned.push({ kind, id: entry.id, versionIds: entry.versionIds });
    }
  };

  for (const layer of layers) {
    const written: SaveDraftLayerOutcome = await store.saveDraftLayer({
      kind: layer.kind,
      definitions: layer.definitions.map((definition) => ({
        id: definition.id,
        body: definition.body
      })),
      expectedRevision: layer.expectedRevision
    });

    if (written.outcome === 'saved' || written.outcome === 'unchanged') {
      // `unchanged` still counts as written for pass 2's purposes: the draft already
      // holds exactly this body, which is the state a re-run after a partial finds
      // and is precisely what a re-run is meant to complete (FR-039).
      revisions.set(layer.kind, written.revision);
      draftedOnly.push(layer.kind);
      // An `unchanged` write wrote nothing, so it pruned nothing and has no field
      // for it. A `saved` one appended a version per changed row and prunes on the
      // same terms a publication does.
      if (written.outcome === 'saved') recordPruned(layer.kind, written.pruned);
      continue;
    }

    // Nothing has been published yet — pass 2 has not started — so whatever landed
    // is drafts. It stays written and is reported (FR-037, FR-038).
    if (written.outcome === 'partial') {
      return {
        outcome: 'partial',
        published: [],
        draftedOnly,
        failedKind: layer.kind,
        cause: written.errno,
        pruned
      };
    }
    if (written.outcome === 'stale') {
      return draftedOnly.length === 0
        ? refusal('stale-layer', layer.kind)
        : {
            outcome: 'partial',
            published: [],
            draftedOnly,
            failedKind: layer.kind,
            cause: 'stale',
            pruned
          };
    }
    return draftedOnly.length === 0
      ? refusal('store-refused', layer.kind, { storeReason: written.reason })
      : {
          outcome: 'partial',
          published: [],
          draftedOnly,
          failedKind: layer.kind,
          cause: written.reason,
          pruned
        };
  }

  // ---- Pass 2: move the active pointers -----------------------------------------

  const published: PackagePublishedLayer[] = [];

  for (const layer of layers) {
    // Exactly the ids this operation wrote, and no others (FR-039a). A row an
    // importer planned as a skip never reaches this request, so an operator's
    // pre-existing unpublished draft cannot be published as a side effect.
    const ids = layer.definitions.map((definition) => definition.id);
    const expectedRevision = revisions.get(layer.kind);
    if (expectedRevision === undefined) {
      // Unreachable: pass 1 records a revision for every layer it did not return on.
      return {
        outcome: 'partial',
        published,
        draftedOnly: remaining(draftedOnly, published),
        failedKind: layer.kind,
        cause: 'no-revision',
        pruned
      };
    }

    const moved: PublishLayerOutcome = await store.publishLayer({
      kind: layer.kind,
      ids,
      expectedRevision
    });

    if (moved.outcome !== 'published') {
      // A layer refused after an earlier one published. The earlier one stays live
      // and this one stays a draft; no pointer is rolled back and no record is
      // removed (FR-038).
      return {
        outcome: 'partial',
        published,
        draftedOnly: remaining(draftedOnly, published),
        failedKind: layer.kind,
        cause: moved.outcome === 'stale' ? 'stale' : moved.reason,
        pruned
      };
    }

    published.push({ kind: layer.kind, ids: moved.published.map((entry) => entry.id) });
    recordPruned(layer.kind, moved.pruned);
  }

  return { outcome: 'published', published, pruned };
}

/** The layers that were drafted and have not published yet. */
function remaining(
  drafted: readonly CatalogKind[],
  published: readonly PackagePublishedLayer[]
): readonly CatalogKind[] {
  const live = new Set(published.map((layer) => layer.kind));
  return drafted.filter((kind) => !live.has(kind));
}
