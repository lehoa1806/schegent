// Feature 099 (FR-R3-015) T484 — one pass, at first read, over the whole store.
//
// One pass per window (FR-027a): no re-scan per read, no background sweep. The
// snapshot this produces is then read synchronously by every resolver downstream,
// which is what lets those keep their synchronous signatures.
//
// The scan **deletes nothing**, on every path, including the paths where deleting
// would obviously be right (FR-026, FR-027). Collection is an operator's decision.
//
// Three findings, and the distinction between the first two is the whole point:
//
//   - **dangling** — the manifest names a record that is not there. That definition
//     is unreadable; every other definition still resolves (FR-027, SC-005).
//   - **collectable** — a record is there and the manifest does not name it.
//     Nothing is wrong: the definition resolves normally, and this is reported so
//     an operator can clean up if they want to (FR-026).
//   - **hash mismatch** — the record is there and is not the record the manifest
//     describes. Same family as dangling: reported, definition unreadable, nothing
//     deleted.
//
// Two scope decisions, both taken deliberately:
//
//   1. **Only the active version's hash is verified here.** It is the record the
//      snapshot reads anyway, so the check is free; hashing all 50 versions of every
//      definition on every window would make activation cost O(versions). Past
//      versions are verified when they are actually read, in `readVersion`, so every
//      body the store hands out has been checked — just not all of them up front.
//   2. **A record that is present but unparseable is reported as `hash-mismatch`**,
//      not as a new arm. The manifest recorded a hash for a body, and whatever is in
//      that file now is not it. An `unreadable-record` arm would be a third way to
//      say the one thing an operator needs to know: the record on disk is not the
//      record the manifest describes.

import type {
  CatalogCollectableRecord,
  CatalogIntegrityFault,
  CatalogKind,
  CatalogManifest,
  CatalogManifestEntry,
  StoredDefinition
} from '../contracts/catalog-store';
import { CATALOG_KINDS } from '../contracts/catalog-store';
import { isTempName } from './atomic-write';
import {
  definitionSegments,
  directoryForKind,
  isStoredId,
  versionIdsFromFileNames
} from './catalog-paths';
import { contentHashOf } from './content-hash';
import type { CatalogFsPort, Digest } from './ports';
import { readVersionRecord } from './version-record';

export interface IntegrityScan {
  readonly definitions: readonly StoredDefinition[];
  readonly faults: readonly CatalogIntegrityFault[];
  readonly collectable: readonly CatalogCollectableRecord[];
}

interface ScanSink {
  readonly faults: CatalogIntegrityFault[];
  readonly collectable: CatalogCollectableRecord[];
}

/** Records on disk for one definition that the manifest's `versions` does not name (FR-026). */
async function collectUnreferenced(
  fs: CatalogFsPort,
  kind: CatalogKind,
  id: string,
  named: ReadonlySet<string>,
  sink: ScanSink
): Promise<void> {
  const names = await fs.listDirectory(definitionSegments(kind, id));
  // A temp sibling is a write in flight or a crashed one, not a record. Reporting it
  // as collectable would invite deleting a file another window is renaming.
  const records = versionIdsFromFileNames(names.filter((name) => !isTempName(name)));
  for (const versionId of records) {
    if (!named.has(versionId)) sink.collectable.push({ kind, id, versionId });
  }
}

/**
 * One definition, resolved from its manifest entry plus its active record.
 *
 * The only place a body enters the snapshot, and the only place a definition
 * becomes `invalid`.
 */
