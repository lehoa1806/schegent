// Feature 099 (FR-R3-015) T481, T481a — write-once records and the next version id.
//
// Two small things, both of which are wrong in an invisible way if done the
// obvious way:
//
//   1. **Write-once** is enforced by `writeFileIfAbsent` reporting `exists`, not by
//      checking for the file and then writing it (FR-030). The check-then-write
//      version has a window in which two windows both see the file absent, and it
//      is exactly the window this store's two-window case walks into.
//   2. **The next version id is `max(N) + 1` over the retained list**, never
//      `list.length + 1` (FR-005). The two agree until retention prunes, and then
//      the length version reissues an id that already existed: a definition pruned
//      down to `v41`-`v90` has 50 versions, so `length + 1` is `v51` — an id whose
//      record was deleted, which makes the new version indistinguishable from a
//      dangling reference to the old one.

import type {
  CatalogKind,
  CatalogManifestEntry,
  CatalogVersionRecord
} from '../contracts/catalog-store';
import { versionIdFor, versionNumberOf, versionSegments } from './catalog-paths';
import type { CatalogFsPort } from './ports';

export type RecordReadOutcome =
  | { readonly outcome: 'read'; readonly record: CatalogVersionRecord }
  /** The manifest names it and it is not there — the dangling case (FR-027). */
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'unreadable'; readonly reason: 'malformed' | 'shape' }
  | { readonly outcome: 'failed'; readonly errno: string };

/**
 * The next version id for a definition.
 *
 * `max(N) + 1` over whatever the manifest still holds. A definition with no
 * versions starts at `v1`.
 */
export function nextVersionId(entry: CatalogManifestEntry | null): string {
  if (entry === null || entry.versions.length === 0) return versionIdFor(1);
  let highest = 0;
  for (const version of entry.versions) {
    const numbered = versionNumberOf(version.versionId);
    if (numbered !== null && numbered > highest) highest = numbered;
  }
  return versionIdFor(highest + 1);
}

/** The record's own text. Indented so an operator can read a record they found by hand. */
export function serialiseRecord(record: CatalogVersionRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

// There is deliberately no `writeVersionRecord` here. A record is never written on
// its own: it is the first step of the save's write *sequence* (record, then
// manifest, `atomic-write.ts`), and a helper that writes one in isolation is an
// invitation to write it outside that order — which is the one thing FR-025 pins.

function isRecordShape(value: unknown, kind: CatalogKind, id: string, versionId: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  // The record repeats its identity so a record found without a manifest entry is
  // self-describing. A record whose identity disagrees with where it was found is
  // a shape fault: trusting the path over the content would let a misplaced record
  // read out as a definition it is not.
  return candidate.versionId === versionId && candidate.kind === kind && candidate.id === id;
}

/** Read one record. Writes nothing and moves no timestamp (FR-017, SC-003). */
export async function readVersionRecord(
  fs: CatalogFsPort,
  kind: CatalogKind,
  id: string,
  versionId: string
): Promise<RecordReadOutcome> {
  const read = await fs.readFile(versionSegments(kind, id, versionId));
  if (read.outcome === 'absent') return { outcome: 'absent' };
  if (read.outcome === 'failed') return { outcome: 'failed', errno: read.errno };

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.contents);
  } catch {
    return { outcome: 'unreadable', reason: 'malformed' };
  }

  if (!isRecordShape(parsed, kind, id, versionId)) return { outcome: 'unreadable', reason: 'shape' };

  const candidate = parsed as { readonly body: unknown };
  return { outcome: 'read', record: { versionId, kind, id, body: candidate.body } };
}
