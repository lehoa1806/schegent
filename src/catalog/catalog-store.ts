// Feature 099 (FR-R3-015) T482, T483, T483a, T484a — the store's own surface.
//
// Six operations, and the whole of the store's behaviour is in the order things
// happen inside `save`. Reading the code top to bottom, the order is:
//
//   1. writability — refused by name, never retried silently (FR-033a, FR-033b)
//   2. the manifest — absent is empty, unreadable is refused and never overwritten
//   3. id legality — refused, never sanitised (FR-033)
//   4. the expected-revision gate — the whole concurrency story (FR-044, FR-030a)
//   5. canonicalise and hash the body (FR-012, FR-013)
//   6. is the definition readable at all — *before* the short-circuit, see below
//   7. the unchanged short-circuit (FR-014)
//   8. write the record, then the manifest, then prune (FR-023, FR-024, FR-034)
//
// Step 6 before step 7 is the one that is easy to get backwards and expensive to
// get wrong. An unchanged-hash save against a definition whose active record has
// gone missing would otherwise report `unchanged` — the operator's save is silently
// dropped and the definition stays unreadable. The short-circuit exists to stop an
// editor round-trip manufacturing history, not to stop a repair.
//
// `saveLayer` is that same order widened from one definition to a set — one
// revision gate, N records, one manifest write — because the three save commands
// still send a complete layer (FR-047) and a per-definition loop would have the
// second write refuse itself as stale against the first.
//
// Nothing here catches an exception, and nothing here deletes a file on a failure
// path. Both are structural: the port returns outcomes rather than throwing, so
// there is no `catch` block for a compensating delete to be written into (FR-029).

import type {
  CatalogKind,
  CatalogLayerDefinition,
  CatalogLayerPruned,
  CatalogLayerSaveOutcome,
  CatalogLayerSaveRequest,
  CatalogLayerVersion,
  CatalogManifest,
  CatalogManifestEntry,
  CatalogReadResult,
  CatalogReadVersionOutcome,
  CatalogSaveOutcome,
  CatalogSaveRequest,
  CatalogSnapshot,
  CatalogVersionMetadata,
  CatalogVersionRecord,
  StoredDefinition
} from '../contracts/catalog-store';
import { STORE_FORMAT_VERSION } from '../contracts/catalog-store';
import { runWriteSequence, type WriteStep } from './atomic-write';
import { scanCatalog } from './catalog-integrity';
import {
  emptyManifest,
  findEntry,
  idsOfKind,
  loadManifest,
  serialiseManifest,
  withEntry,
  withoutEntry
} from './catalog-manifest';
import { checkIdLegality, MANIFEST_SEGMENTS, versionSegments } from './catalog-paths';
import { planRetention, withVersionsRemoved } from './catalog-retention';
import { revisionForKind, revisionsOf } from './catalog-revision';
import { contentHashOf } from './content-hash';
import type { CatalogStorePorts, Digest } from './ports';
import { nextVersionId, readVersionRecord, serialiseRecord } from './version-record';

export interface CatalogStore {
  /** One pass, into memory. Every resolver then reads the snapshot synchronously (FR-027a). */
  read(): Promise<CatalogReadResult>;
  save(request: CatalogSaveRequest): Promise<CatalogSaveOutcome>;
  /**
   * A whole layer of one kind under one revision gate (T493d, FR-042a, FR-047).
   *
   * The unit the three save commands still speak in: they send a complete layer
   * and the host re-derives the diff. FR-R3-016 turns those into per-definition
   * writes, at which point `save` becomes the only write.
   */
  saveLayer(request: CatalogLayerSaveRequest): Promise<CatalogLayerSaveOutcome>;
  /** A past version, verbatim. Writes nothing and moves no timestamp (FR-017, SC-003). */
  readVersion(kind: CatalogKind, id: string, versionId: string): Promise<CatalogReadVersionOutcome>;
  /** Version metadata in monotonic order, from the manifest alone — no record is read (FR-018). */
  listVersions(kind: CatalogKind, id: string): Promise<readonly CatalogVersionMetadata[]>;
  /** One kind's definitions, from a fresh scan. Prefer `read()` when more than one kind is needed. */
  listDefinitions(kind: CatalogKind): Promise<readonly StoredDefinition[]>;
}

