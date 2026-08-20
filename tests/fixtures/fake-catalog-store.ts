// Feature 099 (T496f, FR-042a) — an in-memory `CatalogStore` for the suites that
// used to hand the save commands a `updateConfig(key, value, scope)` double.
//
// Those suites are not about the store. They assert what a save command sends,
// what it refuses, and what the surface is told afterwards; the settings writer
// they used was a recorder that happened to be the write port of the day. The
// write port is now `CatalogStore.saveLayer`, so this is the same recorder
// against the new port — it keeps the layer it was handed, moves a revision when
// (and only when) something changed, and records every request verbatim.
//
// It is NOT a second implementation of the store. It computes no content hash,
// writes no version records, and derives its revision from a counter rather than
// from a manifest. `tests/unit/catalog/` is where the real store's behaviour is
// asserted; a fixture that reimplemented any of it would let a caller-side test
// pass against semantics the real store does not have. What this double is
// faithful to is exactly the part the callers depend on: the expected-revision
// gate, the `unchanged` answer when a layer names nothing new, and the fact that
// un-naming an id removes it.

import type {
  CatalogKind,
  CatalogLayerSaveOutcome,
  CatalogLayerSaveRequest,
  CatalogReadResult,
  CatalogReadVersionOutcome,
  CatalogSaveOutcome,
  CatalogSaveRequest,
  CatalogSnapshot,
  CatalogVersionMetadata,
  StoredDefinition
} from '../../src/contracts/catalog-store';
import { STORE_FORMAT_VERSION } from '../../src/contracts/catalog-store';
import type { CatalogStore } from '../../src/catalog/catalog-store';
import { versionIdFor } from '../../src/catalog/catalog-paths';

/** One definition as the double holds it: a body and the version count behind it. */
interface HeldDefinition {
  readonly id: string;
  body: unknown;
  /** The version NUMBER. Version ids are `v<N>`; this is the `<N>` (FR-016). */
  versionNumber: number;
}

const KINDS: readonly CatalogKind[] = ['phase', 'pipeline', 'workflow'];

/** The rows a fake store starts with, per kind. */
export interface FakeStoreSeed {
  readonly phases?: readonly unknown[];
  readonly pipelines?: readonly unknown[];
  readonly workflows?: readonly unknown[];
  /** The revision each kind reports before any save. Defaults to `rev-<kind>-0`. */
  readonly revisions?: Partial<Record<CatalogKind, string>>;
}

/** The answer the double should give instead of performing a save. */
export type FakeStoreVerdict = CatalogLayerSaveOutcome | null;

