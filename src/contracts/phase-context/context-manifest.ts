/**
 * FR-R6-F15 (F15-A; FR-005, FR-007, FR-010, FR-011, FR-012, FR-015) — the accepted manifest of
 * a handoff, what was left out of it, the rendered context, and the record a store keeps.
 *
 * The only store in this delivery is in memory; the SQLite record is F15-B.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { ApprovalMode, ArtifactRef, HandoffIdentity, ProducerRef, SessionPolicy } from './context-policy';

export const PHASE_CONTEXT_MANIFEST_VERSION = 1;
export const PHASE_CONTEXT_RENDERER_VERSION = 1;

export const REQUEST_KINDS = Object.freeze(['binding', 'selector'] as const);
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** The bound input or policy selector that asked for a source. */
export interface RequestRef {
  readonly kind: RequestKind;
  readonly id: string;
}

export const MANIFEST_COVERAGES = Object.freeze(['complete', 'partial'] as const);
export type ManifestCoverage = (typeof MANIFEST_COVERAGES)[number];

/** One selected source, attributed to its producer attempt (FR-006). */
export interface ManifestSource {
  readonly producer: ProducerRef;
  readonly acceptedSequence: number;
  readonly coverage: ManifestCoverage;
  readonly required: boolean;
  /** The first request that selected it. */
  readonly selectedBy: RequestRef;
  readonly outcomes: readonly string[];
  readonly decisions: readonly string[];
  readonly constraints: readonly string[];
  readonly unresolvedIssues: readonly string[];
  readonly summary: string | null;
  readonly artifacts: readonly ArtifactRef[];
}

export const OMISSION_REASONS = Object.freeze([
  'after-cutoff',
  'not-selected-by-policy',
  'coverage-unavailable',
  'optional-capacity'
] as const);
export type OmissionReason = (typeof OMISSION_REASONS)[number];

/** A source that was left out, with the reason (FR-005). */
export interface Omission {
  readonly producer: ProducerRef;
  readonly request: RequestRef | null;
  readonly reason: OmissionReason;
}

export const MANIFEST_ORIGINS = Object.freeze(['selected', 'edited'] as const);
export type ManifestOrigin = (typeof MANIFEST_ORIGINS)[number];

/** One revision of what the target receives (FR-007). */
export interface HandoffManifest {
  readonly manifestVersion: typeof PHASE_CONTEXT_MANIFEST_VERSION;
  readonly handoffId: string;
  readonly revision: number;
  readonly previousRevision: number | null;
  readonly origin: ManifestOrigin;
  readonly identity: HandoffIdentity;
  readonly policyDigest: string;
  readonly approval: ApprovalMode;
  readonly session: SessionPolicy;
  readonly cutoffSequence: number;
  readonly targetInstructionsDigest: string;
  /** The rendered bound in force when the revision was made. */
  readonly renderedBytesMax: number;
  readonly sources: readonly ManifestSource[];
  readonly omissions: readonly Omission[];
  /** Omissions past the 32 that are listed. */
  readonly omissionsUnlisted: number;
}

/** The bytes one renderer version makes from one manifest (FR-010). */
export interface RenderedContext {
  readonly rendererVersion: typeof PHASE_CONTEXT_RENDERER_VERSION;
  readonly text: string;
  readonly bytes: number;
  readonly digestHex: string;
}

/** A manifest with its serialized text, digest and rendered context, ready to accept. */
export interface PreparedHandoff {
  readonly manifest: HandoffManifest;
  readonly serialized: string;
  readonly manifestDigest: string;
  readonly rendered: RenderedContext;
}

export const REVISION_STATES = Object.freeze(['waiting-approval', 'ready', 'superseded'] as const);
export type RevisionState = (typeof REVISION_STATES)[number];

export interface AcceptedRevision {
  readonly revision: number;
  readonly manifestDigest: string;
  readonly serializedManifest: string;
  readonly rendererVersion: number;
  readonly renderedDigest: string;
  readonly renderedBytes: number;
  readonly state: RevisionState;
}

/** FR-012: a decision bound to one revision. */
export interface ApprovalRecord {
  readonly revision: number;
  readonly decisionId: string;
}

export const DISPATCH_STATES = Object.freeze(['intent', 'delivered', 'uncertain'] as const);
export type DispatchState = (typeof DISPATCH_STATES)[number];

/** An intent says a send may have happened; it is not a delivery receipt (FR-011). */
export interface DispatchRecord {
  readonly revision: number;
  readonly targetAttemptId: string;
  readonly representationDigest: string;
  readonly state: DispatchState;
}

export interface HandoffRecord {
  readonly handoffId: string;
  /** Incremented by the store on every save. */
  readonly version: number;
  readonly revisions: readonly AcceptedRevision[];
  readonly approvals: readonly ApprovalRecord[];
  readonly dispatches: readonly DispatchRecord[];
}

export const HANDOFF_EVENTS = Object.freeze([
  'prepared',
  'accepted',
  'approved',
  'superseded',
  'dispatch-intent',
  'delivered',
  'uncertain'
] as const);
export type HandoffEvent = (typeof HANDOFF_EVENTS)[number];

/**
 * FR-022: the metadata of one lifecycle event. Two observations of one transfer carry the same
 * `key`, so a sink counts them once. No field holds context text.
 */
export interface HandoffObservation {
  readonly key: string;
  readonly event: HandoffEvent;
  readonly handoffId: string;
  readonly revision: number;
  readonly sourceCount: number;
  /** Listed and unlisted omissions together. */
  readonly omissionCount: number;
  readonly renderedBytes: number;
}

/** A selected source as an explanation shows it: who made it, why it was taken, and counts. */
export interface ExplainedSource {
  readonly producer: ProducerRef;
  readonly coverage: ManifestCoverage;
  readonly required: boolean;
  readonly selectedBy: RequestRef;
  readonly outcomes: number;
  readonly decisions: number;
  readonly constraints: number;
  readonly unresolvedIssues: number;
  readonly hasSummary: boolean;
  readonly artifacts: number;
}

/** A stored revision without its manifest text. */
export type ExplainedRevision = Omit<AcceptedRevision, 'serializedManifest'>;

/** FR-019: a handoff explained from metadata alone, at most 64 KiB serialized. */
export interface HandoffExplanation {
  readonly handoffId: string;
  readonly recordVersion: number;
  readonly identity: HandoffIdentity;
  readonly revisions: readonly ExplainedRevision[];
  /** The revision whose sources and omissions follow. */
  readonly revision: number;
  readonly origin: ManifestOrigin;
  readonly approval: ApprovalMode;
  readonly session: SessionPolicy;
  readonly policyDigest: string;
  readonly cutoffSequence: number;
  readonly renderedBytesMax: number;
  readonly sources: readonly ExplainedSource[];
  readonly omissions: readonly Omission[];
  readonly omissionsUnlisted: number;
  readonly approvals: readonly ApprovalRecord[];
  readonly dispatches: readonly DispatchRecord[];
}

/** The store behind acceptance. `save` stores only when the stored version is the expected one. */
export interface HandoffStorePort {
  load(handoffId: string): HandoffRecord | null;
  /** `expectedVersion` is 0 for a new record. The stored record has `expectedVersion + 1`. */
  save(record: HandoffRecord, expectedVersion: number): boolean;
}
