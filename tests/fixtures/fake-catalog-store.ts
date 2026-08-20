// Feature 099 (T496f, FR-042a) — an in-memory `CatalogStore` for the suites that
// used to hand the save commands a `updateConfig(key, value, scope)` double.
//
// Those suites are not about the store. They assert what a command sends, what it
// refuses, and what the surface is told afterwards; the settings writer they used
// was a recorder that happened to be the write port of the day.
//
// Feature 100 (T514, FR-R3-016) — the write port moved again, and this time the
// *subject* moved with it. `saveLayer` took a whole array and the callers' claim was
// "which rows did the command decide to persist". A lifecycle operation takes one
// definition and the claim is "which pointer moved, and did the token gate hold".
// So this double now holds a pointer pair and a body per version, rather than one
// body per id, and it records the three write surfaces separately.
//
// It is still NOT a second implementation of the store. It computes no content hash,
// writes no version records, and derives its revision from a counter rather than from
// a manifest. `tests/unit/catalog/` is where the real store's behaviour is asserted;
// a fixture that reimplemented any of it would let a caller-side test pass against
// semantics the real store does not have.
//
// What it *is* faithful to is exactly the part the callers depend on, and each of
// these is a property some caller-side test is about:
//
//   - the per-definition `expectedDraftVersion` gate, over the **draft pointer
//     only** — a publication elsewhere never invalidates an in-flight edit;
//   - the per-kind `expectedRevision` gate on the two layer writes;
//   - the `unchanged` short-circuit, measured against the **head** (draft where
//     there is one, otherwise active) for a save and against the **draft pointer
//     alone** for a restore, which is the real store's distinction and the reason
//     restoring the live version of an undrafted definition is a real change
//     (`catalog-store.ts` `writeDraftRecord`);
//   - **merge** semantics on `saveDraftLayer`: an id the request does not name is
//     left exactly as it is (FR-039b);
//   - the invariant that publishing clears the draft pointer in the same write, so
//     the two pointers can never name one version (FR-005, FR-020).

import type {
  CatalogKind,
  CatalogLayerPruned,
  CatalogLayerPublished,
  CatalogLayerVersion,
  CatalogReadResult,
  CatalogReadVersionOutcome,
  CatalogSnapshot,
  CatalogVersionId,
  CatalogVersionMetadata,
  LifecycleWrite,
  LifecycleWriteOutcome,
  LifecycleWritePointers,
  PublishLayerOutcome,
  PublishLayerRequest,
  SaveDraftLayerOutcome,
  SaveDraftLayerRequest,
  StoredDefinition
} from '../../src/contracts/catalog-store';
import { STORE_FORMAT_VERSION } from '../../src/contracts/catalog-store';
import {
  NO_DRAFT,
  draftTokenOf,
  type DefinitionState,
  type ExpectedDraftVersion
} from '../../src/contracts/catalog-lifecycle';
import type { CatalogStore } from '../../src/catalog/catalog-store';
import { versionIdFor } from '../../src/catalog/catalog-paths';

/** One immutable version as the double holds it: a body and the pointer history behind it. */
interface HeldVersion {
  /** The version NUMBER. Version ids are `v<N>`; this is the `<N>` (099 FR-016). */
  readonly versionNumber: number;
  readonly body: unknown;
  /** Stamped by a publication and by nothing else (FR-020). */
  publishedAt: number | null;
  readonly note: string | null;
}

/** One definition: its versions in monotonic order, and the two pointers into them. */
interface HeldDefinition {
  readonly id: string;
  readonly versions: HeldVersion[];
  activeVersion: number | null;
  draftVersion: number | null;
}

const KINDS: readonly CatalogKind[] = ['phase', 'pipeline', 'workflow'];

/** The rows a fake store starts with, per kind. */
export interface FakeStoreSeed {
  /** Bodies seeded as **published**: one version, active, no draft. */
  readonly phases?: readonly unknown[];
  readonly pipelines?: readonly unknown[];
  readonly workflows?: readonly unknown[];
  /**
   * Bodies seeded as **draft-only**: one version, drafted, nothing active.
   *
   * The state feature 100 introduces, and the one an import-presence or
   * effective-catalog test needs to be able to construct (FR-005, FR-043).
   */
  readonly drafts?: Partial<Record<CatalogKind, readonly unknown[]>>;
  /** The revision each kind reports before any write. Defaults to `rev-<kind>-0`. */
  readonly revisions?: Partial<Record<CatalogKind, string>>;
}

