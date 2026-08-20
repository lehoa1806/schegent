// Feature 099 (FR-R3-015) T475, T476 — the versioned catalog store's shapes.
//
// Two families live here, and the split is deliberate:
//
//   1. **On disk** — `CatalogManifest`, `CatalogManifestEntry`, `CatalogVersionRecord`.
//      Durable, versioned by `storeFormatVersion`, forward-only. A change to any of
//      these is a format change.
//   2. **Outcomes** — the unions the store returns. Every failure is a returned
//      value rather than a throw, so the pure core needs no `try`/`catch` around
//      I/O and there is nowhere for a compensating delete to be written (FR-029).
//
// Declared under `src/contracts/` rather than in `src/catalog/` so the sidebar
// contract barrel can read the kind and the outcome names without importing the
// store, and so the store's own directory holds only logic.

/** The three definition kinds the store holds (FR-003). */
export const CATALOG_KINDS = ['phase', 'pipeline', 'workflow'] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

/**
 * The only `storeFormatVersion` this build understands.
 *
 * Forward-only: a manifest declaring a *higher* value is refused by name rather
 * than read on a best-effort basis (FR-032). A best-effort read of a format you
 * do not understand is how you write back a manifest a newer build cannot read.
 */
export const STORE_FORMAT_VERSION = 1;

/** Retained versions per definition before pruning starts (FR-034). */
export const CATALOG_RETENTION_BOUND = 50;

/**
 * The legal shape of a definition id in the store (FR-033).
 *
 * The same pattern as `PHASE_ID_PATTERN`, `PIPELINE_ID_PATTERN`, and the workflow
 * validator's, restated rather than imported because those live in modules that
 * reach the runner factory and the host, and `src/catalog/` may reach neither
 * (FR-057). `catalog-id-pattern-agrees.test.ts` pins the four to each other, so
 * the restatement cannot drift into a store that accepts an id the validators
 * reject — an id the store accepts becomes a directory name.
 */
export const CATALOG_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * A version id: `v<N>`, `N >= 1`, monotonic per definition (FR-005).
 *
 * Never reused and never recycled after a prune, so a definition legitimately
 * holds `v41`-`v90` once retention has run.
 */
export type CatalogVersionId = string;

/**
 * One version's metadata, as the manifest holds it.
 *
 * Every time is epoch milliseconds (FR-021a). An integer, not an ISO string:
 * this file is a durable forward-only format that two windows read at once, and
 * an integer leaves no offset, precision, or locale choice for two writers to
 * differ on. Times here are compared and ordered, never displayed from here.
 */
export interface CatalogVersionMetadata {
  readonly versionId: CatalogVersionId;
  /** `sha256:<lowercase hex>` over the canonical form of the body (FR-012). */
  readonly contentHash: string;
  readonly createdAt: number;
  /**
   * When this version became active.
   *
   * INERT in this feature: a save is a publish, so it always equals `createdAt`.
   * FR-R3-016 separates them (FR-009).
   */
  readonly publishedAt: number | null;
  /** Reserved. No surface writes this in this feature. */
  readonly note: string | null;
}

/**
 * One definition's entry in the manifest.
 *
 * The manifest is the single ordering point (FR-002): `versions` here is the
 * authority on what exists and in what order, and a record on disk that this
 * list does not name is collectable rather than part of the history (FR-026).
 */
export interface CatalogManifestEntry {
  readonly kind: CatalogKind;
  readonly id: string;
  /** INERT in this feature — always `null` (FR-009). */
  readonly draftVersionId: CatalogVersionId | null;
  readonly activeVersionId: CatalogVersionId | null;
  /** First save. Never moves (FR-019). */
  readonly createdAt: number;
  /** Last *effective* save. An unchanged save does not move it (FR-020). */
  readonly updatedAt: number;
  /** Monotonic version order, oldest first — which is also the prune order (FR-018, FR-035). */
  readonly versions: readonly CatalogVersionMetadata[];
}

/**
 * `manifest.json` — the only mutable file in the store (FR-002).
 *
 * `entries` order is not significant and MUST NOT be relied on; entries are
 * looked up by `(kind, id)`.
 */
export interface CatalogManifest {
  readonly storeFormatVersion: number;
  readonly entries: readonly CatalogManifestEntry[];
}

/**
 * An immutable version record at `<kind>/<id>/<versionId>.json` (FR-007, FR-008).
 *
 * The record repeats its own identity so a record found without a manifest entry
 * is self-describing — which is what lets FR-026 report a collectable record by
 * name rather than as an anonymous stray file.
 *
 * It deliberately carries no `contentHash`: the manifest holds it, and a second
 * copy would be a second authority that can disagree with the first.
 */
export interface CatalogVersionRecord {
  readonly versionId: CatalogVersionId;
  readonly kind: CatalogKind;
  readonly id: string;
  /** The definition exactly as authored. Never normalised, never validated here (FR-010, FR-011). */
  readonly body: unknown;
}

