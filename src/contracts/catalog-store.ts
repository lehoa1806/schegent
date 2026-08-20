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

// `catalog-lifecycle.ts` imports this file's types and this file imports its
// `ExpectedDraftVersion`. Both directions are `import type` and are erased at emit,
// so there is no runtime cycle — only the two halves of one contract, split so the
// pointer-pair projection sits beside the operations that move the pointers.
import type { ExpectedDraftVersion } from './catalog-lifecycle';

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
   * When this version first became active, or `null` while it never has (FR-020).
   *
   * Stamped once, by the publication that promoted it — a version deactivated and
   * published again keeps its original time, because it is the same immutable
   * version it always was. `createdAt` says when the draft was written; the two
   * differ by however long the draft sat unpublished.
   */
  readonly publishedAt: number | null;
  /** The operator's note on the draft write that produced this version (FR-013a). */
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
  /**
   * The pending draft, or `null` when there is none (FR-009).
   *
   * Never equal to `activeVersionId`: publishing moves both pointers in one
   * expression, so no state — on disk or in memory — has one version in both.
   */
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
   * The **active** version's body, or `null` when there is none to read.
   *
   * Two ways to be `null`, and they are not the same: `status` is `invalid` (the
   * record could not be read), or the entry names no active version — the
   * draft-only entry feature 100 introduces.
   *
   * Feature 100 (T498a) keeps this field meaning the active body and adds
   * `draftBody` beside it rather than widening this one. Every downstream
   * projection (`storedRows`, the three resolvers) reads `body` and therefore
   * keeps its current behaviour with no edit: a draft-only definition drops out of
   * the effective catalog because its `body` is null, which is precisely FR-007.
   */
  readonly body: unknown | null;
  /** Feature 100 (FR-004). `null` when the definition has no pending draft. */
  readonly draftVersionId: CatalogVersionId | null;
  /**
   * The **draft** version's body, or `null` when there is no draft to read.
   *
   * Read by the authoring surface and by the publish gate. Never by a resolver:
   * a draft is not part of the effective catalog and nothing that decides what
   * runs may see it (FR-007, FR-008).
   */
  readonly draftBody: unknown | null;
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

// ---------------------------------------------------------------------------
// The write surface — feature 100 (FR-R3-016) T498b
//
// Feature 099's `save` / `saveLayer` are gone. They wrote one thing (a new active
// version) and their callers declared their intent by *diffing* against what was
// there. Feature 100's five operations move different pointers for different
// reasons, so each write now declares which one it is.
//
// `LifecycleWrite` is a **closed union**, and that is the point: the store holds
// exactly one copy of feature 099's write sequence — probe writability, load the
// manifest, write the record before the manifest entry, run retention, derive the
// revision — and dispatches inside it. A second manifest writer would be a second
// copy of the atomic ordering, and two copies drift.
// ---------------------------------------------------------------------------

/**
 * Common to every single-definition write.
 *
 * `expectedDraftVersion` travels *into* the store rather than being checked by the
 * caller beforehand, for the same reason 099's `expectedRevision` did: the gate has
 * to be evaluated against the manifest the write itself loaded, or a concurrent
 * writer can land between the caller's check and the caller's write.
 */
interface LifecycleWriteBase {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly expectedDraftVersion: ExpectedDraftVersion;
}

/**
 * The one instruction the lifecycle service issues to the store.
 *
 * Only `save-draft` and `restore` write a version record. `publish`, `deactivate`,
 * and `discard-draft` move pointers inside a single manifest write and write no
 * record at all — which is what makes them atomic without a cross-file transaction.
 */
export type LifecycleWrite =
  /** Writes a record, points the draft pointer at it. The active pointer is not read. */
  | (LifecycleWriteBase & {
      readonly op: 'save-draft';
      /** Stored verbatim. Never validated and never normalised here (FR-010, FR-011). */
      readonly body: unknown;
      readonly note?: string;
    })
  /**
   * Writes a record carrying an older version's body, points the draft pointer at
   * it. Only the body is copied — `createdAt`, `publishedAt`, and `note` belong to
   * the version it came from (FR-030).
   */
  | (LifecycleWriteBase & {
      readonly op: 'restore';
      readonly body: unknown;
      /** For reporting only; the store has already been handed the body. */
      readonly fromVersionId: CatalogVersionId;
    })
  /** Active ← draft, draft ← null, `publishedAt` stamped, retention run. One manifest write. */
  | (LifecycleWriteBase & { readonly op: 'publish' })
  /**
   * Active ← null, and where there is no pending draft, draft ← the version that
   * was active (FR-024a). No record written and no body copied: the entry survives,
   * so the retained version list survives with it.
   */
  | (LifecycleWriteBase & { readonly op: 'deactivate' })
  /** Draft ← null, and the entry is removed when that leaves no active version (FR-034). */
  | (LifecycleWriteBase & { readonly op: 'discard-draft' });

