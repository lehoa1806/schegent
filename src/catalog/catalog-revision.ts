// Feature 099 (FR-R3-015) T483b — the revision, derived rather than stored (FR-044a).
//
// The expected-revision gate is the whole of this store's concurrency story: no
// lock file, no lock directory, no advisory lock (FR-030a). Two windows saving the
// same definition from the same starting revision produce exactly one new version
// because the second save's expected revision no longer matches (SC-019).
//
// That gate needs a value with two properties: two readers of one manifest compute
// the same one, and any write changes it. A **derived** digest over the manifest's
// stored state has both. A persisted counter would also have both, and is rejected:
// it would be a second ordering point beside the manifest, and the manifest being
// the *only* one is FR-002. A counter that disagrees with the version list is a
// state neither file can prove wrong.
//
// The digest covers only the fields a reader could act on. `createdAt` is excluded
// deliberately — it never moves (FR-019), so including it would add nothing but a
// field to keep in sync.

import type { CatalogKind, CatalogManifest, CatalogManifestEntry } from '../contracts/catalog-store';
import { CATALOG_KINDS } from '../contracts/catalog-store';
import { canonicalJson } from './canonical-json';
import type { Digest } from './ports';

function actionableShape(entry: CatalogManifestEntry): unknown {
  return {
    id: entry.id,
    activeVersionId: entry.activeVersionId,
    draftVersionId: entry.draftVersionId,
    updatedAt: entry.updatedAt,
    versionIds: entry.versions.map((version) => version.versionId)
  };
}

/**
 * The revision for one kind.
 *
 * Deterministic from stored state and never persisted. Sorted by id before
 * hashing, because `entries` order is explicitly not significant in the format —
 * two manifests that differ only in entry order must produce the same revision, or
 * a rewrite that reorders entries would spuriously stale every open editor.
 */
export function revisionForKind(manifest: CatalogManifest, kind: CatalogKind, digest: Digest): string {
  const entries = manifest.entries
    .filter((entry) => entry.kind === kind)
    .map(actionableShape)
    .sort((left, right) =>
      (left as { id: string }).id < (right as { id: string }).id ? -1 : 1
    );

  const canonical = canonicalJson({ kind, storeFormatVersion: manifest.storeFormatVersion, entries });
  // The shape is built here from typed fields, so it holds only JSON values and
  // canonicalisation cannot refuse. The fallback keeps the signature total rather
  // than asserting non-null on something a future field could change.
  const text = canonical.outcome === 'canonical' ? canonical.text : `${kind}:uncanonical`;
  return digest.sha256(text);
}

/** One revision per kind — the shape the save contract carries after the scope collapse (FR-044). */
export function revisionsOf(
  manifest: CatalogManifest,
  digest: Digest
): Readonly<Record<CatalogKind, string>> {
  const revisions = {} as Record<CatalogKind, string>;
  for (const kind of CATALOG_KINDS) {
    revisions[kind] = revisionForKind(manifest, kind, digest);
  }
  return revisions;
}