/**
 * The snapshot of a catalog that is not there.
 *
 * Feature 099 (T493b, FR-051, FR-052) — an untrusted workspace gets no store at
 * all, and the wiring still has to compose a catalog. This is what it composes
 * from: zero definitions, zero faults, and the revisions an *existing* empty
 * store would report, computed the same way rather than stubbed, so the two
 * cannot drift into a revision gate that only one of them can satisfy.
 *
 * `null` from the host's `createHostCatalogStore` is the fact "no store"; this is
 * the catalog that fact resolves to. Keeping them separate is what lets the
 * Builder report the trust gate instead of an empty Library. (Named in prose
 * rather than linked: that factory lives in `src/activation/`, which this
 * directory may not reach.)
 */
export function emptyCatalogSnapshot(digest: Digest): CatalogSnapshot {
  return emptySnapshot(revisionsOf(emptyManifest(), digest));
}

/**
 * The snapshot a read outcome resolves to.
 *
 * Feature 099 (T493b, T494b, FR-027) — an unavailable read is the empty catalog
 * *carrying* the fault that emptied it. The caller needs both: a catalog to
 * compose from and a finding to report. Returning one without the other is how a
 * store nobody can read becomes a store nobody is told about.
 */
export function snapshotOfRead(result: CatalogReadResult, digest: Digest): CatalogSnapshot {
  if (result.outcome === 'read') return result.snapshot;
  return { ...emptyCatalogSnapshot(digest), faults: [result.fault] };
}

function emptySnapshot(revisions: Readonly<Record<CatalogKind, string>>): CatalogSnapshot {
  return {
    storeFormatVersion: STORE_FORMAT_VERSION,
    definitions: [],
    faults: [],
    collectable: [],
    revisions
  };
}

/** A first save's entry. `createdAt` is set here and never moved again (FR-019). */
function firstEntry(
  kind: CatalogKind,
  id: string,
  version: CatalogVersionMetadata,
  now: number
): CatalogManifestEntry {
  return {
    kind,
    id,
    // INERT in this feature: every save publishes, so nothing is ever a draft
    // (FR-009). FR-R3-016 is what gives this field meaning.
    draftVersionId: null,
    activeVersionId: version.versionId,
    createdAt: now,
    updatedAt: now,
    versions: [version]
  };
}

/** A subsequent save's entry. `createdAt` is carried forward untouched. */
function appendedEntry(
  entry: CatalogManifestEntry,
  version: CatalogVersionMetadata,
  now: number
): CatalogManifestEntry {
  return {
    ...entry,
    draftVersionId: null,
    activeVersionId: version.versionId,
    // Moved only on an effective save. The unchanged short-circuit returns before
    // reaching here, which is what makes FR-020 hold rather than be remembered.
    updatedAt: now,
    versions: [...entry.versions, version]
  };
}