/**
 * One definition's pointer pair as the store found it.
 *
 * Carried on every arm the caller has to explain to an operator, so a refusal is
 * built from the manifest the write actually loaded rather than from a second read
 * taken afterwards — which would be a different manifest and a different answer.
 */
export interface LifecycleWritePointers {
  readonly draftVersionId: CatalogVersionId | null;
  readonly activeVersionId: CatalogVersionId | null;
  /** `false` when the manifest holds no entry for this `(kind, id)` at all. */
  readonly present: boolean;
}

/**
 * What the store did, reported flatly.
 *
 * One `written` arm rather than five, because the caller issued the write and
 * therefore already knows which operation it was; discriminating a second time on
 * the way back would duplicate that knowledge in the one place it cannot diverge
 * usefully. Fields that only some operations produce are explicitly `null` on the
 * others rather than absent.
 */
export type LifecycleWriteOutcome =
  | {
      readonly outcome: 'written';
      /** Both pointers as the manifest now holds them. `null`/`null` only with `entryRemoved`. */
      readonly draftVersionId: CatalogVersionId | null;
      readonly activeVersionId: CatalogVersionId | null;
      /** The record this write created. `null` for the three pointer-only operations. */
      readonly writtenVersionId: CatalogVersionId | null;
      /** Stamped by `publish` only, once, on the version that became active (FR-020). */
      readonly publishedAt: number | null;
      /** Version ids retention removed, oldest first. Empty when nothing was pruned (FR-021). */
      readonly pruned: readonly CatalogVersionId[];
      /** `discard-draft` only. The one operation that can clear the last pointer (FR-034). */
      readonly entryRemoved: boolean;
      readonly revision: string;
    }
  /** The body hashes equal to the definition's **head** — no record written (FR-011a). */
  | { readonly outcome: 'unchanged'; readonly versionId: CatalogVersionId; readonly revision: string }
  /**
   * The draft pointer is not where the caller last saw it (FR-012).
   *
   * Per definition, and over the **draft pointer only** — a publication or a
   * deactivation elsewhere, or of this same definition's active pointer, never
   * invalidates an in-flight edit.
   */
  | { readonly outcome: 'stale'; readonly pointers: LifecycleWritePointers }
  /**
   * The gate passed and the operation's own precondition does not hold in the
   * manifest the write loaded — publish or discard with no draft, deactivate with
   * nothing active, or any pointer operation on a definition with no entry.
   *
   * The service checks all of these before issuing, so this arm is only ever a
   * genuine race with another window. It exists rather than being folded into
   * `stale` because the draft pointer may be exactly where the caller left it: the
   * assumption that failed was about the *other* pointer, and saying "stale draft"
   * would send the operator looking at the wrong one.
   */
  | { readonly outcome: 'not-applicable'; readonly pointers: LifecycleWritePointers }
  | { readonly outcome: 'refused'; readonly reason: CatalogSaveRefusal }
  /**
   * A prefix landed and **stays written** (FR-028, FR-029).
   *
   * Reachable from `save-draft` and `restore` only — the two record-writing arms.
   * The record stays on disk, where the next read reports it as collectable and the
   * definition still resolves at its previous version. There is no compensating
   * delete on any path.
   */
  | {
      readonly outcome: 'partial';
      readonly wrote: readonly CatalogVersionId[];
      readonly errno: string;
    };

// ---------------------------------------------------------------------------
// The two layer writes — feature 100 (FR-R3-016) T504a
//
// A package import writes many definitions of one kind, and the staleness gate is
// per kind (FR-036). N single-definition writes would be N manifest writes, and the
// first would move the revision the rest are gated on.
//
// **Merge, not replace** (FR-039b). This is the one behavioural difference from the
// deleted `saveLayer`: an id of this kind that the manifest holds and the request
// does not name is left exactly as it is. `saveLayer` treated an unnamed id as a
// removal, which was right when its caller always sent the complete layer and is
// catastrophic here — a document naming two of five stored Phases would delete the
// other three. Every single-definition test passes either way, which is why the
// property has a requirement of its own rather than only a checklist item.
// ---------------------------------------------------------------------------

