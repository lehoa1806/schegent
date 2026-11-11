/**
 * FR-R6-F12 (contracts/change-review.md) — the change review contract.
 *
 * A review compares a candidate commit with the target commit its F10 integration request was
 * frozen against. It lists every changed path once, gives each existing side an opaque content
 * handle, and states whether the review still matches the request (`current`), no longer matches
 * it (`stale`), could not be checked (`uncertain`), or could not be built (`unavailable`).
 *
 * Every outcome is a value, never a throw. Approval and landing eligibility are display only: the
 * F10 operations keep their own checks. Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const CHANGE_KINDS = Object.freeze([
  'added',
  'modified',
  'deleted',
  'renamed',
  'type-changed',
  'submodule'
] as const);
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const REVIEW_STATES = Object.freeze(['current', 'stale', 'uncertain', 'unavailable'] as const);
export type ReviewState = (typeof REVIEW_STATES)[number];

/** Why a built review no longer matches its request (research R4). */
export const STALE_REASONS = Object.freeze([
  'target-advanced',
  'candidate-changed',
  'profile-changed',
  'request-closed'
] as const);
export type StaleReason = (typeof STALE_REASONS)[number];

/**
 * Why a review's match could not be checked: the target tip, or the request or its receipt, could
 * not be read (review R-2: a store read that throws is a value, never a rejection).
 */
export const UNCERTAIN_REASONS = Object.freeze(['target-unreadable', 'record-unreadable'] as const);
export type UncertainReason = (typeof UNCERTAIN_REASONS)[number];

/** Why no review could be built; no partial inventory is ever shown (spec, Edge Cases). */
export const UNAVAILABLE_REASONS = Object.freeze([
  'record-invalid',
  'record-unreadable',
  'commit-missing',
  'target-diverged',
  'inventory-failed',
  'inventory-deadline',
  'inventory-oversized'
] as const);
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export type ReviewStateReason = StaleReason | UncertainReason | null;

export const REVIEW_REFUSAL_REASONS = Object.freeze([
  'invalid-input',
  'workspace-untrusted',
  'request-not-found',
  'revision-mismatch',
  'review-not-found',
  'cursor-invalid',
  'superseded',
  'canceled'
] as const);
export type ReviewRefusalReason = (typeof REVIEW_REFUSAL_REASONS)[number];

export const APPROVAL_INELIGIBLE_REASONS = Object.freeze([
  'review-not-current',
  'request-state',
  'already-approved'
] as const);
export type ApprovalIneligibleReason = (typeof APPROVAL_INELIGIBLE_REASONS)[number];

export const LANDING_INELIGIBLE_REASONS = Object.freeze([
  'review-not-current',
  'request-state',
  'receipt-missing',
  'receipt-mismatch',
  'receipt-settled'
] as const);
export type LandingIneligibleReason = (typeof LANDING_INELIGIBLE_REASONS)[number];

/** The fixed sentence a content side shows instead of its text (contract section 5). */
export const PLACEHOLDER_SENTENCES = Object.freeze({
  binary: 'Binary content is not shown.',
  oversized: 'This file is larger than 1 MiB and is not shown.',
  submodule: 'Submodule entry: there is no file content to show.',
  missing: 'This content is no longer in the repository.',
  unavailable: 'This review has been closed or replaced. Open the review again.',
  'read-failed': 'This content could not be read.'
} as const);
export type PlaceholderReason = keyof typeof PLACEHOLDER_SENTENCES;
export const PLACEHOLDER_REASONS: readonly PlaceholderReason[] = Object.freeze(
  Object.keys(PLACEHOLDER_SENTENCES) as PlaceholderReason[]
);

export const CHANGE_REVIEW_LIMITS = Object.freeze({
  pageEntriesMax: 200,
  loadedEntriesMax: 1000,
  sideBytesMax: 1_048_576,
  liveReviewsMax: 8,
  inventoryOutputBytesMax: 16_777_216,
  gitTimeoutMs: 10_000,
  displayNameCharsMax: 120,
  cursorCharsMax: 128
});

/** FR-003: availability and coverage values that must never read as a count or a success. */
export const AVAILABILITY_VALUES = Object.freeze([
  'unknown',
  'partial',
  'expired',
  'uncertain',
  'missing',
  'unavailable'
] as const);
export type AvailabilityValue = (typeof AVAILABILITY_VALUES)[number];

const AVAILABILITY_PHRASES: Readonly<Record<AvailabilityValue, string>> = Object.freeze({
  unknown: 'Unknown: not measured',
  partial: 'Partial: some values are missing',
  expired: 'Expired: no longer kept',
  uncertain: 'Uncertain: could not be confirmed',
  missing: 'Missing: not recorded',
  unavailable: 'Unavailable: cannot be shown'
});

/** The labelled, digit-free phrase a surface shows for an availability value (FR-003). */
export function availabilityPhrase(value: AvailabilityValue): string {
  return AVAILABILITY_PHRASES[value];
}

export interface Eligibility<R extends string> {
  readonly eligible: boolean;
  /** `null` exactly when `eligible`. */
  readonly reason: R | null;
}

export interface ReviewDescriptor {
  readonly reviewId: string;
  readonly requestId: string;
  readonly candidateId: string;
  readonly candidateCommit: string;
  readonly targetRef: string;
  readonly targetCommit: string;
  readonly profileRevision: number;
  readonly profileDigest: string;
  readonly comparisonRevision: string;
  readonly total: number;
  readonly loaded: number;
  readonly truncated: boolean;
  readonly state: Exclude<ReviewState, 'unavailable'>;
  readonly reason: ReviewStateReason;
  readonly approval: Eligibility<ApprovalIneligibleReason>;
  readonly landing: Eligibility<LandingIneligibleReason>;
  readonly createdAt: string;
}

export interface ChangeEntry {
  readonly index: number;
  readonly kind: ChangeKind;
  /** Exact repository text; render as inert text only (FR-013). `null` for `added`. */
  readonly oldPath: string | null;
  /** Exact repository text; render as inert text only (FR-013). `null` for `deleted`. */
  readonly newPath: string | null;
  readonly binary: boolean;
  readonly oldHandle: string | null;
  readonly newHandle: string | null;
  /** 0 to 100 for `renamed`, otherwise `null`. */
  readonly similarity: number | null;
}

export interface ReviewPage {
  readonly reviewId: string;
  readonly entries: readonly ChangeEntry[];
  readonly nextCursor: string | null;
}

export type ReviewOpened =
  | {
      readonly state: 'unavailable';
      readonly reason: UnavailableReason;
      readonly review: null;
      readonly firstPage: null;
    }
  | {
      readonly state: Exclude<ReviewState, 'unavailable'>;
      readonly reason: ReviewStateReason;
      readonly review: ReviewDescriptor;
      readonly firstPage: ReviewPage;
    };

export type ContentRead =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'placeholder'; readonly reason: PlaceholderReason; readonly text: string };

export type ReviewResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ReviewRefusalReason };

export function reviewOk<T>(value: T): ReviewResult<T> {
  return { ok: true, value };
}

export function reviewRefused<T = never>(reason: ReviewRefusalReason): ReviewResult<T> {
  return { ok: false, reason };
}

/** The placeholder read for `reason`. */
export function placeholderRead(reason: PlaceholderReason): ContentRead {
  return { kind: 'placeholder', reason, text: PLACEHOLDER_SENTENCES[reason] };
}