/**
 * Something is wrong, and a definition or the store is affected.
 *
 * A **collectable record is not in this union** — see `CatalogCollectableRecord`.
 * An **absent** manifest is not in it either: an absent store is a successful
 * empty read (FR-001a), which is why `unreadable-manifest` has no `absent`
 * reason. The two are one character apart in code and opposite in behaviour.
 *
 * No arm carries a path. Faults carry kind, id, and version id, which is what
 * FR-061 requires and what the segment-addressed core makes automatic.
 */
export type CatalogIntegrityFault =
  /** The manifest names a version whose record is missing: this definition is unreadable (FR-027). */
  | {
      readonly fault: 'dangling-record';
      readonly kind: CatalogKind;
      readonly id: string;
      readonly versionId: CatalogVersionId;
    }
  /** A record exists but does not hash to the value the manifest recorded for it. */
  | {
      readonly fault: 'hash-mismatch';
      readonly kind: CatalogKind;
      readonly id: string;
      readonly versionId: CatalogVersionId;
    }
  /** The manifest is present and cannot be read. Never repaired by writing a fresh one (FR-031). */
  | { readonly fault: 'unreadable-manifest'; readonly reason: 'empty' | 'malformed' | 'shape' }
  /** A `storeFormatVersion` this build does not understand (FR-032). */
  | { readonly fault: 'unsupported-format'; readonly found: number; readonly supported: number }
  /** The manifest could not be read at all — an I/O failure, not a content problem. */
  | { readonly fault: 'unreadable-store'; readonly errno: string };

/**
 * A record on disk the manifest does not name.
 *
 * **Not a fault** (FR-026). The definition resolves normally, the catalog is
 * healthy, and the store deletes nothing — collection is an operator's decision,
 * not the store's. A separate type rather than an arm of `CatalogIntegrityFault`
 * because "collectable" and "dangling" are the pair most easily collapsed into
 * each other: both are a record and a manifest entry disagreeing, differing only
 * in which side is missing. Keeping the healthy case out of a union named for
 * faults means no consumer has to remember to filter it back out.
 */
export interface CatalogCollectableRecord {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly versionId: CatalogVersionId;
}

/** How a definition reads out of the store, after `shadowed` is deleted (FR-040). */
export type CatalogDefinitionStatus = 'effective' | 'invalid';

/** One definition as the snapshot presents it. Carries no scope and no layer id (FR-043). */
export interface StoredDefinition {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly status: CatalogDefinitionStatus;
  readonly activeVersionId: CatalogVersionId | null;
  /**
   * The active version's body, or `null` when there is none to read.
   *
   * Two ways to be `null`, and they are not the same: `status` is `invalid` (the
   * record could not be read), or the entry names no active version — which this
   * feature's save path never produces (FR-009) and FR-R3-016's draft-only entry
   * will.
   */
  readonly body: unknown | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly versions: readonly CatalogVersionMetadata[];
}

/**
 * The store read once into memory (FR-027a).
 *
 * Built by one pass over the manifest and the records it names, and then read
 * synchronously by every resolver and projection downstream — which is what lets
 * those keep their synchronous signatures while the store's I/O is async.
 */
export interface CatalogSnapshot {
  readonly storeFormatVersion: number;
  readonly definitions: readonly StoredDefinition[];
  readonly faults: readonly CatalogIntegrityFault[];
  readonly collectable: readonly CatalogCollectableRecord[];
  /** Derived from the manifest's stored state, never persisted (FR-044a). */
  readonly revisions: Readonly<Record<CatalogKind, string>>;
}

/**
 * The result of reading the store.
 *
 * An **absent** store is `{outcome: 'read'}` with an empty snapshot, not
 * `unavailable` (FR-001a, SC-018). Per-definition faults never reach this union:
 * they ride inside `snapshot.faults` and leave every other definition resolving
 * (FR-027, SC-005).
 */
export type CatalogReadResult =
  | { readonly outcome: 'read'; readonly snapshot: CatalogSnapshot }
  | { readonly outcome: 'unavailable'; readonly fault: CatalogIntegrityFault };

/** Why a save was refused before anything was written. */
export type CatalogSaveRefusal =
  /** The id does not match `CATALOG_ID_PATTERN` (FR-033). */
  | 'illegal-id'
  /**
   * Two ids of the same kind fold to the same name (FR-033).
   *
   * Two spellings differing only by case cannot coexist as directories on a
   * case-insensitive filesystem, and two entries for one `(kind, id)` are not
   * representable in the manifest at all. Both are the same refusal because both
   * are one name claimed twice.
   */
  | 'id-case-collision'
  /** No workspace folder is open, so there is no store to write (FR-033a). */
  | 'no-workspace'
  /** The store path cannot be written. A write fault, never an integrity fault (FR-033b). */
  | 'not-writable'
  /** The manifest declares a format this build does not understand (FR-032). */
  | 'unsupported-format'
  /**
   * The manifest is present and cannot be read, so a write would be a write over
   * history the store cannot see (FR-031).
   *
   * Distinct from `unsupported-format`, which is a format this build understands
   * the *shape* of and refuses on purpose. Every failure is a returned value in
   * this store (FR-029), so refusing by name is the only alternative to throwing.
   */
  | 'store-unreadable'
  /** The definition is in a fault state; saving over it would compound the fault. */
  | 'definition-invalid'
  /** The target `versionId` already has a record. Records are write-once (FR-030). */
  | 'version-exists'
  /** The body cannot be canonicalised, so it cannot be hashed (FR-013). */
  | 'uncanonical-body';