export function createCatalogStore(ports: CatalogStorePorts): CatalogStore {
  const { fs, clock, digest, provenance } = ports;

  async function read(): Promise<CatalogReadResult> {
    const manifest = await loadManifest(fs);

    // An absent store is a successful empty read, not a fault and not a write
    // (FR-001a, SC-018). Activating in a workspace that has never saved must leave
    // the disk untouched, so nothing on this path creates a directory.
    if (manifest.outcome === 'absent') {
      return { outcome: 'read', snapshot: emptySnapshot(revisionsOf(emptyManifest(), digest)) };
    }
    if (manifest.outcome === 'faulted') {
      return { outcome: 'unavailable', fault: manifest.fault };
    }

    const scan = await scanCatalog(fs, digest, manifest.manifest);
    return {
      outcome: 'read',
      snapshot: {
        storeFormatVersion: manifest.manifest.storeFormatVersion,
        definitions: scan.definitions,
        faults: scan.faults,
        collectable: scan.collectable,
        revisions: revisionsOf(manifest.manifest, digest)
      }
    };
  }

  async function listDefinitions(kind: CatalogKind): Promise<readonly StoredDefinition[]> {
    const result = await read();
    if (result.outcome === 'unavailable') return [];
    return result.snapshot.definitions.filter((definition) => definition.kind === kind);
  }

  async function listVersions(
    kind: CatalogKind,
    id: string
  ): Promise<readonly CatalogVersionMetadata[]> {
    const manifest = await loadManifest(fs);
    if (manifest.outcome !== 'read') return [];
    // The manifest is the single ordering point (FR-002): the stored order *is* the
    // monotonic order (FR-018), so this neither sorts nor reads a record.
    return findEntry(manifest.manifest, kind, id)?.versions ?? [];
  }

  async function readVersion(
    kind: CatalogKind,
    id: string,
    versionId: string
  ): Promise<CatalogReadVersionOutcome> {
    const manifest = await loadManifest(fs);
    if (manifest.outcome === 'absent') return { outcome: 'absent' };
    if (manifest.outcome === 'faulted') {
      return {
        outcome: 'refused',
        reason: manifest.fault.fault === 'unsupported-format' ? 'unsupported-format' : 'store-unreadable'
      };
    }

    const entry = findEntry(manifest.manifest, kind, id);
    const metadata = entry?.versions.find((version) => version.versionId === versionId);
    // A version the manifest does not name is `absent` even if a file happens to sit
    // at that path: such a file is a collectable record, not history (FR-026).
    if (entry === null || metadata === undefined) return { outcome: 'absent' };

    const record = await readVersionRecord(fs, kind, id, versionId);
    if (record.outcome === 'absent') return { outcome: 'absent' };
    if (record.outcome === 'failed') return { outcome: 'refused', reason: 'store-unreadable' };
    if (record.outcome === 'unreadable') return { outcome: 'refused', reason: 'definition-invalid' };

    // Past versions are hash-verified here rather than in the activation scan, so
    // every body the store hands out has been checked without making activation
    // cost one hash per stored version.
    const hashed = contentHashOf(record.record.body, digest);
    if (hashed.outcome === 'refused' || hashed.contentHash !== metadata.contentHash) {
      return { outcome: 'refused', reason: 'definition-invalid' };
    }

    return { outcome: 'read', record: record.record };
  }

  /**
   * Is the definition currently readable?
   *
   * Asked before the unchanged short-circuit so a save over a broken definition is
   * refused by name instead of being reported as `unchanged` and dropped.
   */
  async function activeRecordIsReadable(entry: CatalogManifestEntry): Promise<boolean> {
    if (entry.activeVersionId === null) return true;
    const read = await readVersion(entry.kind, entry.id, entry.activeVersionId);
    return read.outcome === 'read';
  }

  async function save(request: CatalogSaveRequest): Promise<CatalogSaveOutcome> {
    const writability = await fs.checkWritability();
    if (writability === 'no-workspace') return { outcome: 'refused', reason: 'no-workspace' };
    if (writability === 'not-writable') return { outcome: 'refused', reason: 'not-writable' };

    const loaded = await loadManifest(fs);
    if (loaded.outcome === 'faulted') {
      // Never repaired by writing a fresh manifest over it (FR-031): the operator's
      // history is exactly what a fresh manifest would erase.
      return {
        outcome: 'refused',
        reason: loaded.fault.fault === 'unsupported-format' ? 'unsupported-format' : 'store-unreadable'
      };
    }
    const manifest: CatalogManifest = loaded.outcome === 'absent' ? emptyManifest() : loaded.manifest;

    const legality = checkIdLegality(request.id, idsOfKind(manifest, request.kind));
    if (legality.outcome === 'refused') return { outcome: 'refused', reason: legality.reason };

    // The staleness gate, and the only concurrency control in the store: no lock
    // file, no lock directory (FR-030a). Two windows saving from the same starting
    // revision produce exactly one new version (SC-019).
    const revision = revisionForKind(manifest, request.kind, digest);
    if (request.expectedRevision !== revision) {
      return { outcome: 'stale', actualRevision: revision };
    }

    const hashed = contentHashOf(request.body, digest);
    if (hashed.outcome === 'refused') return { outcome: 'refused', reason: 'uncanonical-body' };

    const entry = findEntry(manifest, request.kind, request.id);

    if (entry !== null) {
      if (!(await activeRecordIsReadable(entry))) {
        return { outcome: 'refused', reason: 'definition-invalid' };
      }

      const active = entry.versions.find((version) => version.versionId === entry.activeVersionId);
      // Against the **active** version only (FR-014). A body matching some older
      // version is a genuine change — reverting to a previous state is an edit, and
      // it gets its own version rather than resurrecting the old one (FR-015).
      if (active !== undefined && active.contentHash === hashed.contentHash) {
        return { outcome: 'unchanged', versionId: active.versionId, revision };
      }
    }

    const now = clock.nowMs();
    const versionId = nextVersionId(entry);
    const version: CatalogVersionMetadata = {
      versionId,
      contentHash: hashed.contentHash,
      createdAt: now,
      // A save is a publish in this feature, so the two times coincide by
      // construction rather than by copying one into the other. FR-R3-016 separates
      // them (FR-009, FR-021).
      publishedAt: now,
      note: request.note ?? null
    };

    const appended =
      entry === null
        ? firstEntry(request.kind, request.id, version, now)
        : appendedEntry(entry, version, now);

    const plan = await planRetention(appended, (candidate) =>
      provenance.isReferenced(request.kind, request.id, candidate)
    );
    const pruned = withVersionsRemoved(appended, plan.remove);
    const next = withEntry(manifest, pruned);

    const record: CatalogVersionRecord = {
      versionId,
      kind: request.kind,
      id: request.id,
      body: request.body
    };

    // Record first, manifest second (FR-024): a crash between them leaves a
    // collectable record and a definition that still resolves at its previous
    // version, rather than a manifest entry pointing at nothing.
    const steps: readonly WriteStep[] = [
      {
        at: versionSegments(request.kind, request.id, versionId),
        contents: serialiseRecord(record),
        mode: 'if-absent',
        label: versionId
      },
      {
        at: MANIFEST_SEGMENTS,
        contents: serialiseManifest(next),
        mode: 'replace',
        label: 'manifest'
      }
    ];

    const written = await runWriteSequence(fs, steps);

    if (written.outcome === 'exists') {
      // The version id already has a record. Records are write-once and are never
      // overwritten (FR-030) — the id is not reissued and nothing is repaired here.
      return { outcome: 'refused', reason: 'version-exists' };
    }
    if (written.outcome === 'failed') {
      // The landed prefix stays written. `wrote` is empty when nothing landed at
      // all, which is the same instruction to the caller either way: report it, and
      // do not try to tidy up (FR-028, FR-029).
      return { outcome: 'partial', wrote: written.wrote, errno: written.errno };
    }

    // Pruning happens *after* the manifest write, so the manifest has already
    // stopped naming these versions: a crash here leaves collectable records rather
    // than dangling references. A `removeFile` that fails leaves the file on disk,
    // where the next read reports it as collectable — so `pruned` reports what came
    // out of the history, which is what the operator sees, and disk catches up.
    for (const versionToPrune of plan.remove) {
      await fs.removeFile(versionSegments(request.kind, request.id, versionToPrune));
    }

    return {
      outcome: 'saved',
      versionId,
      revision: revisionForKind(next, request.kind, digest),
      pruned: plan.remove
    };
  }

  /**
   * Write a complete layer of one kind under one expected revision (T493d).
   *
   * Same order as `save`, widened to a set: every check for every definition runs
   * before the first byte is written, so a refusal is still a refusal *before*
   * anything landed. Only `version-exists` can be discovered at write time, and
   * when a prefix has already landed by then it is reported as `partial` rather
   * than as a refusal — a refusal that left files on disk would be a lie.
   *
   * An id the manifest holds and this layer does not name is removed by dropping
   * its manifest entry. Its records stay where they are (FR-026).
   */
  async function saveLayer(request: CatalogLayerSaveRequest): Promise<CatalogLayerSaveOutcome> {
    const writability = await fs.checkWritability();
    if (writability === 'no-workspace') {
      return { outcome: 'refused', reason: 'no-workspace', id: null };
    }
    if (writability === 'not-writable') {
      return { outcome: 'refused', reason: 'not-writable', id: null };
    }

    const loaded = await loadManifest(fs);
    if (loaded.outcome === 'faulted') {
      return {
        outcome: 'refused',
        reason:
          loaded.fault.fault === 'unsupported-format' ? 'unsupported-format' : 'store-unreadable',
        id: null
      };
    }
    const manifest: CatalogManifest = loaded.outcome === 'absent' ? emptyManifest() : loaded.manifest;

    // One gate for the whole layer (FR-044). Per-definition gating would mean the
    // second write of a package import refusing itself as stale against the first.
    const revision = revisionForKind(manifest, request.kind, digest);
    if (request.expectedRevision !== revision) {
      return { outcome: 'stale', actualRevision: revision };
    }

    const claimed: string[] = [];
    const hashes = new Map<string, string>();
    for (const definition of request.definitions) {
      const legality = checkIdLegality(definition.id, claimed);
      if (legality.outcome === 'refused') {
        return { outcome: 'refused', reason: legality.reason, id: definition.id };
      }
      // `checkIdLegality` treats an equal id as an edit of that id, which is right
      // for a single save and wrong here: within one layer, the same id twice is one
      // name claimed twice, and the manifest cannot hold both.
      if (hashes.has(definition.id)) {
        return { outcome: 'refused', reason: 'id-case-collision', id: definition.id };
      }
      const hashed = contentHashOf(definition.body, digest);
      if (hashed.outcome === 'refused') {
        return { outcome: 'refused', reason: 'uncanonical-body', id: definition.id };
      }
      hashes.set(definition.id, hashed.contentHash);
      claimed.push(definition.id);
    }

    const unchanged: string[] = [];
    const changed: CatalogLayerDefinition[] = [];
    for (const definition of request.definitions) {
      const entry = findEntry(manifest, request.kind, definition.id);
      if (entry === null) {
        changed.push(definition);
        continue;
      }
      // Readability before the short-circuit, for the reason given at the top of
      // this file: a repair of a broken definition must not be reported as unchanged.
      if (!(await activeRecordIsReadable(entry))) {
        return { outcome: 'refused', reason: 'definition-invalid', id: definition.id };
      }
      const active = entry.versions.find((version) => version.versionId === entry.activeVersionId);
      if (active !== undefined && active.contentHash === hashes.get(definition.id)) {
        unchanged.push(definition.id);
        continue;
      }
      changed.push(definition);
    }

    const proposed = new Set(request.definitions.map((definition) => definition.id));
    const removed = idsOfKind(manifest, request.kind).filter((id) => !proposed.has(id));

    // Nothing to record and nothing to un-name: write nothing at all, so the
    // revision does not move (FR-014, FR-020).
    if (changed.length === 0 && removed.length === 0) {
      return { outcome: 'unchanged', revision };
    }

    const now = clock.nowMs();
    const versions: CatalogLayerVersion[] = [];
    const pruned: CatalogLayerPruned[] = [];
    const steps: WriteStep[] = [];
    const idByLabel = new Map<string, string>();
    let next = manifest;

    for (const definition of changed) {
      const entry = findEntry(manifest, request.kind, definition.id);
      const versionId = nextVersionId(entry);
      const version: CatalogVersionMetadata = {
        versionId,
        contentHash: hashes.get(definition.id)!,
        createdAt: now,
        publishedAt: now,
        note: request.note ?? null
      };
      const appended =
        entry === null
          ? firstEntry(request.kind, definition.id, version, now)
          : appendedEntry(entry, version, now);
      const plan = await planRetention(appended, (candidate) =>
        provenance.isReferenced(request.kind, definition.id, candidate)
      );
      next = withEntry(next, withVersionsRemoved(appended, plan.remove));

      const label = `${definition.id}@${versionId}`;
      idByLabel.set(label, definition.id);
      versions.push({ id: definition.id, versionId });
      if (plan.remove.length > 0) pruned.push({ id: definition.id, versionIds: plan.remove });
      steps.push({
        at: versionSegments(request.kind, definition.id, versionId),
        contents: serialiseRecord({
          versionId,
          kind: request.kind,
          id: definition.id,
          body: definition.body
        }),
        mode: 'if-absent',
        label
      });
    }

    for (const id of removed) {
      next = withoutEntry(next, request.kind, id);
    }

    // Records first, manifest last (FR-024) — the same ordering property as a
    // single save, and for the same reason: a crash part-way leaves collectable
    // records rather than a manifest naming files that are not there.
    steps.push({
      at: MANIFEST_SEGMENTS,
      contents: serialiseManifest(next),
      mode: 'replace',
      label: 'manifest'
    });

    const written = await runWriteSequence(fs, steps);

    if (written.outcome === 'exists') {
      if (written.wrote.length > 0) {
        return { outcome: 'partial', wrote: written.wrote, errno: 'EEXIST' };
      }
      return {
        outcome: 'refused',
        reason: 'version-exists',
        id: idByLabel.get(written.at) ?? null
      };
    }
    if (written.outcome === 'failed') {
      return { outcome: 'partial', wrote: written.wrote, errno: written.errno };
    }

    for (const entry of pruned) {
      for (const versionToPrune of entry.versionIds) {
        await fs.removeFile(versionSegments(request.kind, entry.id, versionToPrune));
      }
    }

    return {
      outcome: 'saved',
      revision: revisionForKind(next, request.kind, digest),
      versions,
      unchanged,
      removed,
      pruned
    };
  }

  return { read, save, saveLayer, readVersion, listVersions, listDefinitions };
}
