// Feature 099 (FR-R3-015) T478 — id legality and segment construction (FR-033, FR-061).
//
// An id the store accepts becomes a directory name, so this is the security
// boundary as much as the naming one, and it runs in the core *before* any
// segment exists: an illegal id cannot reach the filesystem adapter at all.
//
// `CATALOG_ID_PATTERN` excludes every traversal and separator character, so `../`
// and `a/b` are rejected by shape rather than by a special case. It also admits no
// uppercase, which settles the case-collision question the same way: two ids that
// both pass it are already folded, so no pair of legal ids can collide on the
// case-insensitive filesystems macOS and Windows default to. The fold check in
// `checkIdLegality` therefore guards a caller passing unchecked ids, not the store
// — see the note on it.
//
// The pattern is a *read*-path check too, and that is the half most easily lost.
// A name only the store ever wrote needs no checking; a name in `manifest.json` or
// a directory name in the store was written by whoever cloned the repository, and
// both become directory names here. `isStoredId` is that check, spelled once.
//
// Ids are refused, never sanitised. Sanitising would silently rename an operator's
// definition and make the id in the document disagree with the id on disk.

import { CATALOG_ID_PATTERN, type CatalogKind } from '../contracts/catalog-store';
import type { StoreSegments } from './ports';

/** The store's own directory, under `.schegent/`. Segments are relative to it. */
export const MANIFEST_SEGMENTS: StoreSegments = ['manifest.json'];

const KIND_DIRECTORIES: Readonly<Record<CatalogKind, string>> = {
  phase: 'phases',
  pipeline: 'pipelines',
  workflow: 'workflows'
};

const VERSION_ID_PATTERN = /^v([1-9][0-9]*)$/;

export type IdLegality =
  | { readonly outcome: 'legal' }
  | { readonly outcome: 'refused'; readonly reason: 'illegal-id' | 'id-case-collision' };

/** The directory name for a kind. The only place the plural spelling is decided. */
export function directoryForKind(kind: CatalogKind): string {
  return KIND_DIRECTORIES[kind];
}

/**
 * Could the store have authored this id?
 *
 * The shape test on its own, without the collision question `checkIdLegality`
 * also answers. Both read paths need exactly this and nothing more: the manifest
 * reader, checking an id it is about to turn into a directory name, and the
 * integrity scan, deciding whether a directory it found on disk is a definition
 * at all. Spelled once so those two cannot come to disagree about what the store
 * writes — which is the disagreement that turns a name from a cloned repository
 * into a name this store reports as its own.
 */
export function isStoredId(value: string): boolean {
  return CATALOG_ID_PATTERN.test(value);
}

/**
 * Is `id` legal, given the ids of that kind already in the store?
 *
 * `existing` is the manifest's ids for the same kind. An id equal to one of them
 * is legal — that is an edit, not a collision. An id that differs from one of
 * them only by case is refused, because the two cannot coexist as directories on
 * a case-insensitive filesystem.
 */
export function checkIdLegality(id: string, existing: readonly string[]): IdLegality {
  if (!isStoredId(id)) return { outcome: 'refused', reason: 'illegal-id' };

  // Kept although the pattern above admits no uppercase, so two ids that both pass
  // it are already folded and this loop cannot fire through the manifest — the
  // manifest reader applies the same pattern, so `existing` holds no spelling this
  // build would refuse. It stays because the guarantee is then wholly one line in
  // another module, and `checkIdLegality` is a boundary that should not have to
  // assume its caller filtered the list. Its one reachable caller is `saveLayer`,
  // which passes the ids claimed earlier in the same layer.
  const folded = id.toLowerCase();
  for (const other of existing) {
    if (other === id) continue;
    if (other.toLowerCase() === folded) return { outcome: 'refused', reason: 'id-case-collision' };
  }
  return { outcome: 'legal' };
}

/** `['phases', 'implement']` — where one definition's records live. */
export function definitionSegments(kind: CatalogKind, id: string): StoreSegments {
  return [directoryForKind(kind), id];
}

/** `['phases', 'implement', 'v3.json']` — one immutable record (FR-007). */
export function versionSegments(kind: CatalogKind, id: string, versionId: string): StoreSegments {
  return [directoryForKind(kind), id, `${versionId}.json`];
}

/** Version ids as `v<N>`; the parse is the legality check (FR-005). */
export function versionNumberOf(versionId: string): number | null {
  const match = VERSION_ID_PATTERN.exec(versionId);
  if (match === null) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function versionIdFor(versionNumber: number): string {
  return `v${versionNumber}`;
}

/**
 * The record file names in a definition's directory, as version ids.
 *
 * Used by the integrity scan to find records the manifest does not name (FR-026).
 * A file that is not `v<N>.json` is not a record and is ignored rather than
 * reported: the store does not own every file an operator might leave there, and
 * reporting one as collectable would invite deleting it.
 */
export function versionIdsFromFileNames(names: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const candidate = name.slice(0, -'.json'.length);
    if (versionNumberOf(candidate) !== null) found.push(candidate);
  }
  return found;
}