function idOf(row: unknown, kind: CatalogKind, index: number): string {
  if (row !== null && typeof row === 'object') {
    const record = row as Record<string, unknown>;
    const candidate = record.id ?? record[`${kind}Id`];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return `${kind}-row-${index}`;
}

function versionOf(definition: HeldDefinition, versionNumber: number | null): HeldVersion | null {
  if (versionNumber === null) return null;
  return definition.versions.find((version) => version.versionNumber === versionNumber) ?? null;
}

function headOf(definition: HeldDefinition): HeldVersion | null {
  return versionOf(definition, definition.draftVersion ?? definition.activeVersion);
}

function pointersOf(definition: HeldDefinition | undefined): LifecycleWritePointers {
  if (definition === undefined) {
    return { draftVersionId: null, activeVersionId: null, present: false };
  }
  return {
    draftVersionId: idOrNull(definition.draftVersion),
    activeVersionId: idOrNull(definition.activeVersion),
    present: true
  };
}

function idOrNull(versionNumber: number | null): CatalogVersionId | null {
  return versionNumber === null ? null : versionIdFor(versionNumber);
}

export class FakeCatalogStore implements CatalogStore {
  /** Every `applyLifecycleWrite` instruction, in the order it arrived. */
  readonly lifecycleWrites: LifecycleWrite[] = [];
  /** Every `saveDraftLayer` request, in the order it arrived. */
  readonly draftLayerSaves: SaveDraftLayerRequest[] = [];
  /** Every `publishLayer` request, in the order it arrived. */
  readonly publishLayers: PublishLayerRequest[] = [];
  /** How many times the store was read. */
  reads = 0;

  /**
   * Set to answer the next write with this outcome instead of performing it — the
   * seam the refusal, `partial`, and store-error cases drive, which they used to
   * drive by making `updateConfig` throw. Each is consumed by one call.
   */
  nextLifecycleVerdict: LifecycleWriteOutcome | null = null;
  nextDraftLayerVerdict: SaveDraftLayerOutcome | null = null;
  nextPublishLayerVerdict: PublishLayerOutcome | null = null;

  /**
   * Answer the layer write for ONE KIND with this outcome instead of performing it.
   *
   * Feature 100 (T514) — the three seams above answer whichever call arrives first,
   * which was the whole story while a package write was one request per command. A
   * package publish is two ordered passes over every layer, so "the Pipeline layer
   * fails and the Phase layer does not" is a claim about the *fourth* call rather
   * than the first, and an unkeyed seam cannot express it.
   *
   * Consumed on use, like the others, so re-running the same document after a
   * partial completes normally — which is the recovery FR-039 describes and a case
   * that would be untestable against a sticky seam.
   */
  readonly draftLayerVerdicts = new Map<CatalogKind, SaveDraftLayerOutcome>();
  readonly publishLayerVerdicts = new Map<CatalogKind, PublishLayerOutcome>();

  /** What `publishedAt` is stamped with. A counter, so the values are ordered and stable. */
  private publishClock = 1_000;

  private readonly held = new Map<CatalogKind, HeldDefinition[]>();
  private readonly revisions = new Map<CatalogKind, string>();
  private readonly writeCounts = new Map<CatalogKind, number>();

  constructor(seed: FakeStoreSeed = {}) {
    const active: Record<CatalogKind, readonly unknown[]> = {
      phase: seed.phases ?? [],
      pipeline: seed.pipelines ?? [],
      workflow: seed.workflows ?? []
    };
    for (const kind of KINDS) {
      const definitions = active[kind].map((row, index) =>
        seeded(idOf(row, kind, index), row, 'active')
      );
      for (const [index, row] of (seed.drafts?.[kind] ?? []).entries()) {
        definitions.push(seeded(idOf(row, kind, index), row, 'draft'));
      }
      this.held.set(kind, definitions);
      this.revisions.set(kind, seed.revisions?.[kind] ?? `rev-${kind}-0`);
      this.writeCounts.set(kind, 0);
    }
  }

  /** The revision the store currently reports for one kind. */
  revisionOf(kind: CatalogKind): string {
    return this.revisions.get(kind) ?? '';
  }

  /**
   * The **active** bodies for one kind, in manifest order — what the resolvers see.
   *
   * A draft-only definition is deliberately absent: that is FR-007, and a helper
   * that included it would let a test assert the effective catalog holds a draft.
   */
  rowsOf(kind: CatalogKind): readonly unknown[] {
    return this.definitionsFor(kind)
      .filter((definition) => definition.activeVersion !== null)
      .map((definition) => versionOf(definition, definition.activeVersion)?.body);
  }

  /** The **draft** bodies for one kind, in manifest order. */
  draftRowsOf(kind: CatalogKind): readonly unknown[] {
    return this.definitionsFor(kind)
      .filter((definition) => definition.draftVersion !== null)
      .map((definition) => versionOf(definition, definition.draftVersion)?.body);
  }

  /**
   * One definition's derived state, or `null` when the store holds no entry for it.
   *
   * `null` is the fourth pointer combination: the absence of a definition rather
   * than a state one can be in (FR-005, FR-006).
   */
  stateOf(kind: CatalogKind, id: string): DefinitionState | null {
    const definition = this.find(kind, id);
    if (definition === undefined) return null;
    if (definition.activeVersion === null) return 'draft';
    return definition.draftVersion === null ? 'active' : 'active-with-draft';
  }

  /** Every id the store holds an entry for, at every state — a superset of `rowsOf`. */
  idsOf(kind: CatalogKind): readonly string[] {
    return this.definitionsFor(kind).map((definition) => definition.id);
  }

  snapshot(): CatalogSnapshot {
    return {
      storeFormatVersion: STORE_FORMAT_VERSION,
      definitions: KINDS.flatMap((kind) => this.storedDefinitionsOf(kind)),
      faults: [],
      collectable: [],
      revisions: {
        phase: this.revisionOf('phase'),
        pipeline: this.revisionOf('pipeline'),
        workflow: this.revisionOf('workflow')
      }
    };
  }

  async read(): Promise<CatalogReadResult> {
    this.reads += 1;
    return { outcome: 'read', snapshot: this.snapshot() };
  }

  async applyLifecycleWrite(write: LifecycleWrite): Promise<LifecycleWriteOutcome> {
    this.lifecycleWrites.push(write);
    const verdict = this.nextLifecycleVerdict;
    if (verdict !== null) {
      this.nextLifecycleVerdict = null;
      return verdict;
    }

    const definitions = this.definitionsFor(write.kind);
    const existing = definitions.find((definition) => definition.id === write.id);

    // The gate, over the draft pointer only, before anything else (FR-012, FR-014).
    const token: ExpectedDraftVersion = draftTokenOf(pointersOf(existing).draftVersionId);
    if (write.expectedDraftVersion !== token) {
      return { outcome: 'stale', pointers: pointersOf(existing) };
    }

    switch (write.op) {
      case 'save-draft':
      case 'restore':
        return this.writeDraft(write, definitions, existing);
      case 'publish':
        return this.publish(write.kind, existing);
      case 'deactivate':
        return this.deactivate(write.kind, existing);
      case 'discard-draft':
        return this.discardDraft(write.kind, definitions, existing);
    }
  }

  async saveDraftLayer(request: SaveDraftLayerRequest): Promise<SaveDraftLayerOutcome> {
    this.draftLayerSaves.push(request);
    const verdict = this.nextDraftLayerVerdict;
    if (verdict !== null) {
      this.nextDraftLayerVerdict = null;
      return verdict;
    }
    const keyed = this.draftLayerVerdicts.get(request.kind);
    if (keyed !== undefined) {
      this.draftLayerVerdicts.delete(request.kind);
      return keyed;
    }
    if (request.expectedRevision !== this.revisionOf(request.kind)) {
      return { outcome: 'stale', actualRevision: this.revisionOf(request.kind) };
    }

    const definitions = this.definitionsFor(request.kind);
    const versions: CatalogLayerVersion[] = [];
    const unchanged: string[] = [];

    // Merge, never replace: this loop only ever touches an id the request names
    // (FR-039b). An id the manifest holds and the request does not is untouched by
    // construction — there is no `removed` pass to omit.
    for (const definition of request.definitions) {
      const existing = definitions.find((held) => held.id === definition.id);
      if (existing === undefined) {
        definitions.push(seeded(definition.id, definition.body, 'draft', request.note ?? null));
        versions.push({ id: definition.id, versionId: versionIdFor(1) });
        continue;
      }
      const head = headOf(existing);
      if (head !== null && sameBody(head.body, definition.body)) {
        unchanged.push(definition.id);
        continue;
      }
      const versionNumber = this.appendVersion(existing, definition.body, request.note ?? null);
      versions.push({ id: definition.id, versionId: versionIdFor(versionNumber) });
    }

    if (versions.length === 0) {
      // Every named definition hashed equal: nothing is written, not even the
      // manifest, so the revision must NOT move (FR-011a).
      return { outcome: 'unchanged', revision: this.revisionOf(request.kind) };
    }
    // The double keeps every version it is given, so it never prunes. A test that
    // needs a draft write to report a removal injects the outcome (`draftLayerVerdicts`)
    // rather than driving this double to the retention bound.
    const pruned: readonly CatalogLayerPruned[] = [];
    return { outcome: 'saved', revision: this.bump(request.kind), versions, unchanged, pruned };
  }

  async publishLayer(request: PublishLayerRequest): Promise<PublishLayerOutcome> {
    this.publishLayers.push(request);
    const verdict = this.nextPublishLayerVerdict;
    if (verdict !== null) {
      this.nextPublishLayerVerdict = null;
      return verdict;
    }
    const keyed = this.publishLayerVerdicts.get(request.kind);
    if (keyed !== undefined) {
      this.publishLayerVerdicts.delete(request.kind);
      return keyed;
    }
    if (request.expectedRevision !== this.revisionOf(request.kind)) {
      return { outcome: 'stale', actualRevision: this.revisionOf(request.kind) };
    }

    const definitions = this.definitionsFor(request.kind);
    const published: CatalogLayerPublished[] = [];
    const skipped: string[] = [];
    for (const id of request.ids) {
      const definition = definitions.find((held) => held.id === id);
      if (definition === undefined || definition.draftVersion === null) {
        // No pending draft to publish. The ordinary cause is a document re-imported
        // unchanged, and the definition is already live at that content.
        skipped.push(id);
        continue;
      }
      published.push({
        id,
        activeVersionId: versionIdFor(definition.draftVersion),
        publishedAt: this.stampPublished(definition, definition.draftVersion)
      });
      definition.activeVersion = definition.draftVersion;
      definition.draftVersion = null;
    }

    if (published.length === 0) {
      return {
        outcome: 'published',
        revision: this.revisionOf(request.kind),
        published,
        skipped,
        pruned: []
      };
    }
    const pruned: readonly CatalogLayerPruned[] = [];
    return { outcome: 'published', revision: this.bump(request.kind), published, skipped, pruned };
  }

  async readVersion(
    kind: CatalogKind,
    id: string,
    versionId: string
  ): Promise<CatalogReadVersionOutcome> {
    const definition = this.find(kind, id);
    const version = definition?.versions.find(
      (held) => versionIdFor(held.versionNumber) === versionId
    );
    if (version === undefined) return { outcome: 'absent' };
    return { outcome: 'read', record: { versionId, kind, id, body: version.body } };
  }

  async listVersions(kind: CatalogKind, id: string): Promise<readonly CatalogVersionMetadata[]> {
    const definition = this.find(kind, id);
    if (definition === undefined) return [];
    return definition.versions.map((version) => metadata(version, kind, id));
  }

  async listDefinitions(kind: CatalogKind): Promise<readonly StoredDefinition[]> {
    return this.storedDefinitionsOf(kind);
  }

  private writeDraft(
    write: Extract<LifecycleWrite, { op: 'save-draft' | 'restore' }>,
    definitions: HeldDefinition[],
    existing: HeldDefinition | undefined
  ): LifecycleWriteOutcome {
    if (existing === undefined) {
      const note = write.op === 'save-draft' ? (write.note ?? null) : null;
      definitions.push(seeded(write.id, write.body, 'draft', note));
      return this.wrote(write.kind, {
        draftVersionId: versionIdFor(1),
        activeVersionId: null,
        writtenVersionId: versionIdFor(1)
      });
    }

    // A save measures against the **head**; a restore against the **draft pointer
    // alone**, because its purpose is to produce a pending edit and restoring the
    // live version of an undrafted definition is a real state change.
    const against =
      write.op === 'save-draft' ? headOf(existing) : versionOf(existing, existing.draftVersion);
    if (against !== null && sameBody(against.body, write.body)) {
      return {
        outcome: 'unchanged',
        versionId: versionIdFor(against.versionNumber),
        revision: this.revisionOf(write.kind)
      };
    }

    const note = write.op === 'save-draft' ? (write.note ?? null) : null;
    const versionNumber = this.appendVersion(existing, write.body, note);
    return this.wrote(write.kind, {
      draftVersionId: versionIdFor(versionNumber),
      activeVersionId: idOrNull(existing.activeVersion),
      writtenVersionId: versionIdFor(versionNumber)
    });
  }

  private publish(kind: CatalogKind, existing: HeldDefinition | undefined): LifecycleWriteOutcome {
    if (existing === undefined || existing.draftVersion === null) {
      return { outcome: 'not-applicable', pointers: pointersOf(existing) };
    }
    const versionNumber = existing.draftVersion;
    const publishedAt = this.stampPublished(existing, versionNumber);
    // Active ← draft and draft ← null in the same write, so the two pointers can
    // never name one version (FR-005, FR-020).
    existing.activeVersion = versionNumber;
    existing.draftVersion = null;
    return this.wrote(kind, {
      draftVersionId: null,
      activeVersionId: versionIdFor(versionNumber),
      publishedAt
    });
  }

  private deactivate(
    kind: CatalogKind,
    existing: HeldDefinition | undefined
  ): LifecycleWriteOutcome {
    if (existing === undefined || existing.activeVersion === null) {
      return { outcome: 'not-applicable', pointers: pointersOf(existing) };
    }
    // Where there is no pending draft the draft pointer takes the version that was
    // active (FR-024a): no record written, no body copied, and the entry — which is
    // what holds the retained version list — survives.
    if (existing.draftVersion === null) existing.draftVersion = existing.activeVersion;
    existing.activeVersion = null;
    return this.wrote(kind, {
      draftVersionId: idOrNull(existing.draftVersion),
      activeVersionId: null
    });
  }

  private discardDraft(
    kind: CatalogKind,
    definitions: HeldDefinition[],
    existing: HeldDefinition | undefined
  ): LifecycleWriteOutcome {
    if (existing === undefined || existing.draftVersion === null) {
      return { outcome: 'not-applicable', pointers: pointersOf(existing) };
    }
    existing.draftVersion = null;
    // The only operation that can clear the last pointer, and it removes the entry
    // when it does (FR-034).
    if (existing.activeVersion === null) {
      definitions.splice(definitions.indexOf(existing), 1);
      return this.wrote(kind, {
        draftVersionId: null,
        activeVersionId: null,
        entryRemoved: true
      });
    }
    return this.wrote(kind, {
      draftVersionId: null,
      activeVersionId: idOrNull(existing.activeVersion)
    });
  }

  /** Every `written` outcome, with the fields this operation does not produce as `null`. */
  private wrote(
    kind: CatalogKind,
    moved: {
      readonly draftVersionId: CatalogVersionId | null;
      readonly activeVersionId: CatalogVersionId | null;
      readonly writtenVersionId?: CatalogVersionId;
      readonly publishedAt?: number;
      readonly entryRemoved?: boolean;
    }
  ): LifecycleWriteOutcome {
    return {
      outcome: 'written',
      draftVersionId: moved.draftVersionId,
      activeVersionId: moved.activeVersionId,
      writtenVersionId: moved.writtenVersionId ?? null,
      publishedAt: moved.publishedAt ?? null,
      pruned: [],
      entryRemoved: moved.entryRemoved ?? false,
      revision: this.bump(kind)
    };
  }

  private appendVersion(definition: HeldDefinition, body: unknown, note: string | null): number {
    const versionNumber = (definition.versions.at(-1)?.versionNumber ?? 0) + 1;
    definition.versions.push({ versionNumber, body, publishedAt: null, note });
    definition.draftVersion = versionNumber;
    return versionNumber;
  }

  /**
   * Stamp `publishedAt` on the version becoming active, **once**. A version that
   * has been live before keeps the timestamp it already has: the record is
   * immutable, so a deactivation and re-publication does not revise it (FR-020).
   */
  private stampPublished(definition: HeldDefinition, versionNumber: number): number {
    const version = versionOf(definition, versionNumber);
    if (version === null) return this.publishClock;
    if (version.publishedAt === null) {
      this.publishClock += 1;
      version.publishedAt = this.publishClock;
    }
    return version.publishedAt;
  }

  private definitionsFor(kind: CatalogKind): HeldDefinition[] {
    const definitions = this.held.get(kind);
    if (definitions !== undefined) return definitions;
    const created: HeldDefinition[] = [];
    this.held.set(kind, created);
    return created;
  }

  private find(kind: CatalogKind, id: string): HeldDefinition | undefined {
    return this.definitionsFor(kind).find((definition) => definition.id === id);
  }

  private storedDefinitionsOf(kind: CatalogKind): StoredDefinition[] {
    return this.definitionsFor(kind).map((definition) => {
      const activeVersion = versionOf(definition, definition.activeVersion);
      const draftVersion = versionOf(definition, definition.draftVersion);
      return {
        kind,
        id: definition.id,
        status: 'effective' as const,
        activeVersionId: idOrNull(definition.activeVersion),
        body: activeVersion === null ? null : activeVersion.body,
        draftVersionId: idOrNull(definition.draftVersion),
        draftBody: draftVersion === null ? null : draftVersion.body,
        createdAt: 0,
        updatedAt: 0,
        versions: definition.versions.map((version) => metadata(version, kind, definition.id))
      };
    });
  }

  private bump(kind: CatalogKind): string {
    const next = (this.writeCounts.get(kind) ?? 0) + 1;
    this.writeCounts.set(kind, next);
    const revision = `rev-${kind}-${next}`;
    this.revisions.set(kind, revision);
    return revision;
  }
}

function seeded(
  id: string,
  body: unknown,
  pointer: 'active' | 'draft',
  note: string | null = null
): HeldDefinition {
  return {
    id,
    versions: [{ versionNumber: 1, body, publishedAt: pointer === 'active' ? 1 : null, note }],
    activeVersion: pointer === 'active' ? 1 : null,
    draftVersion: pointer === 'draft' ? 1 : null
  };
}

/**
 * The bodies each `saveDraftLayer` wrote, one array per call.
 *
 * Feature 099 (T496f, FR-042a) — the suites this serves recorded
 * `updateConfig(key, value)` and asserted over `value`, which was the complete layer
 * as an array of rows. Feature 100 (T514) — `saveDraftLayer` carries the same layer
 * as `{ id, body }[]`, so this still projects it back to the array of rows those
 * assertions are written against. What changed underneath is that the write is a
 * merge and lands as drafts; what the assertion is about — the bodies the caller
 * decided to send — has not.
 */
export function layerWrites(store: FakeCatalogStore): readonly (readonly unknown[])[] {
  return store.draftLayerSaves.map((request) =>
    request.definitions.map((definition) => definition.body)
  );
}

/** Every write surface at once, counted. */
export interface WriteCounts {
  readonly lifecycle: number;
  readonly draftLayers: number;
  readonly publishLayers: number;
}

/** Nothing was written, anywhere. The value to compare a `writesOf` against. */
export const NO_WRITES: WriteCounts = Object.freeze({
  lifecycle: 0,
  draftLayers: 0,
  publishLayers: 0
});

/**
 * How many requests reached each write port.
 *
 * Feature 100 (T514) — a "this path writes nothing" assertion used to name the one
 * write port there was. There are three now, and naming one of them would let a
 * regression that reached either of the others pass. Counted rather than emptied,
 * because a refused write still records its request: reaching a port and being
 * turned away is the failure this is about.
 */
export function writesOf(store: FakeCatalogStore): WriteCounts {
  return {
    lifecycle: store.lifecycleWrites.length,
    draftLayers: store.draftLayerSaves.length,
    publishLayers: store.publishLayers.length
  };
}

/** The `(kind, ids)` pairs each `publishLayer` named, in call order — the FR-035 ordering. */
export function publishedLayers(
  store: FakeCatalogStore
): readonly { readonly kind: CatalogKind; readonly ids: readonly string[] }[] {
  return store.publishLayers.map((request) => ({ kind: request.kind, ids: request.ids }));
}

/** The expected-draft token for a definition the store currently holds. */
export function tokenFor(store: FakeCatalogStore, kind: CatalogKind, id: string): ExpectedDraftVersion {
  const definition = store
    .snapshot()
    .definitions.find((candidate) => candidate.kind === kind && candidate.id === id);
  return definition === undefined ? NO_DRAFT : draftTokenOf(definition.draftVersionId);
}

function metadata(version: HeldVersion, kind: CatalogKind, id: string): CatalogVersionMetadata {
  return {
    versionId: versionIdFor(version.versionNumber),
    contentHash: `sha256:${kind}-${id}-${version.versionNumber}`,
    createdAt: 0,
    publishedAt: version.publishedAt,
    note: version.note
  };
}

/**
 * Body equality as the callers observe it.
 *
 * The real store compares a SHA-256 over canonical JSON; this compares
 * `JSON.stringify` over the value as given, which agrees for every fixture body
 * (plain data, keys in a stable authored order) and is deliberately not held out as
 * the same rule. A suite about hashing belongs in `tests/unit/catalog/`.
 */
function sameBody(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