async function scanDefinition(
  fs: CatalogFsPort,
  digest: Digest,
  entry: CatalogManifestEntry,
  sink: ScanSink
): Promise<StoredDefinition> {
  const named = new Set(entry.versions.map((version) => version.versionId));
  await collectUnreferenced(fs, entry.kind, entry.id, named, sink);

  const base = {
    kind: entry.kind,
    id: entry.id,
    activeVersionId: entry.activeVersionId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    versions: entry.versions
  } as const;

  // No active version: nothing to read, and nothing is wrong. Unreachable through
  // this feature's save path, which writes `activeVersionId` every time (FR-009);
  // FR-R3-016's draft-only entry is what makes it reachable on purpose.
  if (entry.activeVersionId === null) {
    return { ...base, status: 'effective', body: null };
  }

  const active = entry.versions.find((version) => version.versionId === entry.activeVersionId);
  // The manifest shape check already refuses an `activeVersionId` that is not among
  // `versions`, so this is defence at a boundary that cannot currently be crossed.
  if (active === undefined) {
    sink.faults.push({
      fault: 'dangling-record',
      kind: entry.kind,
      id: entry.id,
      versionId: entry.activeVersionId
    });
    return { ...base, status: 'invalid', body: null };
  }

  const record = await readVersionRecord(fs, entry.kind, entry.id, active.versionId);

  if (record.outcome === 'absent') {
    sink.faults.push({
      fault: 'dangling-record',
      kind: entry.kind,
      id: entry.id,
      versionId: active.versionId
    });
    return { ...base, status: 'invalid', body: null };
  }

  if (record.outcome === 'failed') {
    sink.faults.push({ fault: 'unreadable-store', errno: record.errno });
    return { ...base, status: 'invalid', body: null };
  }

  if (record.outcome === 'unreadable') {
    sink.faults.push({
      fault: 'hash-mismatch',
      kind: entry.kind,
      id: entry.id,
      versionId: active.versionId
    });
    return { ...base, status: 'invalid', body: null };
  }

  const hashed = contentHashOf(record.record.body, digest);
  if (hashed.outcome === 'refused' || hashed.contentHash !== active.contentHash) {
    sink.faults.push({
      fault: 'hash-mismatch',
      kind: entry.kind,
      id: entry.id,
      versionId: active.versionId
    });
    return { ...base, status: 'invalid', body: null };
  }

  return { ...base, status: 'effective', body: record.record.body };
}

/**
 * Records for an id the manifest holds no entry for at all.
 *
 * A whole orphaned definition directory is the same finding as one orphaned record
 * (FR-026), and it is the shape a partial write leaves behind when the *first* save
 * of a definition is the one that is interrupted — the record lands, the manifest
 * entry never does, and without this pass nothing would ever mention it.
 *
 * The one place in the store where a name arrives off the **disk** rather than out
 * of the manifest, which is why the id is checked here at all. A directory the
 * store could not have authored is not a definition directory: the reported triple
 * reaches an operator's log, and a cloned repository is free to name a directory
 * with a newline and a forged line after it (FR-033, FR-061). Skipped rather than
 * reported as a fault — an unrecognised file in the store is not the store's, and
 * the same rule already governs one that is not `v<N>.json`.
 */
async function collectOrphanedDefinitions(
  fs: CatalogFsPort,
  manifest: CatalogManifest,
  sink: ScanSink
): Promise<void> {
  for (const kind of CATALOG_KINDS) {
    const known = new Set(
      manifest.entries.filter((entry) => entry.kind === kind).map((entry) => entry.id)
    );
    const ids = await fs.listDirectory([directoryForKind(kind)]);
    for (const id of ids) {
      if (known.has(id) || isTempName(id) || !isStoredId(id)) continue;
      await collectUnreferenced(fs, kind, id, new Set(), sink);
    }
  }
}

/** The whole scan. Reads; never writes, never removes (FR-026, FR-027). */
export async function scanCatalog(
  fs: CatalogFsPort,
  digest: Digest,
  manifest: CatalogManifest
): Promise<IntegrityScan> {
  const sink: ScanSink = { faults: [], collectable: [] };
  const definitions: StoredDefinition[] = [];

  for (const entry of manifest.entries) {
    definitions.push(await scanDefinition(fs, digest, entry, sink));
  }

  await collectOrphanedDefinitions(fs, manifest, sink);

  return { definitions, faults: sink.faults, collectable: sink.collectable };
}
