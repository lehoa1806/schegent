// Feature 100 (FR-R3-016) T504, T504b, updated by FR-R5-F01 (T06) — one document, one confirmation.
//
// A package publish is what an imported YAML document becomes: several definitions
// of several kinds that only make sense together.
//
// The shape is **two ordered passes**, Phases → Workflows (with topological child-first
// ordering inside the Workflow layer):
//
//   1. `saveDraftLayer` per layer — writes the version records and the draft
//      pointers. Moves no active pointer, so nothing becomes triggerable here.
//   2. `publishLayer` per layer — moves the active pointers.
//
// Two passes rather than one publish per layer because of what sits between them:
// the whole document is validated once, before either pass, against the active
// catalog with every candidate overlaid on it (FR-017).

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
  CatalogLayerDefinition,
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
 * Phases, then Workflows (FR-035, FR-R5-F01 FR-012).
 *
 * A total `Record` rather than an array, so a third kind added to `CatalogKind`
 * stops this file compiling.
 */
const LAYER_RANK: Readonly<Record<CatalogKind, number>> = {
  phase: 0,
  pipeline: 1,
  workflow: 2
};

function referencedChildWorkflowIds(body: unknown): readonly string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  const nodes = (body as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return [];
  const ids: string[] = [];
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) continue;
    const raw = (node as Record<string, unknown>).workflowId;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      ids.push(raw.trim());
    }
  }
  return ids;
}

/**
 * Topologically orders candidate definitions within the `workflow` layer so child
 * Workflows precede parent Workflows that reference them (FR-R5-F01, FR-012).
 */
function orderLayerDefinitions(
  kind: CatalogKind,
  definitions: readonly CatalogLayerDefinition[]
): readonly CatalogLayerDefinition[] {
  if (kind !== 'workflow' || definitions.length <= 1) {
    return definitions;
  }
  const byId = new Map<string, CatalogLayerDefinition>();
  for (const def of definitions) {
    if (!byId.has(def.id)) {
      byId.set(def.id, def);
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: CatalogLayerDefinition[] = [];

  function visit(def: CatalogLayerDefinition): void {
    if (visited.has(def.id) || visiting.has(def.id)) {
      return;
    }
    visiting.add(def.id);
    for (const childId of referencedChildWorkflowIds(def.body)) {
      const child = byId.get(childId);
      if (child !== undefined && childId !== def.id) {
        visit(child);
      }
    }
    visiting.delete(def.id);
    visited.add(def.id);
    ordered.push(def);
  }

  for (const def of definitions) {
    visit(def);
  }
  return ordered.length === definitions.length ? ordered : definitions;
}

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

  const layers = [...request.layers]
    .filter((layer) => layer.definitions.length > 0)
    .sort((left, right) => LAYER_RANK[left.kind] - LAYER_RANK[right.kind])
    .map((layer) => ({
      ...layer,
      definitions: orderLayerDefinitions(layer.kind, layer.definitions)
    }));

  if (layers.length === 0) {
    return { outcome: 'published', published: [], pruned: [] };
  }

  const read = await store.read();
  if (read.outcome === 'unavailable') {
    return refusal('store-refused', null, { storeReason: read.fault.fault });
  }

  const candidates: readonly CandidateDefinition[] = layers.flatMap((layer) =>
    layer.definitions.map((definition) => ({
      kind: layer.kind,
      id: definition.id,
      body: definition.body
    }))
  );
  const defects = semantics.defectsOf(read.snapshot, candidates);
  if (defects.length > 0) {
    return refusal('validation-failed', null, { defects });
  }

  // ---- Pass 1: write the drafts -------------------------------------------------

  const revisions = new Map<CatalogKind, string>();
  const draftedOnly: CatalogKind[] = [];

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
      revisions.set(layer.kind, written.revision);
      draftedOnly.push(layer.kind);
      if (written.outcome === 'saved') recordPruned(layer.kind, written.pruned);
      continue;
    }

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
    const ids = layer.definitions.map((definition) => definition.id);
    const expectedRevision = revisions.get(layer.kind);
    if (expectedRevision === undefined) {
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

function remaining(
  drafted: readonly CatalogKind[],
  published: readonly PackagePublishedLayer[]
): readonly CatalogKind[] {
  const live = new Set(published.map((layer) => layer.kind));
  return drafted.filter((kind) => !live.has(kind));
}
