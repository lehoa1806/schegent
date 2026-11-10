/**
 * FR-R6-F10 (specs/309-isolated-workspace-lanes/contracts/execution-lanes.md) — the vocabulary,
 * bounds, disclosure and record views of execution lanes and reviewed integration.
 *
 * A lane is a host-provisioned Git working tree under the host storage directory. It is a
 * working-tree boundary, not a permission boundary (`LANE_DISCLOSURE`). Nothing dispatches a Run
 * into a lane yet: this module only describes the engine's records and results.
 *
 * Field rules quoted from data-model.md "Shared column rules":
 * - random identifiers (`laneId`, `requestId`, ...): 32 lowercase hex;
 * - caller identifiers (`workspaceId`, `rootExecutionId`, `profileId`): `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`;
 * - commit and tree names: 40 or 64 lowercase hex;
 * - timestamps: `Date.prototype.toISOString()`.
 *
 * No value described here holds an absolute path, Git stderr, a check's output or an
 * environment value (SC-006).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const LANE_STATES = Object.freeze([
  'preparing',
  'active',
  'paused',
  'completed',
  'retained',
  'cleanup-eligible',
  'removed',
  'preparation-failed'
] as const);
export type LaneState = (typeof LANE_STATES)[number];

/** States that count against the live-lane cap (NFR-001). */
export const LIVE_LANE_STATES = Object.freeze(['preparing', 'active', 'paused'] as const);

export const INTEGRATION_STATES = Object.freeze([
  'queued',
  'verifying',
  'awaiting-review',
  'landing',
  'landed',
  'blocked',
  'canceled',
  'uncertain'
] as const);
export type IntegrationState = (typeof INTEGRATION_STATES)[number];

/** The eight provisioning refusals, in the probe's check order where the probe makes them. */
export const PROVISIONING_REFUSAL_REASONS = Object.freeze([
  'git-version-unsupported',
  'nested-repository-unsupported',
  'lane-root-inside-workspace',
  'dependency-recipe-unsupported',
  'source-revision-unresolved',
  'submodules-unsupported',
  'lfs-unsupported',
  'lane-bound-reached'
] as const);
export type ProvisioningRefusalReason = (typeof PROVISIONING_REFUSAL_REASONS)[number];

export const LANE_REFUSAL_REASONS = Object.freeze([
  ...PROVISIONING_REFUSAL_REASONS,
  'candidate-empty',
  'git-identity-missing',
  'review-stale',
  'target-advanced',
  'target-diverged',
  'target-worktree-dirty',
  'target-is-lane',
  'verification-failed',
  'verification-workspace-changed',
  'landing-not-applied',
  'invalid-input',
  'ownership-superseded',
  'lane-not-found',
  'request-not-found',
  'lane-state-invalid',
  'request-state-invalid',
  'integration-busy',
  'lane-busy',
  'lane-pinned',
  'provisioning-deadline-exceeded',
  'provisioning-git-failed'
] as const);
export type LaneRefusalReason = (typeof LANE_REFUSAL_REASONS)[number];

export const LANE_OBSERVATIONS = Object.freeze([
  'target-advanced-beyond',
  'root-missing',
  'acknowledged-uncertain',
  'unknown-worktree',
  'lane-dirty',
  'lane-live',
  'request-open',
  'not-contained',
  'registry-mismatch'
] as const);
export type LaneObservation = (typeof LANE_OBSERVATIONS)[number];

export const DEPENDENCY_RECIPES = Object.freeze(['none'] as const);
export type DependencyRecipe = (typeof DEPENDENCY_RECIPES)[number];

export const LANE_OPERATION_KINDS = Object.freeze(['provision', 'cleanup', 'reconcile'] as const);
export type LaneOperationKind = (typeof LANE_OPERATION_KINDS)[number];

export const LANE_OPERATION_STATUSES = Object.freeze([
  'pending',
  'succeeded',
  'failed',
  'refused',
  'kept'
] as const);
export type LaneOperationStatus = (typeof LANE_OPERATION_STATUSES)[number];

export const JOURNAL_KINDS = Object.freeze([
  'landing-intent',
  'landing-observed',
  'cancel',
  'reconcile'
] as const);
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export const LANDING_METHODS = Object.freeze(['ff-merge', 'update-ref'] as const);
export type LandingMethod = (typeof LANDING_METHODS)[number];

export const RECEIPT_OUTCOMES = Object.freeze(['landed', 'blocked', 'uncertain'] as const);
export type ReceiptOutcome = (typeof RECEIPT_OUTCOMES)[number];

export const JOURNAL_OUTCOMES = Object.freeze([...RECEIPT_OUTCOMES, 'canceled'] as const);
export type JournalOutcome = (typeof JOURNAL_OUTCOMES)[number];

