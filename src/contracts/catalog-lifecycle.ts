// Feature 100 (FR-R3-016) T497, T497a, T498 — the draft/publish lifecycle's shapes.
//
// Feature 099 declared `draftVersionId` and `publishedAt` in the manifest and left
// them inert. This feature animates them, and the whole design rests on one
// decision: **lifecycle state is the pair of pointers and nothing else** (FR-001).
//
// A stored `state` enum would be a second representation of the same fact, free to
// disagree with the pointers the first time an operation updates one and not the
// other. That is the `DATA-05` defect this file exists to avoid, so the projection
// below is a function and there is nowhere to persist its result.
//
// Declared under `src/contracts/` for the same reason `catalog-store.ts` is: the
// sidebar contracts and the webview read these names without importing the store,
// and `src/catalog/` keeps only logic.

import type { CatalogKind, CatalogManifestEntry, CatalogVersionId } from './catalog-store';

/**
 * The three states a definition can be in (FR-002, FR-003, FR-004).
 *
 * **Three literals, no fourth arm.** A definition with neither pointer set has no
 * manifest entry at all (FR-005), so "neither" is the absence of a definition
 * rather than a state one can be in. Keeping it out of the union is what makes the
 * invariant checkable by the type system instead of by a convention: there is no
 * `'none'` for a caller to handle, and no `null` return for one to forget.
 */
export type DefinitionState = 'draft' | 'active' | 'active-with-draft';

/**
 * The single shared projection from pointers to state (FR-006).
 *
 * Every surface calls this on the entry it holds. Two surfaces computing the state
 * two ways is how they come to disagree about what is live.
 *
 * @throws never — but see the `active-with-draft` note: an entry with neither
 * pointer set cannot exist (FR-005), and this returns `'draft'` for it rather than
 * widening the union. Such an entry is a manifest the shape check already refuses.
 */
export function deriveDefinitionState(entry: CatalogManifestEntry): DefinitionState {
  return definitionStateOf(entry.draftVersionId, entry.activeVersionId);
}

/**
 * The same derivation, from the two pointers alone.
 *
 * The lifecycle service builds a refusal's `current` record from the pointers the
 * store reports back rather than from an entry it no longer holds, and that record
 * must carry the same state a read of the entry would give. One derivation, two
 * call shapes: a second `if` chain here is a second place for the mapping to drift.
 */
export function definitionStateOf(
  draftVersionId: CatalogVersionId | null,
  activeVersionId: CatalogVersionId | null
): DefinitionState {
  if (activeVersionId === null) return 'draft';
  return draftVersionId === null ? 'active' : 'active-with-draft';
}

/**
 * The expected-draft-version sentinel meaning "this definition has no draft".
 *
 * A literal rather than `null` so the token is always a string and the comparison
 * is always the same comparison. `CATALOG_ID_PATTERN`-shaped version ids are
 * `v<N>`, so nothing the store issues can collide with it and no encoding is
 * needed to keep the two apart (FR-012a).
 */
export const NO_DRAFT = 'no-draft' as const;

/**
 * The per-definition staleness token (FR-012, FR-012a, FR-012b).
 *
 * Names the **draft pointer only**. The active pointer is excluded on purpose: a
 * publication or a deactivation of the same definition in another window must not
 * invalidate an in-flight edit, because the edit is against the draft and the
 * draft did not move.
 *
 * `NO_DRAFT` is what makes first-draft creation race-safe — two windows both
 * holding it produce one success and one staleness refusal, where a `null` gate
 * would let the second silently overwrite the first.
 */
export type ExpectedDraftVersion = CatalogVersionId | typeof NO_DRAFT;

/**
 * The token for a draft pointer, including the absent one.
 *
 * The single place `null` becomes `NO_DRAFT`. The store gates on this and the
 * service builds its refusals from it; two spellings of the same conversion is how
 * a first-draft race stops being detected.
 */
export function draftTokenOf(draftVersionId: CatalogVersionId | null): ExpectedDraftVersion {
  return draftVersionId ?? NO_DRAFT;
}

