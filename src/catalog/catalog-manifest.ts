// Feature 099 (FR-R3-015) T480 — the manifest: read, shape-check, serialise.
//
// `manifest.json` is the only mutable file in the store and the single ordering
// point (FR-002). Nothing else here is ever rewritten: version records are
// write-once, so every question about what exists and in what order is a question
// about this file.
//
// Four distinct outcomes for a read, and keeping them distinct is most of the work:
//
//   - **absent** — a successful *empty* read (FR-001a). Not a fault, and it does
//     not create the file. A workspace that never saves has no store, and
//     activating in one must write nothing (SC-018).
//   - **empty / malformed / shape** — the file is present and cannot be read
//     (FR-031). Reported by name, and **never** repaired by writing a fresh
//     manifest over it: overwriting is how an operator's history disappears while
//     the extension reports success.
//   - **unsupported-format** — a `storeFormatVersion` above what this build
//     understands, refused rather than read on a best-effort basis (FR-032).
//   - **failed** — an I/O error. Distinct from all of the above because nothing is
//     known about the content, so no content-shaped fault would be honest.

import {
  STORE_FORMAT_VERSION,
  type CatalogIntegrityFault,
  type CatalogKind,
  type CatalogManifest,
  type CatalogManifestEntry,
  type CatalogVersionMetadata
} from '../contracts/catalog-store';
import { CATALOG_KINDS } from '../contracts/catalog-store';
import { isStoredId, MANIFEST_SEGMENTS, versionNumberOf } from './catalog-paths';
import type { CatalogFsPort } from './ports';

export type ManifestReadOutcome =
  /** Present, understood, and shape-checked. */
  | { readonly outcome: 'read'; readonly manifest: CatalogManifest }
  /** No store yet. An empty catalog, not a fault (FR-001a). */
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'faulted'; readonly fault: CatalogIntegrityFault };

const EMPTY_MANIFEST: CatalogManifest = { storeFormatVersion: STORE_FORMAT_VERSION, entries: [] };

