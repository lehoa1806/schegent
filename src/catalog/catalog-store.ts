// Feature 099 (FR-R3-015) T482-T484a, feature 100 (FR-R3-016) T498c-T498e — the
// store's own surface.
//
// Feature 099's `save` and `saveLayer` are gone. What replaces them is not a bigger
// write surface but a *narrower* one: `applyLifecycleWrite` takes a closed union of
// five instructions, and every one of them goes through the same sequence 099
// established. There is exactly one manifest writer in this codebase, and the whole
// of the atomic ordering lives inside it — a second writer would be a second copy of
// that ordering, and two copies drift.
//
// Reading the write top to bottom, the order is:
//
//   1. writability — refused by name, never retried silently (FR-033a, FR-033b)
//   2. the manifest — absent is empty, unreadable is refused and never overwritten
//   3. id legality — refused, never sanitised (FR-033)
//   4. the expected-draft gate — the whole concurrency story (FR-012, FR-012b)
//   5. the operation's own precondition, against the manifest just loaded
//   6. canonicalise and hash the body (FR-013) — record-writing arms only
//   7. the unchanged short-circuit, against the head, and only where the record that
//      head names is readable (FR-011a)
//   8. write the record, then the manifest, then prune
//
// Step 7's second half is the one that is easy to drop and expensive to get wrong. An
// unchanged-hash save against a definition whose head record has gone missing would
// otherwise report `unchanged` — the operator's save is silently dropped and the
// definition stays unreadable. Nor is the answer to refuse it: records are write-once,
// so the save writes a *new* version and overwrites nothing, and the new record is
// precisely what repairs the definition. Refusing would make a broken head a dead end
// no save could escape. The short-circuit exists to stop an editor round-trip
// manufacturing history, not to stand between an operator and a broken definition.
//
// Two of the five operations write a version record; three move pointers inside a
// single manifest write and write no record at all, which is what makes them atomic
// without a cross-file transaction and why `partial` is unreachable from them.
//
// Nothing here catches an exception, and nothing here deletes a file on a failure
// path. Both are structural: the port returns outcomes rather than throwing, so
// there is no `catch` block for a compensating delete to be written into (FR-029).