export interface CatalogSaveRequest {
  readonly kind: CatalogKind;
  readonly id: string;
  /** Stored verbatim. Never validated and never normalised here (FR-010, FR-011). */
  readonly body: unknown;
  /** The retained staleness gate (FR-044). */
  readonly expectedRevision: string;
  readonly note?: string;
}

export type CatalogSaveOutcome =
  | {
      readonly outcome: 'saved';
      readonly versionId: CatalogVersionId;
      readonly revision: string;
      /** Version ids retention removed, oldest first. Empty when nothing was pruned (FR-035). */
      readonly pruned: readonly CatalogVersionId[];
    }
  /** The body hashes equal to the **active** version: no record, no timestamp move (FR-014). */
  | { readonly outcome: 'unchanged'; readonly versionId: CatalogVersionId; readonly revision: string }
  /** Another writer moved the revision. The refusal the expected-revision gate gives today (SC-019). */
  | { readonly outcome: 'stale'; readonly actualRevision: string }
  | { readonly outcome: 'refused'; readonly reason: CatalogSaveRefusal }
  /**
   * A prefix landed and **stays written** (FR-028, FR-029).
   *
   * Returned when the version record was written and the manifest write then
   * failed. The record stays on disk, where the next read reports it as
   * collectable and the definition still resolves at its previous version. This
   * is not an error to be retried by deleting the record: there is no
   * compensating delete on any path.
   */
  | {
      readonly outcome: 'partial';
      readonly wrote: readonly CatalogVersionId[];
      readonly errno: string;
    };

/**
 * One definition inside a whole-layer write.
 *
 * Feature 099 (T493d) — the save commands still send a complete layer and the
 * host still re-derives the diff (FR-047); per-definition writes arrive with
 * FR-R3-016. So the store needs a write whose unit is the layer.
 */
export interface CatalogLayerDefinition {
  readonly id: string;
  /** Stored verbatim. Never validated and never normalised here (FR-010, FR-011). */
  readonly body: unknown;
}

/**
 * A complete layer of one kind, written under one expected revision.
 *
 * `definitions` is the layer in full: an id of this kind that the manifest holds
 * and this list does not name is **removed** — its manifest entry goes and its
 * version records stay on disk, where the next read reports them as collectable
 * (FR-026). Un-naming is the removal; the store deletes no history.
 *
 * One request rather than N calls to `save` because the gate is per kind
 * (FR-044): the first `save` would move the revision and the second would refuse
 * itself as stale. One request is also one manifest write, so a package import of
 * twelve Phases is one ordering decision rather than twelve.
 */
export interface CatalogLayerSaveRequest {
  readonly kind: CatalogKind;
  readonly definitions: readonly CatalogLayerDefinition[];
  /** The retained staleness gate, over the whole kind (FR-044). */
  readonly expectedRevision: string;
  readonly note?: string;
}

/** One definition's new version, in the order the layer named it. */
export interface CatalogLayerVersion {
  readonly id: string;
  readonly versionId: CatalogVersionId;
}

/** What retention took out of one definition's history, oldest first (FR-035). */
export interface CatalogLayerPruned {
  readonly id: string;
  readonly versionIds: readonly CatalogVersionId[];
}

export type CatalogLayerSaveOutcome =
  | {
      readonly outcome: 'saved';
      readonly revision: string;
      readonly versions: readonly CatalogLayerVersion[];
      /** Ids whose body hashed equal to their active version: no record written (FR-014). */
      readonly unchanged: readonly string[];
      /** Ids the manifest no longer names. Their records remain, collectable (FR-026). */
      readonly removed: readonly string[];
      readonly pruned: readonly CatalogLayerPruned[];
    }
  /**
   * Every definition hashed equal and nothing was removed: **nothing is written**,
   * not even the manifest (FR-014, FR-020).
   *
   * Writing an identical manifest would move the revision, and a moved revision is
   * how opening an editor and closing it manufactures a stale save in the other
   * window.
   */
  | { readonly outcome: 'unchanged'; readonly revision: string }
  | { readonly outcome: 'stale'; readonly actualRevision: string }
  /** Refused before anything was written. `id` names the offending definition where one does. */
  | { readonly outcome: 'refused'; readonly reason: CatalogSaveRefusal; readonly id: string | null }
  /** A prefix landed and stays written (FR-028, FR-029). Labels are `<id>@<versionId>`. */
  | { readonly outcome: 'partial'; readonly wrote: readonly string[]; readonly errno: string };

/** Reading a past version writes nothing and moves no timestamp (FR-017, SC-003). */
export type CatalogReadVersionOutcome =
  | { readonly outcome: 'read'; readonly record: CatalogVersionRecord }
  /** The record the manifest names is missing — the dangling case, from the caller's side. */
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'refused'; readonly reason: CatalogSaveRefusal };
