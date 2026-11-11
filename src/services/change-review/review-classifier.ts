/**
 * FR-R6-F12 (FR-006 to FR-009; research R4) — whether a built review still matches its request.
 *
 * Pure: the caller reads the request, the receipt and the target tip, and this decides. The first
 * matching rule wins. Approval and landing eligibility are display only; the F10 operations keep
 * their own checks.
 */

import type {
  ApprovalIneligibleReason,
  Eligibility,
  LandingIneligibleReason,
  ReviewState,
  ReviewStateReason,
  StaleReason
} from '../../contracts/change-review';
import type { ReceiptRecord, RequestRecord } from '../execution-lanes/integration-store-rows';
import { isStaleByRefreeze, receiptMatches } from '../execution-lanes/review-receipts';
import type { BoundValues } from './comparison-revision';

const AWAITING_REVIEW = 'awaiting-review';
const CLOSED_STATES: ReadonlySet<string> = new Set(['landed', 'canceled']);

/** The target tip as read now: a commit, `null` when the ref is gone, or a failed read. */
export type TipRead = { readonly ok: true; readonly value: string | null } | { readonly ok: false };

export interface ClassifyInput {
  readonly bound: BoundValues;
  readonly request: RequestRecord | null;
  readonly receipt: ReceiptRecord | null;
  readonly tip: TipRead;
}

export interface Classified {
  readonly state: Exclude<ReviewState, 'unavailable'>;
  readonly reason: ReviewStateReason;
  readonly approval: Eligibility<ApprovalIneligibleReason>;
  readonly landing: Eligibility<LandingIneligibleReason>;
}

type StateAndReason = Pick<Classified, 'state' | 'reason'>;

const CURRENT: StateAndReason = { state: 'current', reason: null };

function stale(reason: StaleReason): StateAndReason {
  return { state: 'stale', reason };
}

function stateOf(input: ClassifyInput): StateAndReason {
  const { bound, request, tip } = input;
  if (request === null || CLOSED_STATES.has(request.state)) return stale('request-closed');
  if (request.candidateCommit !== bound.candidateCommit || isStaleByRefreeze(request)) return stale('candidate-changed');
  if (request.targetRef !== bound.targetRef || request.expectedTargetCommit !== bound.targetCommit) {
    return stale('target-advanced');
  }
  if (request.profileRevision !== bound.profileRevision || request.profileDigest !== bound.profileDigest) {
    return stale('profile-changed');
  }
  if (!tip.ok) return { state: 'uncertain', reason: 'target-unreadable' };
  if (tip.value !== bound.targetCommit) return stale('target-advanced');
  return CURRENT;
}

function eligible<R extends string>(): Eligibility<R> {
  return { eligible: true, reason: null };
}

function ineligible<R extends string>(reason: R): Eligibility<R> {
  return { eligible: false, reason };
}

function approvalOf(current: boolean, input: ClassifyInput): Eligibility<ApprovalIneligibleReason> {
  if (!current || input.request === null) return ineligible('review-not-current');
  if (input.request.state !== AWAITING_REVIEW) return ineligible('request-state');
  if (input.receipt !== null) return ineligible('already-approved');
  return eligible();
}

function landingOf(current: boolean, input: ClassifyInput): Eligibility<LandingIneligibleReason> {
  const { request, receipt } = input;
  if (!current || request === null) return ineligible('review-not-current');
  if (request.state !== AWAITING_REVIEW) return ineligible('request-state');
  if (receipt === null) return ineligible('receipt-missing');
  if (!receiptMatches(receipt, request)) return ineligible('receipt-mismatch');
  if (receipt.outcome !== null) return ineligible('receipt-settled');
  return eligible();
}

/** The classification when the request or its receipt could not be read: nothing is eligible. */
export const RECORD_UNREADABLE: Classified = Object.freeze({
  state: 'uncertain',
  reason: 'record-unreadable',
  approval: Object.freeze(ineligible<ApprovalIneligibleReason>('review-not-current')),
  landing: Object.freeze(ineligible<LandingIneligibleReason>('review-not-current'))
});

/** The review's state and the display-only eligibility of approval and landing. */
export function classifyReview(input: ClassifyInput): Classified {
  const stateAndReason = stateOf(input);
  const current = stateAndReason.state === 'current';
  return { ...stateAndReason, approval: approvalOf(current, input), landing: landingOf(current, input) };
}