import { draftTokenOf } from '../contracts/catalog-lifecycle';
import type {
  CatalogKind,
  CatalogLayerDefinition,
  CatalogLayerPruned,
  CatalogLayerPublished,
  CatalogLayerVersion,
  CatalogManifest,
  CatalogManifestEntry,
  CatalogReadResult,
  CatalogReadVersionOutcome,
  CatalogSnapshot,
  CatalogVersionId,
  CatalogVersionMetadata,
  CatalogVersionRecord,
  LifecycleWrite,
  LifecycleWriteOutcome,
  LifecycleWritePointers,
  PublishLayerOutcome,
  PublishLayerRequest,
  SaveDraftLayerOutcome,
  SaveDraftLayerRequest,
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
  /**
   * The single-definition write. One instruction from a closed union (FR-R3-016).
   *
   * The lifecycle service owns every decision — the gate's meaning, the referential
   * check, the advisories, the audit — and issues exactly one of these. The store
   * owns the write sequence and re-evaluates the gate against the manifest it loads,
   * because a gate checked before the write is a gate a concurrent writer can slip
   * under.
   */
  applyLifecycleWrite(write: LifecycleWrite): Promise<LifecycleWriteOutcome>;
  /**
   * Draft many definitions of one kind under one revision gate.
   *
   * **Merges** — an id this request does not name is left exactly as it is. N calls
   * to `applyLifecycleWrite` would be N manifest writes and would not share a gate.
   */
  saveDraftLayer(request: SaveDraftLayerRequest): Promise<SaveDraftLayerOutcome>;
  /** Publish exactly the named definitions of one kind, in one manifest write. */
  publishLayer(request: PublishLayerRequest): Promise<PublishLayerOutcome>;
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

function pointersOf(entry: CatalogManifestEntry | null): LifecycleWritePointers {
  if (entry === null) return { draftVersionId: null, activeVersionId: null, present: false };
  return {
    draftVersionId: entry.draftVersionId,
    activeVersionId: entry.activeVersionId,
    present: true
  };
}

/**
 * The version a save is measured against: the draft where there is one, else the
 * active one (FR-011a).
 *
 * Head-relative rather than active-relative, and that is the difference feature 100
 * makes to the short-circuit. Under 099 a save was compared to the active version,
 * which was also the head because every save published. With a draft in play,
 * comparing to the active version would make every re-save of an unchanged draft
 * append a version — the operator opens their pending edit, closes it, and
 * manufactures history, which is the exact defect the short-circuit exists to stop.
 */
function headVersionOf(entry: CatalogManifestEntry): CatalogVersionMetadata | undefined {
  const head = entry.draftVersionId ?? entry.activeVersionId;
  if (head === null) return undefined;
  return entry.versions.find((version) => version.versionId === head);
}

function draftVersionOf(entry: CatalogManifestEntry): CatalogVersionMetadata | undefined {
  if (entry.draftVersionId === null) return undefined;
  return entry.versions.find((version) => version.versionId === entry.draftVersionId);
}

/** A first draft's entry. `createdAt` is set here and never moved again (FR-019). */
function firstDraftEntry(
  kind: CatalogKind,
  id: string,
  version: CatalogVersionMetadata,
  now: number
): CatalogManifestEntry {
  return {
    kind,
    id,
    draftVersionId: version.versionId,
    // A definition is never born live (FR-041). Becoming live is an explicit
    // publication and nothing else, which is what makes "editing does not change
    // what runs" true of creation as well as of editing.
    activeVersionId: null,
    createdAt: now,
    updatedAt: now,
    versions: [version]
  };
}

/** A subsequent draft's entry. `createdAt` and the active pointer are carried forward. */
function draftedEntry(
  entry: CatalogManifestEntry,
  version: CatalogVersionMetadata,
  now: number
): CatalogManifestEntry {
  return {
    ...entry,
    draftVersionId: version.versionId,
    // Untouched, deliberately and on every path through this function: a save must
    // not change what runs (FR-011). It is not re-read for the decision either.
    activeVersionId: entry.activeVersionId,
    // Moved only on an effective save. The unchanged short-circuit returns before
    // reaching here, which is what makes FR-020 hold rather than be remembered.
    updatedAt: now,
    versions: [...entry.versions, version]
  };
}

/**
 * The entry after a publication (T498e).
 *
 * Both pointers move in this one expression, so there is no moment — not even
 * in memory — at which they name the same version. Splitting it into "set active"
 * and "clear draft" is how that invariant becomes a thing to remember rather than a
 * thing that holds.
 *
 * `publishedAt` is stamped once and only if it is not already set. A definition
 * deactivated and published again keeps its original publication time, because the
 * version it names is the same immutable version it always was (FR-020).
 */
function publishedEntry(
  entry: CatalogManifestEntry,
  draftVersionId: CatalogVersionId,
  now: number
): CatalogManifestEntry {
  return {
    ...entry,
    activeVersionId: draftVersionId,
    draftVersionId: null,
    updatedAt: now,
    versions: entry.versions.map((version) =>
      version.versionId === draftVersionId && version.publishedAt === null
        ? { ...version, publishedAt: now }
        : version
    )
  };
}

/**
 * The entry after a deactivation (FR-024a).
 *
 * The entry stays. Where there is no pending draft the draft pointer takes the
 * version that was active — **no record is written and no body is copied**, because
 * that version is already there and already immutable.
 *
 * This is what makes deactivation reversible on the ordinary publish path (FR-027):
 * an entry is what holds `versions`, so removing it would strand the whole history
 * as collectable records and make "its history is retained" false. Only
 * `discard-draft` can clear the last pointer.
 */
function deactivatedEntry(entry: CatalogManifestEntry, now: number): CatalogManifestEntry {
  return {
    ...entry,
    activeVersionId: null,
    draftVersionId: entry.draftVersionId ?? entry.activeVersionId,
    updatedAt: now
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
   * Is the record the short-circuit is about to compare against actually there?
   *
   * The short-circuit's claim is "this body is already stored", and a manifest hash
   * alone cannot support it — the record it describes may be missing or corrupt. So
   * the comparison is only trusted when the record backs it up. Aimed at whichever
   * version the operation compares against, which is the head for a save and the
   * draft for a restore.
   */
  async function recordIsReadable(
    entry: CatalogManifestEntry,
    versionId: CatalogVersionId
  ): Promise<boolean> {
    const read = await readVersion(entry.kind, entry.id, versionId);
    return read.outcome === 'read';
  }

  /**
   * The two record-writing arms: `save-draft` and `restore`.
   *
   * Identical from here down, and deliberately so — a restore is a save whose body
   * came out of the store instead of out of an editor. Only the body's provenance
   * differs, and the store is not the layer that cares (FR-029).
   */
  async function writeDraftRecord(
    write: Extract<LifecycleWrite, { op: 'save-draft' | 'restore' }>,
    manifest: CatalogManifest,
    entry: CatalogManifestEntry | null,
    revision: string
  ): Promise<LifecycleWriteOutcome> {
    const hashed = contentHashOf(write.body, digest);
    if (hashed.outcome === 'refused') return { outcome: 'refused', reason: 'uncanonical-body' };

    if (entry !== null) {
      // What "unchanged" is measured against.
      //
      // A save compares with the definition's head — the draft where there is one,
      // otherwise the active version (FR-011a) — so opening an editor and closing it
      // appends nothing.
      //
      // A **restore** compares with the draft pointer alone. Its purpose is to
      // produce a pending edit, so restoring the live version of an undrafted
      // definition is a real state change (`active` becomes `active-with-draft`) and
      // reporting it as `unchanged` would leave the operator with no draft and a
      // success. Where a draft already holds exactly that body the restore is
      // genuinely idempotent, and that is the case this still short-circuits.
      const against = write.op === 'save-draft' ? headVersionOf(entry) : draftVersionOf(entry);

      // Two things must hold to conclude nothing changed: the manifest says this body
      // is already there, **and** the record it describes is actually readable. Where
      // the record is broken the second is false and the write proceeds — the new
      // version is the repair, giving the pointer a record that can be read. Records
      // are write-once, so this overwrites nothing and compounds no fault (FR-030);
      // the broken record stays where it is as history, and the integrity scan keeps
      // reporting it. Refusing here instead would make an unreadable draft a dead end
      // that no save could ever get out of.
      //
      // Checked after the hash comparison, not before, so the common save reads no
      // record at all.
      if (
        against !== undefined &&
        against.contentHash === hashed.contentHash &&
        (await recordIsReadable(entry, against.versionId))
      ) {
        return { outcome: 'unchanged', versionId: against.versionId, revision };
      }
    }

    const now = clock.nowMs();
    const versionId = nextVersionId(entry);
    const version: CatalogVersionMetadata = {
      versionId,
      contentHash: hashed.contentHash,
      createdAt: now,
      // A draft has never been live. `publishedAt` is stamped by a publication and
      // by nothing else — which is what makes it answer "when did this become live"
      // rather than "when was this written" (FR-009, FR-020).
      publishedAt: null,
      // A restore carries no note: the note belongs to the version it came from, and
      // copying it would attribute an operator's words to a write they did not make.
      note: write.op === 'save-draft' ? (write.note ?? null) : null
    };

    const drafted =
      entry === null
        ? firstDraftEntry(write.kind, write.id, version, now)
        : draftedEntry(entry, version, now);

    const plan = await planRetention(drafted, (candidate) =>
      provenance.isReferenced(write.kind, write.id, candidate)
    );
    const pruned = withVersionsRemoved(drafted, plan.remove);
    const next = withEntry(manifest, pruned);

    const record: CatalogVersionRecord = {
      versionId,
      kind: write.kind,
      id: write.id,
      body: write.body
    };

    // Record first, manifest second (FR-024): a crash between them leaves a
    // collectable record and a definition that still resolves at its previous
    // version, rather than a manifest entry pointing at nothing.
    const steps: readonly WriteStep[] = [
      {
        at: versionSegments(write.kind, write.id, versionId),
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

    await prune(write.kind, write.id, plan.remove);

    return {
      outcome: 'written',
      draftVersionId: versionId,
      activeVersionId: pruned.activeVersionId,
      writtenVersionId: versionId,
      publishedAt: null,
      pruned: plan.remove,
      entryRemoved: false,
      revision: revisionForKind(next, write.kind, digest)
    };
  }

  /**
   * The three pointer-only arms: `publish`, `deactivate`, `discard-draft`.
   *
   * One manifest write and no record, so `partial` is not reachable from here — the
   * write either landed or it did not, and there is no prefix to leave behind.
   */
  async function writePointers(
    write: Extract<LifecycleWrite, { op: 'publish' | 'deactivate' | 'discard-draft' }>,
    manifest: CatalogManifest,
    entry: CatalogManifestEntry
  ): Promise<LifecycleWriteOutcome> {
    const now = clock.nowMs();
    let next: CatalogManifest;
    let updated: CatalogManifestEntry | null;
    let pruneList: readonly CatalogVersionId[] = [];
    let publishedAt: number | null = null;

    if (write.op === 'publish') {
      const draftVersionId = entry.draftVersionId;
      if (draftVersionId === null) {
        return { outcome: 'not-applicable', pointers: pointersOf(entry) };
      }
      const published = publishedEntry(entry, draftVersionId, now);
      publishedAt =
        published.versions.find((version) => version.versionId === draftVersionId)?.publishedAt ??
        null;
      // Retention runs here as well as on a draft write, and it is not redundant: a
      // publication is what stops the *previous* active version being exempt, so a
      // definition at the bound can have one more version become prunable exactly
      // now (FR-021).
      const plan = await planRetention(published, (candidate) =>
        provenance.isReferenced(write.kind, write.id, candidate)
      );
      pruneList = plan.remove;
      updated = withVersionsRemoved(published, plan.remove);
      next = withEntry(manifest, updated);
    } else if (write.op === 'deactivate') {
      if (entry.activeVersionId === null) {
        return { outcome: 'not-applicable', pointers: pointersOf(entry) };
      }
      updated = deactivatedEntry(entry, now);
      next = withEntry(manifest, updated);
    } else {
      if (entry.draftVersionId === null) {
        return { outcome: 'not-applicable', pointers: pointersOf(entry) };
      }
      // The only operation that can clear the last pointer, and therefore the only
      // one that removes an entry (FR-005, FR-034). The version records stay on disk
      // and the next read reports them as collectable (FR-026) — discarding a draft
      // is not a mandate to delete a definition's history.
      if (entry.activeVersionId === null) {
        updated = null;
        next = withoutEntry(manifest, write.kind, write.id);
      } else {
        updated = { ...entry, draftVersionId: null, updatedAt: now };
        next = withEntry(manifest, updated);
      }
    }

    const written = await runWriteSequence(fs, [
      {
        at: MANIFEST_SEGMENTS,
        contents: serialiseManifest(next),
        mode: 'replace',
        label: 'manifest'
      }
    ]);

    if (written.outcome === 'exists') {
      // Not reachable: the manifest step is `replace`. Named rather than cast away,
      // so a future step added here cannot fall through the switch silently.
      return { outcome: 'refused', reason: 'version-exists' };
    }
    if (written.outcome === 'failed') {
      return { outcome: 'partial', wrote: written.wrote, errno: written.errno };
    }

    await prune(write.kind, write.id, pruneList);

    return {
      outcome: 'written',
      draftVersionId: updated?.draftVersionId ?? null,
      activeVersionId: updated?.activeVersionId ?? null,
      writtenVersionId: null,
      publishedAt,
      pruned: pruneList,
      entryRemoved: updated === null,
      revision: revisionForKind(next, write.kind, digest)
    };
  }

  async function applyLifecycleWrite(write: LifecycleWrite): Promise<LifecycleWriteOutcome> {
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

    // Only `save-draft` can bring a new id into the store, so it is the only arm that
    // has an id to vet. The other four address a definition the manifest already
    // holds, whose id was vetted when it was created.
    if (write.op === 'save-draft') {
      const legality = checkIdLegality(write.id, idsOfKind(manifest, write.kind));
      if (legality.outcome === 'refused') return { outcome: 'refused', reason: legality.reason };
    }

    const entry = findEntry(manifest, write.kind, write.id);

    // The staleness gate, and the only concurrency control in the store: no lock
    // file, no lock directory (FR-030a). Per definition and over the **draft pointer
    // only** (FR-012b) — a publication or a deactivation, here or elsewhere, never
    // invalidates an unrelated in-flight edit. Two windows creating a first draft
    // both send `NO_DRAFT`, and exactly one of them wins (FR-012a).
    if (write.expectedDraftVersion !== draftTokenOf(entry?.draftVersionId ?? null)) {
      return { outcome: 'stale', pointers: pointersOf(entry) };
    }

    if (write.op === 'save-draft' || write.op === 'restore') {
      return writeDraftRecord(write, manifest, entry, revisionForKind(manifest, write.kind, digest));
    }

    if (entry === null) return { outcome: 'not-applicable', pointers: pointersOf(entry) };
    return writePointers(write, manifest, entry);
  }

  /**
   * Remove pruned records, after the manifest has stopped naming them.
   *
   * A crash here leaves collectable records rather than dangling references, and a
   * `removeFile` that fails leaves the file on disk where the next read reports it
   * as collectable. So the outcome reports what came out of the *history*, which is
   * what the operator sees, and disk catches up.
   */
  async function prune(
    kind: CatalogKind,
    id: string,
    versionIds: readonly CatalogVersionId[]
  ): Promise<void> {
    for (const versionId of versionIds) {
      await fs.removeFile(versionSegments(kind, id, versionId));
    }
  }

  /**
   * Draft a set of definitions of one kind under one expected revision (T504a).
   *
   * Same order as a single draft write, widened to a set: every check for every
   * definition runs before the first byte is written, so a refusal is still a
   * refusal *before* anything landed. Only `version-exists` can be discovered at
   * write time, and when a prefix has already landed by then it is reported as
   * `partial` rather than as a refusal — a refusal that left files on disk would be
   * a lie.
   *
   * **Merge, not replace.** An id of this kind that the manifest holds and this
   * request does not name is left exactly as it is. Feature 099's `saveLayer` removed
   * such an id, which was right when its only caller sent the complete layer and is
   * catastrophic here: a package naming two of five stored Phases would delete the
   * other three (FR-039b).
   */
  async function saveDraftLayer(request: SaveDraftLayerRequest): Promise<SaveDraftLayerOutcome> {
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

    // One gate for the whole layer (FR-036). Per-definition gating would mean the
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
      // The same two-part short-circuit the single-definition path uses, for the same
      // reason: a matching hash whose record is not readable is not an unchanged save,
      // it is a definition this write repairs.
      const head = headVersionOf(entry);
      if (
        head !== undefined &&
        head.contentHash === hashes.get(definition.id) &&
        (await recordIsReadable(entry, head.versionId))
      ) {
        unchanged.push(definition.id);
        continue;
      }
      changed.push(definition);
    }

    // Nothing to record: write nothing at all, so the revision does not move
    // (FR-011a). There is no removal branch to consider — merge semantics remove
    // nothing, which is why this condition is one term shorter than 099's was.
    if (changed.length === 0) {
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
        // Every imported definition lands as a Draft (FR-041). An import cannot
        // change what runs, so nothing written here has ever been live.
        publishedAt: null,
        note: request.note ?? null
      };
      const drafted =
        entry === null
          ? firstDraftEntry(request.kind, definition.id, version, now)
          : draftedEntry(entry, version, now);
      const plan = await planRetention(drafted, (candidate) =>
        provenance.isReferenced(request.kind, definition.id, candidate)
      );
      next = withEntry(next, withVersionsRemoved(drafted, plan.remove));

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

    // Records first, manifest last (FR-024) — the same ordering property as a
    // single write, and for the same reason: a crash part-way leaves collectable
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
      await prune(request.kind, entry.id, entry.versionIds);
    }

    return {
      outcome: 'saved',
      revision: revisionForKind(next, request.kind, digest),
      versions,
      unchanged,
      pruned
    };
  }

  /**
   * Publish exactly the named definitions of one kind (T504a).
   *
   * One manifest write and no records, so there is no `partial` outcome to report:
   * the layer either becomes live or it does not.
   *
   * A named id with no pending draft is `skipped` rather than refused. The ordinary
   * cause is a document re-imported unchanged, where the draft write short-circuited
   * because the content already equals what is live — there is nothing to publish
   * and nothing wrong, and failing the whole package over it would make an idempotent
   * re-import an error.
   */
  async function publishLayer(request: PublishLayerRequest): Promise<PublishLayerOutcome> {
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

    const revision = revisionForKind(manifest, request.kind, digest);
    if (request.expectedRevision !== revision) {
      return { outcome: 'stale', actualRevision: revision };
    }

    const now = clock.nowMs();
    const published: CatalogLayerPublished[] = [];
    const skipped: string[] = [];
    const pruned: CatalogLayerPruned[] = [];
    let next = manifest;

    for (const id of request.ids) {
      const entry = findEntry(manifest, request.kind, id);
      if (entry === null || entry.draftVersionId === null) {
        skipped.push(id);
        continue;
      }
      const draftVersionId = entry.draftVersionId;
      const entryPublished = publishedEntry(entry, draftVersionId, now);
      const plan = await planRetention(entryPublished, (candidate) =>
        provenance.isReferenced(request.kind, id, candidate)
      );
      next = withEntry(next, withVersionsRemoved(entryPublished, plan.remove));
      if (plan.remove.length > 0) pruned.push({ id, versionIds: plan.remove });
      published.push({
        id,
        activeVersionId: draftVersionId,
        publishedAt:
          entryPublished.versions.find((version) => version.versionId === draftVersionId)
            ?.publishedAt ?? now
      });
    }

    // Every named id was already live at that content: write nothing, so the revision
    // does not move and a re-imported document does not manufacture a stale gate in
    // another window.
    if (published.length === 0) {
      return { outcome: 'published', revision, published: [], skipped, pruned: [] };
    }

    const written = await runWriteSequence(fs, [
      {
        at: MANIFEST_SEGMENTS,
        contents: serialiseManifest(next),
        mode: 'replace',
        label: 'manifest'
      }
    ]);

    if (written.outcome !== 'written') {
      // A layer publication writes one file. It landed or it did not, and either way
      // no record was written, so there is nothing on disk to describe as a prefix.
      return { outcome: 'refused', reason: 'not-writable', id: null };
    }

    for (const entry of pruned) {
      await prune(request.kind, entry.id, entry.versionIds);
    }

    return {
      outcome: 'published',
      revision: revisionForKind(next, request.kind, digest),
      published,
      skipped,
      pruned
    };
  }

  return {
    read,
    applyLifecycleWrite,
    saveDraftLayer,
    publishLayer,
    readVersion,
    listVersions,
    listDefinitions
  };
}
