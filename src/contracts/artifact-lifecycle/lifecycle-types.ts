/**
 * FR-R6-F05 — Artifact lifecycle and storage recovery: pure contract types.
 *
 * Availability, retention class and pin purpose are the F02 shared vocabulary,
 * imported as types; this module defines no second copy. Every result an F05
 * surface returns is a `LifecycleResult<T>`, so the headless API and the
 * read-only webview query can return it unchanged (FR-021).
 *
 * Zero `vscode` imports and no runtime import from an acting layer
 * (docs/hard-rules.md rule 13).
 */

import type {
  ArtifactAvailabilityState
} from '../shared-memory-storage/identity-and-observations';
import type { RetentionClassId } from '../shared-memory-storage/consumer-and-retention-inventories';
import type { ArtifactPinPurpose } from '../shared-memory-storage/artifacts-streams-and-acp';

export type { ArtifactAvailabilityState, RetentionClassId, ArtifactPinPurpose };

export const ARTIFACT_LIFECYCLE_CONTRACT_VERSION = 1 as const;

/** Store kinds refine a retention class for sweep eligibility (data-model.md). */
export const ARTIFACT_STORE_KINDS = [
  'transcript',
  'diagnostic',
  'checkpoint',
  'audit',
  'catalog',
  'report',
  'handoff-context',
  'review-report',
  'live-log-segment',
  'export-copy',
  'quarantine',
  'provider-session',
  'unclassified'
] as const;
export type ArtifactStoreKind = (typeof ARTIFACT_STORE_KINDS)[number];

/** Never eligible for any F05 sweep (FR-008, rule 9). */
export const NEVER_ELIGIBLE_STORE_KINDS: readonly ArtifactStoreKind[] = ['audit', 'provider-session'];

export const ARTIFACT_SENSITIVITIES = ['metadata', 'content', 'secret-adjacent'] as const;
export type ArtifactSensitivity = (typeof ARTIFACT_SENSITIVITIES)[number];

export const ARTIFACT_IMMUTABILITIES = ['immutable', 'growing'] as const;
export type ArtifactImmutability = (typeof ARTIFACT_IMMUTABILITIES)[number];

export const REFERENCE_OWNER_TYPES = ['run', 'attempt', 'handoff', 'export', 'phase-context', 'operator'] as const;
export type ReferenceOwnerType = (typeof REFERENCE_OWNER_TYPES)[number];

export const F05_REFERENCE_PURPOSES = [
  'active-recovery',
  'paused-recovery',
  'uncertain-recovery',
  'pending-handoff',
  'report-lease',
  'export-operation',
  'phase-context',
  'operator-hold'
] as const satisfies readonly (ArtifactPinPurpose | 'phase-context' | 'operator-hold')[];
export type ReferencePurpose = (typeof F05_REFERENCE_PURPOSES)[number];

export const REFERENCE_RELEASE_REASONS = ['owner-durable', 'operator-early-release', 'expired'] as const;
export type ReferenceReleaseReason = (typeof REFERENCE_RELEASE_REASONS)[number];

export const PREVIEW_KINDS = ['policy-adoption', 'deletion', 'early-release', 'archival', 'legacy-quarantine'] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

export const DELETION_OPERATION_STATES = ['planned', 'executing', 'completed', 'partial', 'refused', 'cancelled'] as const;
export type DeletionOperationState = (typeof DELETION_OPERATION_STATES)[number];

export const DELETION_TARGET_OUTCOMES = ['planned', 'executing', 'deleted', 'already-absent', 'retained', 'unknown', 'refused'] as const;
export type DeletionTargetOutcomeKind = (typeof DELETION_TARGET_OUTCOMES)[number];

export const PRESERVATION_OPERATION_STATES = ['planned', 'copying', 'verifying', 'completed', 'ambiguous', 'refused'] as const;
export type PreservationOperationState = (typeof PRESERVATION_OPERATION_STATES)[number];

export const PRESERVATION_TARGET_OUTCOMES = ['preserved-in-place', 'quarantined', 'ambiguous', 'refused'] as const;
export type PreservationTargetOutcome = (typeof PRESERVATION_TARGET_OUTCOMES)[number];

