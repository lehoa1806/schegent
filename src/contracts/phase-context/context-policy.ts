/**
 * FR-R6-F15 (F15-A; FR-001, FR-002, FR-004, FR-008, FR-021, NFR-001 to NFR-008) — the limits,
 * the closed failure list and the input shapes of a phase-to-phase context handoff: the opt-in
 * policy, what one finished attempt contributes, and the identity of one handoff.
 *
 * Pure types and frozen constants. Nothing in the shipped extension constructs a handoff yet:
 * the durable record, the pins and the wiring into workflow execution are F15-B.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const PHASE_CONTEXT_POLICY_VERSION = 1;
export const PHASE_CONTEXT_CONTRIBUTION_VERSION = 1;

const KIB = 1024;
const MIB = 1024 * KIB;

/** Every bound of the handoff. Sizes are UTF-8 bytes; none is a token count (FR-018). */
export const PHASE_CONTEXT_LIMITS = Object.freeze({
  manifestBytesMax: 64 * KIB,
  artifactReferencesMax: 64,
  sourceContributionsMax: 32,
  /** Entries in one collection, in one contribution and across a manifest. */
  collectionEntriesMax: 32,
  textEntryBytesMax: 2 * KIB,
  summaryBytesMax: 8 * KIB,
  explanationBytesMax: 64 * KIB,
  renderedContextBytesMax: 32 * KIB,
  selectorsMax: 32,
  boundInputsMax: 32,
  candidatesMax: 256,
  priorityMax: 99,
  /** Revisions one handoff may hold. */
  revisionsMax: 16,
  /** Dispatch records one handoff may hold. */
  dispatchesMax: 64,
  activePreparationsMax: 2,
  queuedPreparationsMax: 8,
  workingSetBytesMax: 8 * MIB,
  preparationDeadlineMs: 2_000,
  /** Largest text artifact that may be embedded in the prompt. */
  embedBytesMax: 8 * KIB,
  /** NFR-007: declared for F15-B, which copies files; nothing in this delivery reads them. */
  materializedFilesMax: 64,
  materializedFileBytesMax: 16 * MIB,
  materializedTotalBytesMax: 64 * MIB,
  materializationStreamBytesMax: MIB,
  materializationDeadlineMs: 30_000,
  reviewArtifactBytesMax: 256 * KIB,
  reviewRecordsMax: 200,
  reviewRecordBytesMax: 2 * KIB,
  findingTitleBytesMax: 512,
  findingExplanationBytesMax: KIB,
  evidenceReferencesMax: 8,
  evidenceReferenceBytesMax: 256,
  jsonDepthMax: 16,
  jsonValuesMax: 8_192,
  loopFindingsMax: 1_024,
  loopPassesMax: 32,
  historyPassesMax: 5,
  historyPassBytesMax: KIB,
  historyTotalBytesMax: 8 * KIB
});

/** FR-021: every refusal is one of these. */
export const PHASE_CONTEXT_FAILURES = Object.freeze([
  'invalid-policy',
  'invalid-source',
  'stale-revision',
  'required-context-unavailable',
  'capacity-exceeded',
  'storage-unavailable',
  'unsupported-version',
  'uncertain-delivery'
] as const);
export type PhaseContextFailure = (typeof PHASE_CONTEXT_FAILURES)[number];

/** `detail` is a fixed code. It never holds content, a path or an error message (FR-017). */
export interface Refusal {
  readonly ok: false;
  readonly failure: PhaseContextFailure;
  readonly detail: string;
}

export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const NODE_PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]{0,255}$/;
export const FINDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const APPROVAL_MODES = Object.freeze(['automatic', 'manual'] as const);
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const SESSION_POLICIES = Object.freeze(['fresh', 'reuse-when-qualified'] as const);
export type SessionPolicy = (typeof SESSION_POLICIES)[number];

/** One source the policy asks for. A lower priority is taken first. */
export interface ContextSelector {
  readonly selectorId: string;
  readonly sourceNodePath: string;
  readonly required: boolean;
  readonly priority: number;
}

/** The opt-in configuration of one transition. No policy means no handoff (FR-001). */
export interface HandoffPolicy {
  readonly version: typeof PHASE_CONTEXT_POLICY_VERSION;
  readonly approval: ApprovalMode;
  readonly session: SessionPolicy;
  readonly selectors: readonly ContextSelector[];
}

/** An input the workflow bound. Always required, and taken before any selector (FR-006). */
export interface BoundInput {
  readonly bindingId: string;
  readonly sourceNodePath: string;
}

/** One exact producer attempt (FR-014). */
export interface ProducerRef {
  readonly nodePath: string;
  readonly occurrenceId: string;
  readonly attemptId: string;
}

export const ARTIFACT_KINDS = Object.freeze(['text', 'binary'] as const);
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** FR-008: a reference names an immutable version and its digest. */
export interface ArtifactRef {
  readonly artifactId: string;
  readonly immutableVersion: string;
  readonly digestHex: string;
  readonly byteSize: number;
  readonly kind: ArtifactKind;
}

export const COVERAGES = Object.freeze(['complete', 'partial', 'unavailable'] as const);
export type Coverage = (typeof COVERAGES)[number];

/** What one accepted attempt offers the next phase (FR-004). */
export interface SourceContribution {
  readonly schemaVersion: typeof PHASE_CONTEXT_CONTRIBUTION_VERSION;
  readonly producer: ProducerRef;
  readonly coverage: Coverage;
  readonly outcomes: readonly string[];
  readonly decisions: readonly string[];
  readonly constraints: readonly string[];
  readonly unresolvedIssues: readonly string[];
  readonly summary: string | null;
  readonly artifacts: readonly ArtifactRef[];
}

/** A contribution as the host holds it before validation. */
export interface ContributionCandidate {
  readonly acceptedFrom: ProducerRef;
  /** The commit sequence at which the host accepted it. */
  readonly acceptedSequence: number;
  readonly contribution: unknown;
}

/** FR-002: the lineage values that make one handoff distinct. */
export interface HandoffIdentity {
  readonly workspaceId: string;
  readonly rootExecutionId: string;
  readonly sourceInvocationId: string;
  readonly targetNodePath: string;
  readonly targetOccurrenceId: string;
  readonly inputEnvelopeRevision: number;
  readonly sourceAttempts: readonly ProducerRef[];
}