export const LANE_PAGE_LIMIT_MAX = 200;
export const LANE_CAP_DEFAULT = 1;
export const LANE_CAP_MAX = 20;
export const PROVISIONING_DEADLINE_DEFAULT_MS = 120_000;
export const PROVISIONING_DEADLINE_MIN_MS = 1_000;
export const PROVISIONING_DEADLINE_MAX_MS = 600_000;

/** Bounds of a verification profile (research R9). */
export const VERIFICATION_LIMITS = Object.freeze({
  maxChecks: 8,
  maxArgs: 32,
  maxArgChars: 512,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 600_000,
  maxProfileJsonBytes: 8_192
});

/** FR-007: carried on every lane read. A unit test fixes the text. */
export const LANE_DISCLOSURE =
  'A lane is a separate Git working tree. It is a working-tree boundary, not a permission boundary: ' +
  "the repository's hooks, configuration, credentials and object store are shared with it, and a " +
  "process in a lane can reach anything the operator's checkout can. Lane operations may run the " +
  "repository's hooks, and a fast-forward landing in a checked-out branch may run `post-merge`.";

export interface LaneRefusalCommits {
  readonly expected: string;
  readonly candidate: string;
  readonly observed?: string;
}

export interface LaneRefusal {
  readonly reason: LaneRefusalReason;
  /** Present only on `uncertain` and some `blocked` outcomes (contract §6). */
  readonly commits?: LaneRefusalCommits;
}

export type LaneResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: LaneRefusal };

export interface VerificationCheck {
  /** `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` */
  readonly name: string;
  /** 1 to 32 arguments of at most 512 characters; run with no shell. */
  readonly argv: readonly string[];
  /** 1,000 to 600,000 ms. */
  readonly timeoutMs: number;
}

export interface VerificationProfile {
  readonly profileId: string;
  /** A positive integer. */
  readonly revision: number;
  /** 1 to 8 checks. */
  readonly checks: readonly VerificationCheck[];
}

export interface CandidateView {
  readonly candidateId: string;
  readonly seq: number;
  readonly commit: string;
  readonly tree: string;
  readonly parent: string;
  readonly createdAt: string;
}

export interface LaneView {
  readonly laneId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly rootExecutionId: string;
  readonly sourceCommit: string;
  readonly baseRef: string;
  readonly candidateRef: string;
  readonly state: LaneState;
  readonly stateReason: string | null;
  readonly pinned: boolean;
  readonly ownerGeneration: number;
  readonly currentCandidate: CandidateView | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disclosure: typeof LANE_DISCLOSURE;
}

export interface ReceiptView {
  readonly receiptId: string;
  readonly candidateCommit: string;
  readonly targetCommit: string;
  readonly profileRevision: number;
  readonly profileDigest: string;
  readonly approvedAt: string;
  readonly outcome: ReceiptOutcome | null;
  readonly outcomeReason: string | null;
}

export interface IntegrationRequestView {
  readonly requestId: string;
  readonly laneId: string;
  readonly candidateId: string;
  readonly candidateCommit: string;
  readonly targetRef: string;
  readonly expectedTargetCommit: string;
  readonly profile: { readonly profileId: string; readonly revision: number; readonly digest: string };
  readonly state: IntegrationState;
  readonly reason: string | null;
  readonly verificationAttempt: number;
  readonly receipt: ReceiptView | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface VerificationCheckView {
  readonly checkIndex: number;
  readonly name: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly outputBytes: number;
  readonly outputSha256: string;
  readonly passed: boolean;
}

export interface LanePage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface ReconcileReport {
  readonly lanes: readonly {
    readonly laneId: string;
    readonly from: LaneState;
    readonly to: LaneState;
    readonly observation: string | null;
  }[];
  readonly requests: readonly {
    readonly requestId: string;
    readonly from: IntegrationState;
    readonly to: IntegrationState;
    readonly reason: string | null;
    readonly commits?: LaneRefusalCommits;
  }[];
  /** A count only; unknown worktrees' paths are never reported. */
  readonly unknownWorktrees: number;
}

export interface CleanupReport {
  readonly removed: readonly string[];
  /**
   * `observation` is `lane-pinned`, `lane-state-invalid`, `lane-not-found` (a named lane the
   * workspace does not hold), `lane-busy` (another operation of this host holds it), or one of
   * `LANE_OBSERVATIONS`.
   */
  readonly kept: readonly { readonly laneId: string; readonly observation: string }[];
}

export function laneRefused<T>(reason: LaneRefusalReason, commits?: LaneRefusalCommits): LaneResult<T> {
  return commits === undefined
    ? { ok: false, refusal: { reason } }
    : { ok: false, refusal: { reason, commits } };
}

export function laneOk<T>(value: T): LaneResult<T> {
  return { ok: true, value };
}