export const SCAN_COVERAGES = ['complete', 'partial'] as const;
export type ScanCoverage = (typeof SCAN_COVERAGES)[number];

/** NFR-001: one inventory page holds at most 200 entries and 1 MiB serialized. */
export const INVENTORY_PAGE_MAX_ENTRIES = 200;
export const INVENTORY_PAGE_MAX_BYTES = 1_048_576;
/** An inventory cursor is an opaque base64url token of at most 512 characters. */
export const INVENTORY_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
/** Opaque ids (artifact, preview, operation, reference): a bounded token with no path separator. */
export const LIFECYCLE_OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
/** The most artifact ids one explicit deletion selection may name. */
export const DELETION_SELECTION_MAX_IDS = 1_000;
/** NFR-002: at most 200 removals per sweep pass. */
export const SWEEP_MAX_REMOVALS_PER_PASS = 200;
/** A preview stays live for 10 minutes. */
export const PREVIEW_LIFETIME_MS = 600_000;
/** R5: bounded scan of declared roots. */
export const SCAN_MAX_DEPTH = 8;
export const SCAN_MAX_ENTRIES_PER_PASS = 2_000;
/** Clarification 4: archival leaves the newest 100 or drops after 30 days, whichever first. */
export const ARCHIVAL_DEFAULT_HOT_LIST_BOUND = 100;
export const ARCHIVAL_DEFAULT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** F02 F05 consumer limits (consumer-and-retention-inventories.ts). */
export const ARTIFACT_DISPLAY_NAME_MAX_BYTES = 256;
export const ARTIFACT_PINS_PER_OWNER_MAX = 64;
/** A bounded diagnostic never carries more than this many characters of detail (FR-006). */
export const LIFECYCLE_DIAGNOSTIC_DETAIL_MAX_CHARS = 256;

export const LIFECYCLE_REFUSAL_CODES = [
  'untrusted-workspace',
  'not-primary-window',
  'preview-required',
  'preview-stale',
  'preview-expired',
  'confirmation-required',
  'protected-reference',
  'ownership-unresolved',
  'live-writer',
  'containment-violation',
  'sweep-in-progress',
  'audit-unhealthy',
  'unknown-version',
  'identity-conflict',
  'content-conflict',
  'not-found',
  'unavailable',
  'access-denied',
  'pin-quota-reached',
  'invalid-input'
] as const;
export type LifecycleRefusalCode = (typeof LIFECYCLE_REFUSAL_CODES)[number];

export interface LifecycleRefusal {
  readonly code: LifecycleRefusalCode;
  /** Sanitized: no host path, no secret. */
  readonly message: string;
  /** Opaque id only. */
  readonly artifactId?: string;
}

export type LifecycleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: LifecycleRefusal };

export interface ArtifactDigest {
  readonly algorithm: 'sha256';
  /** 64 lowercase hex characters. */
  readonly value: string;
}

/** One Schegent-owned artifact; host locators never appear here (FR-001). */
export interface ArtifactRecord {
  readonly artifactId: string;
  /** False when no `artifact_lifecycle` row exists and availability came from the F04 mapping. */
  readonly managed: boolean;
  readonly lifecycleRevision: number;
  readonly ownerRunId: string | null;
  readonly ownerAttemptId: string | null;
  readonly sensitivity: ArtifactSensitivity;
  readonly retentionClass: RetentionClassId;
  readonly storeKind: ArtifactStoreKind;
  readonly immutability: ArtifactImmutability;
  readonly digest: ArtifactDigest | null;
  readonly generation: number | null;
  readonly extentBytes: number | null;
  readonly byteSize: number;
  readonly availability: ArtifactAvailabilityState;
  readonly mediaType: string;
  readonly displayName: string;
  readonly createdAtMs: number;
  readonly terminalSettledAtMs: number | null;
  readonly expiresAtMs: number | null;
  readonly updatedAtMs: number;
}