/** A manifest for a store that does not exist yet. Never written by a read. */
export function emptyManifest(): CatalogManifest {
  return EMPTY_MANIFEST;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is CatalogKind {
  return typeof value === 'string' && (CATALOG_KINDS as readonly string[]).includes(value);
}

function isEpochMs(value: unknown): value is number {
  // Epoch milliseconds are integers (FR-021a). A float here would mean something
  // wrote a different representation, which is a shape fault rather than a value
  // to round.
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isVersionId(value: unknown): value is string {
  return typeof value === 'string' && versionNumberOf(value) !== null;
}

function isNullableVersionId(value: unknown): value is string | null {
  return value === null || isVersionId(value);
}

function readVersion(value: unknown): CatalogVersionMetadata | null {
  if (!isRecord(value)) return null;
  const { versionId, contentHash, createdAt, publishedAt, note } = value;
  if (!isVersionId(versionId)) return null;
  if (typeof contentHash !== 'string' || contentHash.length === 0) return null;
  if (!isEpochMs(createdAt)) return null;
  if (publishedAt !== null && !isEpochMs(publishedAt)) return null;
  if (note !== null && typeof note !== 'string') return null;
  return { versionId, contentHash, createdAt, publishedAt, note };
}

function readEntry(value: unknown): CatalogManifestEntry | null {
  if (!isRecord(value)) return null;
  const { kind, id, draftVersionId, activeVersionId, createdAt, updatedAt, versions } = value;
  if (!isKind(kind)) return null;
  // Checked against the pattern, not merely for non-emptiness. `checkIdLegality`
  // guards the *save* path, so the store never writes an id that fails here — but
  // this file is a file in a repository anyone can clone, and every id read out of
  // it becomes a directory name on the read path. Without this line, a
  // hand-authored `../..` id is a traversal the core hands the filesystem itself
  // (FR-033, FR-061). A shape fault rather than a repair: an id is never sanitised.
  if (typeof id !== 'string' || !isStoredId(id)) return null;
  if (!isNullableVersionId(draftVersionId)) return null;
  if (!isNullableVersionId(activeVersionId)) return null;
  if (!isEpochMs(createdAt) || !isEpochMs(updatedAt)) return null;
  if (!Array.isArray(versions)) return null;

  const read: CatalogVersionMetadata[] = [];
  for (const entry of versions) {
    const version = readVersion(entry);
    if (version === null) return null;
    read.push(version);
  }

  // Monotonic order is part of the format (FR-018), not a convenience the writer
  // happens to maintain: retention walks this list front-to-back as the prune
  // order, so an out-of-order list would prune the wrong version. A list that
  // arrives out of order is a shape fault rather than something to sort silently.
  for (let position = 1; position < read.length; position += 1) {
    const previous = versionNumberOf(read[position - 1]!.versionId)!;
    const current = versionNumberOf(read[position]!.versionId)!;
    if (current <= previous) return null;
  }

  // An id the manifest names but no version backs is not representable: an entry
  // with versions must name an active one among them.
  if (activeVersionId !== null && !read.some((version) => version.versionId === activeVersionId)) {
    return null;
  }

  return { kind, id, draftVersionId, activeVersionId, createdAt, updatedAt, versions: read };
}

function readManifest(value: unknown): CatalogManifest | null {
  if (!isRecord(value)) return null;
  const { storeFormatVersion, entries } = value;
  if (typeof storeFormatVersion !== 'number' || !Number.isSafeInteger(storeFormatVersion)) return null;
  if (storeFormatVersion < 1) return null;
  if (!Array.isArray(entries)) return null;

  const read: CatalogManifestEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const parsed = readEntry(entry);
    if (parsed === null) return null;
    // Separator spelled as an escape, not a literal control byte: a raw NUL in
    // the source makes this file read as *binary* to line-oriented tooling
    // (ripgrep skips it), which would silently exclude it from repo-wide scans.
    const key = `${parsed.kind}\u0000${parsed.id}`;
    // One entry per `(kind, id)`. Two entries for one pair would make every
    // lookup order-dependent, which the format explicitly forbids.
    if (seen.has(key)) return null;
    seen.add(key);
    read.push(parsed);
  }

  return { storeFormatVersion, entries: read };
}

/** Read and shape-check `manifest.json`. Writes nothing on any path. */
export async function loadManifest(fs: CatalogFsPort): Promise<ManifestReadOutcome> {
  const read = await fs.readFile(MANIFEST_SEGMENTS);
  if (read.outcome === 'absent') return { outcome: 'absent' };
  if (read.outcome === 'failed') {
    return { outcome: 'faulted', fault: { fault: 'unreadable-store', errno: read.errno } };
  }

  if (read.contents.trim().length === 0) {
    return { outcome: 'faulted', fault: { fault: 'unreadable-manifest', reason: 'empty' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.contents);
  } catch {
    // The parse error's message is deliberately not carried: it quotes file
    // content, and content is what this store is not allowed to leak into a log
    // line (FR-061).
    return { outcome: 'faulted', fault: { fault: 'unreadable-manifest', reason: 'malformed' } };
  }

  const shaped = readManifest(parsed);
  if (shaped === null) {
    return { outcome: 'faulted', fault: { fault: 'unreadable-manifest', reason: 'shape' } };
  }

  // Checked *after* the shape, so a newer format that is also corrupt reports the
  // corruption it can prove rather than guessing which came first.
  if (shaped.storeFormatVersion > STORE_FORMAT_VERSION) {
    return {
      outcome: 'faulted',
      fault: {
        fault: 'unsupported-format',
        found: shaped.storeFormatVersion,
        supported: STORE_FORMAT_VERSION
      }
    };
  }

  return { outcome: 'read', manifest: shaped };
}

/**
 * The text to write for a manifest.
 *
 * Indented rather than canonical: an operator is told to read this file when
 * diagnosing a fault, and the store's determinism requirement is on the *content
 * hash* (FR-013) and the *revision* (FR-044a), both computed separately over a
 * canonical form. Two writers producing byte-identical text is not a property
 * this format needs; the expected-revision gate is what serialises writers.
 */
export function serialiseManifest(manifest: CatalogManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function findEntry(
  manifest: CatalogManifest,
  kind: CatalogKind,
  id: string
): CatalogManifestEntry | null {
  return manifest.entries.find((entry) => entry.kind === kind && entry.id === id) ?? null;
}

export function idsOfKind(manifest: CatalogManifest, kind: CatalogKind): readonly string[] {
  return manifest.entries.filter((entry) => entry.kind === kind).map((entry) => entry.id);
}

/**
 * Drop one entry.
 *
 * Feature 099 (T493d) — this is the whole of a removal. The version records stay
 * on disk and the next read reports them as collectable (FR-026); nothing here
 * deletes a file, because a definition's history is exactly what an accidental
 * remove would otherwise destroy. Retention prunes *surplus* history under a
 * stated bound (FR-034); removing a definition carries no such mandate.
 */
export function withoutEntry(
  manifest: CatalogManifest,
  kind: CatalogKind,
  id: string
): CatalogManifest {
  return {
    storeFormatVersion: manifest.storeFormatVersion,
    entries: manifest.entries.filter((entry) => !(entry.kind === kind && entry.id === id))
  };
}

/** Replace one entry, or append it if absent. Order of `entries` is not significant. */
export function withEntry(manifest: CatalogManifest, entry: CatalogManifestEntry): CatalogManifest {
  const position = manifest.entries.findIndex(
    (candidate) => candidate.kind === entry.kind && candidate.id === entry.id
  );
  const entries =
    position === -1
      ? [...manifest.entries, entry]
      : manifest.entries.map((candidate, at) => (at === position ? entry : candidate));
  return { storeFormatVersion: manifest.storeFormatVersion, entries };
}
