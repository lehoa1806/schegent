/**
 * FR-R6-F05 US3 (FR-013..FR-015) — the public shapes of legacy catalog
 * preservation: the read-only classification the F04 migration preview takes
 * in, the quarantine and purge requests, and the re-import preview.
 *
 * No shape here carries a host path. Residue is named by an opaque
 * `residueId`; the workspace-relative keys the service persists stay inside it.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type { CatalogKind } from '../catalog-store';
import type {
  LifecycleResult,
  MutationRequestBase,
  PreservationOperationState
} from './lifecycle-types';

/** One catalog version identity: `<kind>/<id>/<versionId>`. */
export interface LegacyCatalogVersionRef {
  readonly kind: CatalogKind;
  readonly id: string;
  readonly versionId: string;
}

/** Who still reads a version: a live run, or a frozen record (handoff, history, report). */
export interface LegacyCatalogConsumer {
  readonly kind: 'live' | 'frozen';
}

/** The host's answer to "who reads this version?"; the service never infers it. */
export interface LegacyCatalogConsumerPort {
  consumersOf(ref: LegacyCatalogVersionRef): readonly LegacyCatalogConsumer[];
}

export type LegacyCatalogPointer = 'active' | 'draft';

/** A version the manifest names. Always `published`; never debris (FR-013). */
export interface LegacyCatalogVersionClassification extends LegacyCatalogVersionRef {
  readonly contentHash: string;
  readonly pointers: readonly LegacyCatalogPointer[];
  readonly consumers: readonly LegacyCatalogConsumer[];
  readonly disposition: 'published';
}

/**
 * Why a residue record stays: `protected` when a pointer or a consumer still
 * references it, `unresolved` otherwise. There is deliberately no `disposable`:
 * nothing the classifier sees is debris (FR-013).
 */
export type LegacyResidueDisposition = 'protected' | 'unresolved';

/** A version record on disk that the manifest does not name (version-before-manifest residue). */
export interface LegacyCatalogResidue extends LegacyCatalogVersionRef {
  readonly residueId: string;
  /** `sha256:<hex>` over the record's bytes; null when they could not be read. */
  readonly digest: string | null;
  readonly sizeBytes: number | null;
  readonly pointers: readonly LegacyCatalogPointer[];
  readonly consumers: readonly LegacyCatalogConsumer[];
  readonly disposition: LegacyResidueDisposition;
  /** The default outcome: bytes stay where they are until an explicit quarantine (FR-014). */
  readonly outcome: 'preserved-in-place';
}

/** The read-only classification of `.schegent/catalog/` (FR-013). */
export interface LegacyCatalogClassification {
  readonly manifestState: 'read' | 'absent' | 'faulted';
  /** `sha256:<hex>` over the raw manifest bytes; null when there is no readable manifest. */
  readonly manifestGeneration: string | null;
  readonly versions: readonly LegacyCatalogVersionClassification[];
  readonly residue: readonly LegacyCatalogResidue[];
  /** Integrity faults the catalog scan reported: dangling or mismatched records the manifest names. */
  readonly unresolvedReferenceCount: number;
  /** The staleness input every preview of this classification is bound to. */
  readonly basisRevision: string;
}

/** The legacy-catalog section of the F04 migration preview (FR-013). Writes nothing. */
export interface LegacyCatalogMigrationSection {
  readonly section: 'legacy-catalog';
  /** Derived from the basis: the same classification always yields the same id. */
  readonly previewId: string;
  readonly staleness: {
    readonly manifestGeneration: string | null;
    readonly basisRevision: string;
  };
  readonly classification: LegacyCatalogClassification;
}

/** Quarantine the named residue, or every `unresolved` residue when none is named. */
export interface LegacyQuarantineRequest extends MutationRequestBase {
  readonly residueIds?: readonly string[] | undefined;
}

/** Purge the named quarantined copies, or every eligible one when none is named. */
export interface LegacyPurgeRequest extends MutationRequestBase {
  readonly residueIds?: readonly string[] | undefined;
}

export interface LegacyPurgeResult {
  readonly operationId: string;
  readonly state: PreservationOperationState;
  readonly purged: number;
  readonly refused: number;
  readonly ambiguous: number;
}

/** What a re-import would hand the catalog's own admission gates. */
export interface LegacyReimportCandidate extends LegacyCatalogVersionRef {
  readonly contentHash: string;
  readonly body: unknown;
}

/**
 * The current catalog admission gates, injected. The preview asks; it never
 * writes the catalog (FR-015, no temporary file-catalog writer).
 */
export interface LegacyCatalogAdmissionPort {
  admits(candidate: LegacyReimportCandidate): LifecycleResult<true>;
}

export interface LegacyReimportPreview extends LegacyCatalogVersionRef {
  readonly residueId: string;
  readonly contentHash: string;
  /** Where the preserved bytes sit now. */
  readonly source: 'in-place' | 'quarantine';
  readonly basisRevision: string;
}