export interface ArtifactReference {
  readonly referenceId: string;
  readonly artifactId: string;
  readonly ownerType: ReferenceOwnerType;
  readonly ownerId: string;
  readonly purpose: ReferencePurpose;
  readonly protective: boolean;
  readonly active: boolean;
  readonly createdRevision: number;
  readonly releasedRevision: number | null;
  readonly releaseReason: ReferenceReleaseReason | null;
  readonly createdAtMs: number;
  readonly releasedAtMs: number | null;
}

/** The new terminal-execution metadata policy; nothing changes until adoption (FR-018). */
export interface RetentionPolicy {
  readonly schemaVersion: 1;
  /** Age, from terminal settlement, after which new-metadata detail is eligible. */
  readonly terminalDetailMaxAgeMs: number;
  readonly archivalHotListBound: number;
  readonly archivalMaxAgeMs: number;
}

export type RetentionDecisionAction =
  | 'collect'
  | 'preserve-protected'
  | 'preserve-ineligible'
  | 'preserve-never-eligible'
  | 'preserve-unclassified'
  | 'preserve-ownership-unresolved';

export interface RetentionDecision {
  readonly artifactId: string;
  readonly action: RetentionDecisionAction;
  readonly retentionClass: RetentionClassId;
  readonly byteSize: number;
}

export interface RetentionPreviewClassLine {
  readonly retentionClass: RetentionClassId;
  readonly affectedCount: number;
  readonly affectedBytes: number;
  readonly protectedCount: number;
  readonly protectedBytes: number;
}

export interface RetentionPreviewSummary {
  readonly affectedCount: number;
  readonly affectedBytes: number;
  readonly protectedCount: number;
  readonly protectedBytes: number;
  readonly unclassifiedCount: number;
  readonly unclassifiedBytes: number;
  readonly perClass: readonly RetentionPreviewClassLine[];
  /** Opaque artifact ids kept for a protective reason, bounded. */
  readonly protectedExceptions: readonly { readonly artifactId: string; readonly reason: RetentionDecisionAction }[];
  readonly coverage: ScanCoverage;
  /** Sanitized notes, e.g. the recovery capability an early release surrenders (FR-007). */
  readonly notes: readonly string[];
}

export interface RetentionPreview {
  readonly previewId: string;
  readonly kind: PreviewKind;
  readonly basisRevision: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly summary: RetentionPreviewSummary;
}

export interface DeletionTargetOutcome {
  readonly ordinal: number;
  /** Null for unclassified residue; the host-private target key is never returned. */
  readonly artifactId: string | null;
  readonly outcome: DeletionTargetOutcomeKind;
  readonly reasonCode: string | null;
}

