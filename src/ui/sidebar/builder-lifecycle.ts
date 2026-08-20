// Feature 101 (FR-R3-017) T014-T016 — the lifecycle facts the Builder renders,
// read out of the catalog snapshot once per compose.
//
// **The host is the only oracle** (FR-005, FR-010). `state` here is the return of
// `deriveDefinitionState` and nothing else: no `if` over `draftVersionId`, no
// `switch` over `activeVersionId`, anywhere under `src/ui/sidebar/`. A second
// mapping is a second authority on what is live, and it stays correct exactly
// until the day the two are edited apart.
//
// One module rather than the same twenty lines in three projection files. The
// three catalogs differ in what a *definition* is and not at all in what its
// lifecycle is, so a per-kind copy would be three chances for the version ordering
// or the `activeVersionId` absence rule to drift.

import { currentDraftToken, deriveDefinitionState } from '../../contracts/catalog-lifecycle';
import { compareForPublish } from '../../catalog/changed-fields';
import type { CatalogKind, StoredDefinition } from '../../contracts/catalog-store';
import type { BuilderLifecycle, BuilderVersionEntry } from './snapshot';

/**
 * One kind's lifecycle facts, by definition id.
 *
 * A function rather than a `Map` because every caller wants exactly this, and a
 * `Map` in the options would let a projection iterate the store's definitions
 * instead of the rows it was given — which is how a row the resolver quarantined
 * would come back through the side door.
 */
export type BuilderLifecycleLookup = (id: string) => BuilderLifecycle | undefined;

/** Nothing to look up. The projections then omit `lifecycle` from every record. */
export const NO_BUILDER_LIFECYCLE: BuilderLifecycleLookup = () => undefined;

/**
 * All three kinds' lookups, built together.
 *
 * One value rather than three separate projector dependencies because they are
 * one read of one snapshot (099 FR-042). Three accessors would let a host wire
 * two and forget the third, and the Builder would then show a Phase's lifecycle
 * next to a Workflow with none — a difference the operator would read as a fact
 * about the definition rather than a gap in the wiring.
 */
export type BuilderLifecycleByKind = Readonly<Record<CatalogKind, BuilderLifecycleLookup>>;

/** A host with no catalog store wired. Every record then omits `lifecycle`. */
export const NO_BUILDER_LIFECYCLE_BY_KIND: BuilderLifecycleByKind = Object.freeze({
  phase: NO_BUILDER_LIFECYCLE,
  pipeline: NO_BUILDER_LIFECYCLE,
  workflow: NO_BUILDER_LIFECYCLE
});

/**
 * The retained versions, newest first, with the active one marked (FR-027).
 *
 * The manifest holds them oldest-first because that is prune order (099 FR-018).
 * Reversing here rather than in the surface is FR-012's "the surface does not
 * sort": two surfaces sorting the same list is two orderings to keep in step, and
 * the projection is the one place that knows the manifest's order is deliberate.
 */
function versionEntries(definition: StoredDefinition): readonly BuilderVersionEntry[] {
  const entries: BuilderVersionEntry[] = [];
  for (const version of definition.versions) {
    entries.push(Object.freeze({
      versionId: version.versionId,
      createdAt: version.createdAt,
      publishedAt: version.publishedAt,
      isActive: version.versionId === definition.activeVersionId,
      note: version.note
    }));
  }
  return Object.freeze(entries.reverse());
}

/**
 * One definition's lifecycle.
 *
 * `changedFields` is computed eagerly and only for `'active-with-draft'` (FR-011).
 * Eagerly because the summary is what makes a publish deliberate and a round trip
 * to fetch it would make it optional in practice; only for that state because the
 * other two have nothing to compare — a Draft has no active version behind it, and
 * an Active definition has no draft in front of it.
 *
 * `StoredDefinition` is structurally a `CatalogManifestEntry`, which is what lets
 * the shared oracle be called on it directly instead of through a re-packing that
 * could quietly substitute a pointer.
 */
function lifecycleOf(definition: StoredDefinition): BuilderLifecycle {
  const state = deriveDefinitionState(definition);
  return Object.freeze({
    state,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    // FR-006 — absent, never `''`. An empty string is a version id the store can
    // never issue, so a surface testing truthiness and a surface testing presence
    // would agree today and a surface reading it into a history request would not.
    ...(definition.activeVersionId !== null
      ? { activeVersionId: definition.activeVersionId }
      : {}),
    // FR-012 — the token, not the pointer. The `?? NO_DRAFT` fold happens here
    // and nowhere else, which is what makes a first-draft race detectable rather
    // than a silent overwrite.
    expectedDraftVersion: currentDraftToken(definition),
    versions: versionEntries(definition),
    ...(state === 'active-with-draft'
      ? { changedFields: compareForPublish(definition.draftBody, definition.body) }
      : {})
  });
}

/**
 * The lookup for one kind, built once per compose.
 *
 * Built per kind because ids are unique only within a kind (100 FR-021): three
 * kinds sharing one index would let a Pipeline named `ship-it` answer for a Phase
 * of the same name, and the two would differ in exactly the way that matters.
 */
export function buildBuilderLifecycleLookup(
  definitions: readonly StoredDefinition[],
  kind: CatalogKind
): BuilderLifecycleLookup {
  const byId = new Map<string, BuilderLifecycle>();
  for (const definition of definitions) {
    if (definition.kind !== kind) continue;
    byId.set(definition.id, lifecycleOf(definition));
  }
  return (id: string) => byId.get(id);
}

/**
 * The three lookups for one store snapshot.
 *
 * The whole surface's entry point: activation calls this once per compose and the
 * composer hands each kind its own. Computing all three eagerly costs one pass
 * over a manifest the host has already read, and it is what makes "the Builder's
 * three tabs agree about the store" true by construction rather than by ordering.
 */
export function buildBuilderLifecycleByKind(
  definitions: readonly StoredDefinition[]
): BuilderLifecycleByKind {
  return Object.freeze({
    phase: buildBuilderLifecycleLookup(definitions, 'phase'),
    pipeline: buildBuilderLifecycleLookup(definitions, 'pipeline'),
    workflow: buildBuilderLifecycleLookup(definitions, 'workflow')
  });
}