function idOf(row: unknown, kind: CatalogKind, index: number): string {
  if (row !== null && typeof row === 'object') {
    const record = row as Record<string, unknown>;
    const candidate = record.id ?? record[`${kind}Id`];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return `${kind}-row-${index}`;
}

export class FakeCatalogStore implements CatalogStore {
  /** Every `saveLayer` request, in the order it arrived. */
  readonly layerSaves: CatalogLayerSaveRequest[] = [];
  /** Every `save` request, in the order it arrived. */
  readonly saves: CatalogSaveRequest[] = [];
  /** How many times the store was read. */
  reads = 0;

  /**
   * Set to answer the next `saveLayer` with this outcome instead of performing
   * it — the seam the refusal and stale cases drive, which they used to drive by
   * making `updateConfig` throw.
   */
  nextLayerVerdict: FakeStoreVerdict = null;

  private readonly held = new Map<CatalogKind, HeldDefinition[]>();
  private readonly revisions = new Map<CatalogKind, string>();
  private readonly saveCounts = new Map<CatalogKind, number>();

  constructor(seed: FakeStoreSeed = {}) {
    const rows: Record<CatalogKind, readonly unknown[]> = {
      phase: seed.phases ?? [],
      pipeline: seed.pipelines ?? [],
      workflow: seed.workflows ?? []
    };
    for (const kind of KINDS) {
      this.held.set(
        kind,
        rows[kind].map((row, index) => ({
          id: idOf(row, kind, index),
          body: row,
          versionNumber: 1
        }))
      );
      this.revisions.set(kind, seed.revisions?.[kind] ?? `rev-${kind}-0`);
      this.saveCounts.set(kind, 0);
    }
  }

  /** The revision the store currently reports for one kind. */
  revisionOf(kind: CatalogKind): string {
    return this.revisions.get(kind) ?? '';
  }

  /** The bodies the store currently holds for one kind, in manifest order. */
  rowsOf(kind: CatalogKind): readonly unknown[] {
    return (this.held.get(kind) ?? []).map((definition) => definition.body);
  }

  snapshot(): CatalogSnapshot {
    return {
      storeFormatVersion: STORE_FORMAT_VERSION,
      definitions: KINDS.flatMap((kind) => this.definitionsOf(kind)),
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

  async save(request: CatalogSaveRequest): Promise<CatalogSaveOutcome> {
    this.saves.push(request);
    if (request.expectedRevision !== this.revisionOf(request.kind)) {
      return { outcome: 'stale', actualRevision: this.revisionOf(request.kind) };
    }
    const definitions = this.held.get(request.kind) ?? [];
    const existing = definitions.find((definition) => definition.id === request.id);
    if (existing !== undefined && sameBody(existing.body, request.body)) {
      return {
        outcome: 'unchanged',
        versionId: versionIdFor(existing.versionNumber),
        revision: this.revisionOf(request.kind)
      };
    }
    if (existing === undefined) {
      definitions.push({ id: request.id, body: request.body, versionNumber: 1 });
    } else {
      existing.body = request.body;
      existing.versionNumber += 1;
    }
    const versionNumber =
      definitions.find((definition) => definition.id === request.id)?.versionNumber ?? 1;
    return {
      outcome: 'saved',
      versionId: versionIdFor(versionNumber),
      revision: this.bump(request.kind),
      pruned: []
    };
  }

  async saveLayer(request: CatalogLayerSaveRequest): Promise<CatalogLayerSaveOutcome> {
    this.layerSaves.push(request);
    const verdict = this.nextLayerVerdict;
    if (verdict !== null) {
      this.nextLayerVerdict = null;
      return verdict;
    }
    if (request.expectedRevision !== this.revisionOf(request.kind)) {
      return { outcome: 'stale', actualRevision: this.revisionOf(request.kind) };
    }

    const before = this.held.get(request.kind) ?? [];
    const named = new Set(request.definitions.map((definition) => definition.id));
    const removed = before
      .filter((definition) => !named.has(definition.id))
      .map((definition) => definition.id);

    const unchanged: string[] = [];
    const versions: { readonly id: string; readonly versionId: string }[] = [];
    const after: HeldDefinition[] = request.definitions.map((definition) => {
      const previous = before.find((held) => held.id === definition.id);
      if (previous !== undefined && sameBody(previous.body, definition.body)) {
        unchanged.push(definition.id);
        return { id: definition.id, body: previous.body, versionNumber: previous.versionNumber };
      }
      const versionNumber = (previous?.versionNumber ?? 0) + 1;
      versions.push({ id: definition.id, versionId: versionIdFor(versionNumber) });
      return { id: definition.id, body: definition.body, versionNumber };
    });

    if (versions.length === 0 && removed.length === 0) {
      // Nothing new and nothing un-named: the store writes nothing at all, so
      // the revision must NOT move (FR-014, FR-020).
      return { outcome: 'unchanged', revision: this.revisionOf(request.kind) };
    }

    this.held.set(request.kind, after);
    return {
      outcome: 'saved',
      revision: this.bump(request.kind),
      versions,
      unchanged,
      removed,
      pruned: []
    };
  }

  async readVersion(
    kind: CatalogKind,
    id: string,
    versionId: string
  ): Promise<CatalogReadVersionOutcome> {
    const held = (this.held.get(kind) ?? []).find((definition) => definition.id === id);
    if (held === undefined || versionIdFor(held.versionNumber) !== versionId) {
      return { outcome: 'absent' };
    }
    return { outcome: 'read', record: { versionId, kind, id, body: held.body } };
  }

  async listVersions(kind: CatalogKind, id: string): Promise<readonly CatalogVersionMetadata[]> {
    const held = (this.held.get(kind) ?? []).find((definition) => definition.id === id);
    if (held === undefined) return [];
    return Array.from({ length: held.versionNumber }, (_unused, index) =>
      metadata(index + 1, kind, id)
    );
  }

  async listDefinitions(kind: CatalogKind): Promise<readonly StoredDefinition[]> {
    return this.definitionsOf(kind);
  }

  private definitionsOf(kind: CatalogKind): StoredDefinition[] {
    return (this.held.get(kind) ?? []).map((definition) => ({
      kind,
      id: definition.id,
      status: 'effective' as const,
      activeVersionId: versionIdFor(definition.versionNumber),
      body: definition.body,
      createdAt: 0,
      updatedAt: 0,
      versions: [metadata(definition.versionNumber, kind, definition.id)]
    }));
  }

  private bump(kind: CatalogKind): string {
    const next = (this.saveCounts.get(kind) ?? 0) + 1;
    this.saveCounts.set(kind, next);
    const revision = `rev-${kind}-${next}`;
    this.revisions.set(kind, revision);
    return revision;
  }
}

/**
 * The bodies each `saveLayer` wrote, one array per call.
 *
 * Feature 099 (T496f, FR-042a) — the suites this serves recorded
 * `updateConfig(key, value)` and asserted over `value`, which was the complete
 * layer as an array of rows. `saveLayer` carries the same layer as
 * `{ id, body }[]`, so this projects it back to the array of rows those
 * assertions are written against: the claim under test is what the command
 * decided to persist, and that has not changed.
 */
export function layerWrites(store: FakeCatalogStore): readonly (readonly unknown[])[] {
  return store.layerSaves.map((request) =>
    request.definitions.map((definition) => definition.body)
  );
}

function metadata(
  versionNumber: number,
  kind: CatalogKind,
  id: string
): CatalogVersionMetadata {
  return {
    versionId: versionIdFor(versionNumber),
    contentHash: `sha256:${kind}-${id}-${versionNumber}`,
    createdAt: 0,
    publishedAt: 0,
    note: null
  };
}

/**
 * Body equality as the callers observe it.
 *
 * The real store compares a SHA-256 over canonical JSON; this compares
 * `JSON.stringify` over the value as given, which agrees for every fixture body
 * (plain data, keys in a stable authored order) and is deliberately not held out
 * as the same rule. A suite about hashing belongs in `tests/unit/catalog/`.
 */
function sameBody(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