export interface DeletionOperation {
  readonly operationId: string;
  readonly state: DeletionOperationState;
  readonly plannedCount: number;
  readonly targets: readonly DeletionTargetOutcome[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly finishedAtMs: number | null;
}

export interface SourcePreservationTarget {
  readonly ordinal: number;
  readonly sourceDigest: string | null;
  readonly destinationDigest: string | null;
  readonly outcome: PreservationTargetOutcome;
}

export interface SourcePreservationOperation {
  readonly operationId: string;
  readonly state: PreservationOperationState;
  readonly targets: readonly SourcePreservationTarget[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface ArchivedTaskSummary {
  readonly queueId: string;
  readonly taskId: string;
  /** Copied verbatim from the Task; never recomputed (FR-016). */
  readonly outcome: string;
  readonly terminalResolvedAtMs: number;
  readonly archivedAtMs: number;
  readonly summary: Readonly<Record<string, string | number | boolean | null>>;
  readonly retainedReferenceIds: readonly string[];
  readonly detailExpiresAtMs: number;
  /** `expired` is labelled; it never implies the detail is recoverable (FR-019). */
  readonly detailState: 'retained' | 'expired';
}

export interface StorageInventoryEntry {
  /** Null for an unclassified scan entry; host paths never appear. */
  readonly artifactId: string | null;
  readonly source: 'registered' | 'scan';
  readonly rootId: string | null;
  readonly retentionClass: RetentionClassId | null;
  readonly storeKind: ArtifactStoreKind;
  readonly byteSize: number;
  readonly availability: ArtifactAvailabilityState;
  readonly protected: boolean;
  readonly eligible: boolean;
}

export interface StorageInventoryPage {
  readonly entries: readonly StorageInventoryEntry[];
  readonly nextCursor: string | null;
  readonly coverage: ScanCoverage;
}

export interface StoragePressureClassLine {
  readonly retentionClass: RetentionClassId;
  readonly totalBytes: number;
  readonly reclaimableBytes: number;
  readonly protectedBytes: number;
}

export interface StoragePressureReport {
  readonly perClass: readonly StoragePressureClassLine[];
  readonly totalBytes: number;
  readonly unclassifiedBytes: number;
  readonly policyRevision: number;
  readonly lastCompleteScanAtMs: number | null;
  /** A newer partial scan is reported separately, never merged into the complete totals (FR-009). */
  readonly latestPartialScanAtMs: number | null;
  readonly coverage: ScanCoverage;
  /** The configured storage target; null when none is set. */
  readonly targetBytes: number | null;
  readonly overTarget: boolean;
  /** What happens to new writes under pressure (FR-020); recovery dependencies are never evicted. */
  readonly admission: StorageAdmission;
  /** Counters of the latest declared-root scan; null before the first scan. */
  readonly scanFigures: StorageScanFigures | null;
}

export const STORAGE_ADMISSION_BEHAVIORS = ['admit', 'reclaim-eligible-only', 'shared-admission'] as const;
export type StorageAdmissionBehavior = (typeof STORAGE_ADMISSION_BEHAVIORS)[number];

export interface StorageAdmission {
  readonly behavior: StorageAdmissionBehavior;
  readonly evictsRecoveryDependencies: false;
  readonly settlementReservePreserved: true;
  /** Names the shared admission seams new writes fall to (F02 pin quota, F03 backpressure). */
  readonly sharedAdmission: string;
}

export interface StorageScanFigures {
  readonly entriesVisited: number;
  readonly rootsCompleted: number;
  readonly rootsDeclared: number;
}

/** Result of one bounded `lstat`-only walk of the declared roots (FR-012, R5). */
export interface StorageScanResult extends StorageScanFigures {
  readonly scanId: string;
  readonly coverage: ScanCoverage;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
}

export interface ArtifactAccessHandle {
  readonly handleId: string;
  readonly artifactId: string;
  readonly digest: ArtifactDigest;
  readonly sessionScope: { readonly attemptId: string; readonly sessionId: string };
  readonly mode: 'embed' | 'read';
  readonly pinReferenceId: string;
}

/** Supplied by the host caller; the service never infers it. */
export interface MutationAuthority {
  readonly trusted: boolean;
  readonly primary: boolean;
  readonly auditHealthy: boolean;
}

export interface MutationRequestBase {
  readonly previewId: string;
  readonly confirmation: 'confirmed' | undefined;
  readonly authority: MutationAuthority;
}

/** One inventory page request; `pageSize` defaults to `INVENTORY_PAGE_MAX_ENTRIES`. */
export interface StorageInventoryRequest {
  readonly cursor?: string | undefined;
  readonly pageSize?: number | undefined;
  readonly retentionClass?: RetentionClassId | undefined;
}

/** What a deletion covers: explicit managed artifacts, a retention class, or both; neither means all. */
export interface DeletionSelection {
  readonly artifactIds?: readonly string[] | undefined;
  readonly retentionClass?: RetentionClassId | undefined;
}

export interface DeletionExecuteRequest extends DeletionSelection, MutationRequestBase {}

/** Bounded diagnostic for unknown or ambiguous state (FR-006). */
export interface LifecycleDiagnostic {
  readonly code: 'ownership-unresolved' | 'unknown-version' | 'ambiguous-preservation' | 'reconciled-operation';
  readonly artifactId: string | null;
  /** Sanitized, at most LIFECYCLE_DIAGNOSTIC_DETAIL_MAX_CHARS characters. */
  readonly detail: string;
}