/** One definition inside a layer write. */
export interface CatalogLayerDefinition {
  readonly id: string;
  /** Stored verbatim. Never validated and never normalised here (FR-010, FR-011). */
  readonly body: unknown;
}

/**
 * Write drafts for the named definitions of one kind, under one revision gate.
 *
 * Merge semantics — see the note above. Every definition named lands as a **Draft**
 * (FR-041): nothing here touches an active pointer, so an import can never change
 * what runs.
 */
export interface SaveDraftLayerRequest {
  readonly kind: CatalogKind;
  readonly definitions: readonly CatalogLayerDefinition[];
  /** The retained per-kind staleness gate (FR-036). */
  readonly expectedRevision: string;
  readonly note?: string;
}

/** Publish exactly the named definitions of one kind, under one revision gate. */
export interface PublishLayerRequest {
  readonly kind: CatalogKind;
  /** Exactly the ids the matching `saveDraftLayer` wrote — never "everything drafted". */
  readonly ids: readonly string[];
  readonly expectedRevision: string;
}

/** One definition's new version, in the order the layer named it. */
export interface CatalogLayerVersion {
  readonly id: string;
  readonly versionId: CatalogVersionId;
}

/** What retention took out of one definition's history, oldest first (FR-021). */
export interface CatalogLayerPruned {
  readonly id: string;
  readonly versionIds: readonly CatalogVersionId[];
}

export type SaveDraftLayerOutcome =
  | {
      readonly outcome: 'saved';
      readonly revision: string;
      readonly versions: readonly CatalogLayerVersion[];
      /** Ids whose body hashed equal to their head: no record written (FR-011a). */
      readonly unchanged: readonly string[];
      /**
       * What retention removed to make room for the versions above (FR-035).
       *
       * A draft write appends a version, so it prunes on exactly the same terms as a
       * publication does, and the single-definition save path has always said so. A
       * layer save that stayed silent about it would delete an operator's history and
       * report nothing — the one removal in an append-only store, unreported.
       */
      readonly pruned: readonly CatalogLayerPruned[];
    }
  /**
   * Every named definition hashed equal: **nothing is written**, not even the
   * manifest (FR-011a).
   *
   * Writing an identical manifest would move the revision, and a moved revision is
   * how opening an editor and closing it manufactures a stale save in another
   * window.
   *
   * There is deliberately no `removed` field on either arm: merge semantics remove
   * nothing, so a field for it would only ever be empty and would invite a caller to
   * believe removal is on the table.
   */
  | { readonly outcome: 'unchanged'; readonly revision: string }
  | { readonly outcome: 'stale'; readonly actualRevision: string }
  /** Refused before anything was written. `id` names the offending definition where one does. */
  | { readonly outcome: 'refused'; readonly reason: CatalogSaveRefusal; readonly id: string | null }
  /** A prefix landed and stays written (FR-037, FR-038). Labels are `<id>@<versionId>`. */
  | { readonly outcome: 'partial'; readonly wrote: readonly string[]; readonly errno: string };

/** One definition made live by a layer publication. */
export interface CatalogLayerPublished {
  readonly id: string;
  readonly activeVersionId: CatalogVersionId;
  readonly publishedAt: number;
}

/**
 * No `partial` arm, and that is a property rather than an omission: a layer
 * publication writes no version records, so it is one manifest write and there is
 * no prefix it can leave behind. Retention's file removals run after that write and
 * are not part of its success.
 */
export type PublishLayerOutcome =
  | {
      readonly outcome: 'published';
      readonly revision: string;
      readonly published: readonly CatalogLayerPublished[];
      /**
       * Named ids that had no pending draft to publish.
       *
       * Not a failure and not silence: the ordinary cause is a document re-imported
       * unchanged, where the draft write short-circuited because the content already
       * equals what is live. The definition is already live at that content, so
       * there is nothing to publish and nothing wrong.
       */
      readonly skipped: readonly string[];
      readonly pruned: readonly CatalogLayerPruned[];
    }
  | { readonly outcome: 'stale'; readonly actualRevision: string }
  | { readonly outcome: 'refused'; readonly reason: CatalogSaveRefusal; readonly id: string | null };

/** Reading a past version writes nothing and moves no timestamp (FR-017, SC-003). */
export type CatalogReadVersionOutcome =
  | { readonly outcome: 'read'; readonly record: CatalogVersionRecord }
  /** The record the manifest names is missing — the dangling case, from the caller's side. */
  | { readonly outcome: 'absent' }
  | { readonly outcome: 'refused'; readonly reason: CatalogSaveRefusal };