/** What a definition's expected-draft token is, given its entry. */
export function currentDraftToken(entry: CatalogManifestEntry): ExpectedDraftVersion {
  return draftTokenOf(entry.draftVersionId);
}

/**
 * One cross-reference defect, normalised across kinds.
 *
 * `PipelineFieldError` and `WorkflowFieldError` differ only in whether the id
 * field is called `pipelineId` or `workflowId`; the publish gate reports both, so
 * it flattens them to one shape rather than returning a union a caller has to
 * discriminate to read a message out of.
 */
export interface ValidationDefect {
  readonly kind: CatalogKind;
  readonly id: string;
  /** Positional where the source is, e.g. `phaseIds[2]`, `connections[0].to`. */
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

/**
 * An active definition that stops another from leaving service (FR-025).
 *
 * Direct references per kind (FR-025b): a Phase is blocked by the Pipelines that
 * bind it and never by the Workflows above them. The Pipeline is what the operator
 * must fix, and fixing it revalidates the Workflow at its next publication.
 */
export interface ReferenceBlocker {
  readonly kind: CatalogKind;
  readonly id: string;
  /** Where the reference sits, e.g. `phaseIds[1]`, `nodes[0].pipelineId`. */
  readonly field: string;
}

/**
 * Something the operator should know that does **not** block (FR-025a, FR-061).
 *
 * Non-blocking by construction: an advisory rides on a *successful* outcome as
 * well as on a refusal, and no code path turns one into a blocker. A Draft holding
 * the only reference cannot be triggered, and a configured default is operator-owned
 * configuration this feature reports rather than edits (FR-059).
 */
export interface LifecycleAdvisory {
  readonly advisory: 'draft-reference' | 'configured-default';
  /** The referencing definition's kind. Absent for `configured-default`. */
  readonly kind: CatalogKind | null;
  /** The referencing definition's id, or the setting's subject. */
  readonly id: string;
}

/**
 * Why an operation was refused. A closed union, never free text (FR-015).
 *
 * Free-text reasons are how a refusal becomes unhandleable: the webview can only
 * print it, and no test can assert which refusal it got.
 */
export type LifecycleRefusalReason =
  /** The expected-draft token does not match the definition's draft pointer (FR-012). */
  | 'stale-draft'
  /** No entry for this `(kind, id)`. */
  | 'no-definition'
  /** Publish or discard on a definition with no draft (FR-023). */
  | 'no-draft'
  /** Deactivate on a definition with no active version. Also guards a double-deactivate. */
  | 'not-active'
  /** The candidate does not validate. `defects` carries all of them (FR-019). */
  | 'validation-failed'
  /** An active definition still references this one. `blockers` carries all (FR-025). */
  | 'referenced'
  /** The requested version is absent or fails its integrity check (FR-031). */
  | 'version-unreadable'
  /** The store refused the write. Carries the store's own reason. */
  | 'store-refused';

/** What the operator can legally do from the state the refusal reports. */
export type LifecycleAction =
  | 'save-draft'
  | 'publish'
  | 'deactivate'
  | 'restore'
  | 'discard-draft';

/**
 * The authoritative current state of one definition, as a refusal reports it.
 *
 * Freshly read at the moment of the refusal — this is what makes a refusal
 * actionable rather than merely informative: the operator's next attempt uses the
 * token named here instead of re-reading and guessing.
 */
export interface DefinitionRecord {
  readonly kind: CatalogKind;
  readonly id: string;
  /** `null` when the definition has no entry at all. */
  readonly state: DefinitionState | null;
  readonly draftVersionId: CatalogVersionId | null;
  readonly activeVersionId: CatalogVersionId | null;
  readonly expectedDraftVersion: ExpectedDraftVersion;
}

/**
 * A rejected operation, as a returned value (FR-015).
 *
 * Carries **no raw error and no stack trace**. `defects` and `blockers` are lists
 * rather than a first-failure, which is FR-019 and FR-025 respectively — an
 * operator fixing one defect per attempt is the failure mode both exist to stop.
 */
export interface LifecycleRefusal {
  readonly reason: LifecycleRefusalReason;
  readonly current: DefinitionRecord;
  readonly legalActions: readonly LifecycleAction[];
  /** Publish only. Every defect the candidate has (FR-019). */
  readonly defects?: readonly ValidationDefect[];
  /** Deactivate only. Every active referencing definition (FR-025). */
  readonly blockers?: readonly ReferenceBlocker[];
  /** Deactivate only. Never blocks (FR-025a, FR-061). */
  readonly advisories?: readonly LifecycleAdvisory[];
  /** `store-refused` only — the store's own closed reason, forwarded verbatim. */
  readonly storeReason?: string;
}

/** The legal actions from a state, so refusals answer "what now?" the same way everywhere. */
export function legalActionsFor(state: DefinitionState | null): readonly LifecycleAction[] {
  switch (state) {
    case 'draft':
      return ['save-draft', 'publish', 'restore', 'discard-draft'];
    case 'active':
      return ['save-draft', 'deactivate', 'restore'];
    case 'active-with-draft':
      return ['save-draft', 'publish', 'deactivate', 'restore', 'discard-draft'];
    default:
      // No entry: the only thing that can happen is a first draft.
      return ['save-draft'];
  }
}

// ---------------------------------------------------------------------------
// Operation requests (T498)
// ---------------------------------------------------------------------------

/** Common to every per-definition operation: which definition, and what the caller last saw. */
interface LifecycleRequestBase {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly expectedDraftVersion: ExpectedDraftVersion;
}

export interface SaveDraftRequest extends LifecycleRequestBase {
  /** Stored verbatim. Never validated and never normalised (099 FR-010, FR-011). */
  readonly body: unknown;
  readonly note?: string;
}

export type PublishRequest = LifecycleRequestBase;

export type DeactivateRequest = LifecycleRequestBase;

export interface RestoreRequest extends LifecycleRequestBase {
  readonly fromVersionId: CatalogVersionId;
}

export type DiscardDraftRequest = LifecycleRequestBase;

// ---------------------------------------------------------------------------
// Operation outcomes (T498)
// ---------------------------------------------------------------------------

/**
 * A version retention removed, with the definition it came from (FR-021).
 *
 * `kind` is part of the identity, not decoration: ids are unique only within a
 * kind, so an entry naming `ship-it` without one describes three possible
 * definitions. A package publish spans every kind, so its report is the one place
 * that cannot be re-derived from context.
 */
export interface PrunedVersions {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly versionIds: readonly CatalogVersionId[];
}

export type SaveDraftOutcome =
  | { readonly outcome: 'saved'; readonly draftVersionId: CatalogVersionId }
  /** The body hashes equal to the definition's **head** — no record written (FR-011a). */
  | { readonly outcome: 'unchanged'; readonly draftVersionId: CatalogVersionId }
  | { readonly outcome: 'refused'; readonly refusal: LifecycleRefusal }
  /** The record landed and the manifest write did not. Stays written (099 FR-029). */
  | { readonly outcome: 'partial'; readonly wrote: readonly CatalogVersionId[]; readonly errno: string };

export type PublishOutcome =
  | {
      readonly outcome: 'published';
      readonly activeVersionId: CatalogVersionId;
      readonly publishedAt: number;
      /** What retention removed, oldest first (FR-021). */
      readonly pruned: readonly CatalogVersionId[];
    }
  | { readonly outcome: 'refused'; readonly refusal: LifecycleRefusal };

export type DeactivateOutcome =
  /**
   * Always lands in `'draft'` (FR-024a).
   *
   * Narrower than `DefinitionState` on purpose: deactivation has exactly one
   * landing state, and a widened field would invite a caller to handle an arm this
   * operation cannot produce. It is also what makes FR-027 checkable — a definition
   * always left in Draft is always publishable again through the ordinary path.
   */
  | {
      readonly outcome: 'deactivated';
      readonly state: 'draft';
      readonly draftVersionId: CatalogVersionId;
      readonly advisories: readonly LifecycleAdvisory[];
    }
  | { readonly outcome: 'refused'; readonly refusal: LifecycleRefusal };

export type RestoreOutcome =
  | {
      readonly outcome: 'restored';
      readonly draftVersionId: CatalogVersionId;
      readonly fromVersionId: CatalogVersionId;
      /** The draft this restore replaced, if there was one (FR-029a). Its record is retained. */
      readonly replacedDraftVersionId: CatalogVersionId | null;
    }
  | { readonly outcome: 'refused'; readonly refusal: LifecycleRefusal }
  | { readonly outcome: 'partial'; readonly wrote: readonly CatalogVersionId[]; readonly errno: string };

export type DiscardDraftOutcome =
  /** `entryRemoved` is true when the definition had no active version (FR-034). */
  | { readonly outcome: 'discarded'; readonly entryRemoved: boolean }
  | { readonly outcome: 'refused'; readonly refusal: LifecycleRefusal };

// ---------------------------------------------------------------------------
// Package publish (T504)
// ---------------------------------------------------------------------------

/** One definition inside a layer of a package publish. */
export interface PackageDefinition {
  readonly id: string;
  readonly body: unknown;
}

/** One kind's contribution to a package. Written and then published in kind order (FR-035). */
export interface PackageLayer {
  readonly kind: CatalogKind;
  readonly definitions: readonly PackageDefinition[];
  /** The per-layer staleness gate, retained from feature 099 (FR-036). */
  readonly expectedRevision: string;
}

export interface PackagePublishRequest {
  /** Ordered Phases, Pipelines, Workflows. Order is the caller's to get right (FR-035). */
  readonly layers: readonly PackageLayer[];
}

/** One kind's definitions, as a package publish reports them. */
export interface PackagePublishedLayer {
  readonly kind: CatalogKind;
  readonly ids: readonly string[];
}

export type PackageRefusalReason =
  /** The document has defects. Nothing was written (FR-016, FR-019). */
  | 'validation-failed'
  /** A layer's `expectedRevision` no longer matches — that kind changed underneath. */
  | 'stale-layer'
  /** The store refused by name: no workspace, not writable, unreadable manifest. */
  | 'store-refused';

/**
 * Why a package publish wrote nothing.
 *
 * A shape of its own rather than a `LifecycleRefusal`, because a `LifecycleRefusal`
 * is built around one definition's `current` record and legal actions, and a package
 * has neither — a document of nine definitions has no single record to quote, and
 * naming an arbitrary one of them would be worse than naming none.
 */
export interface PackageRefusal {
  readonly reason: PackageRefusalReason;
  /** The layer that refused, or `null` where the refusal is about the whole document. */
  readonly kind: CatalogKind | null;
  /** Every defect in the whole document, never only the first (FR-019, SC-003). */
  readonly defects: readonly ValidationDefect[];
  /** The store's own word, where the store is what refused. */
  readonly storeReason?: string;
}

export type PackagePublishOutcome =
  | {
      readonly outcome: 'published';
      readonly published: readonly PackagePublishedLayer[];
      readonly pruned: readonly PrunedVersions[];
    }
  /**
   * A prefix landed and **stays written** (FR-037, FR-038).
   *
   * Both halves are reported because they are different situations for the operator:
   * `published` is what is now live and triggerable, `draftedOnly` is what was
   * written and is waiting. There is no compensating delete on any path — recovery
   * is a re-run of the same document, which plans the written rows as skips (FR-039).
   */
  | {
      readonly outcome: 'partial';
      readonly published: readonly PackagePublishedLayer[];
      readonly draftedOnly: readonly CatalogKind[];
      readonly failedKind: CatalogKind;
      /** The store's cause: an errno where a write failed, a refusal name otherwise. */
      readonly cause: string;
      /**
       * What retention removed before the failure, from the writes that did land.
       *
       * Reported on this arm for the same reason as on the one above, and more
       * urgently: recovery is a re-run of the document, which plans the written rows
       * as skips (FR-039) and prunes nothing, so this is the only report of those
       * removals there will ever be.
       */
      readonly pruned: readonly PrunedVersions[];
    }
  | { readonly outcome: 'refused'; readonly refusal: PackageRefusal };
