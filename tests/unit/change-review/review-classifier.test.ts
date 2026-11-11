// FR-R6-F12 T022 (FR-006 to FR-009; research R4; SC-002) — classifying a built review.
//
// WHAT THIS PINS:
//   - each research R4 rule fires, and an earlier rule wins over a later one;
//   - each bound value changed alone reads `stale` with its own reason and landing not eligible;
//   - a tip read failure reads `uncertain` / `target-unreadable`;
//   - approval and landing eligibility give every reason in its order, and landing is eligible
//     only for a `current` review with a matching unsettled receipt.

import { describe, expect, it } from 'vitest';
import type { BoundValues } from '../../../src/services/change-review/comparison-revision';
import { classifyReview, type TipRead } from '../../../src/services/change-review/review-classifier';
import {
  CANDIDATE,
  MOVED_TARGET,
  TARGET,
  TARGET_REF,
  receiptRecord,
  requestRecord
} from './fake-review-git';

const BOUND: BoundValues = {
  candidateCommit: CANDIDATE,
  targetRef: TARGET_REF,
  targetCommit: TARGET,
  profileRevision: 2,
  profileDigest: 'digest-a'
};

const TIP_AT_TARGET: TipRead = { ok: true, value: TARGET };

describe('classifyReview state', () => {
  it('reads an unchanged request at the same tip as current', () => {
    expect(classifyReview({ bound: BOUND, request: requestRecord(), receipt: null, tip: TIP_AT_TARGET })).toMatchObject({
      state: 'current',
      reason: null
    });
  });

  it.each([
    ['a removed request', null, TIP_AT_TARGET, 'stale', 'request-closed'],
    ['a landed request', requestRecord({ state: 'landed' }), TIP_AT_TARGET, 'stale', 'request-closed'],
    ['a canceled request', requestRecord({ state: 'canceled' }), TIP_AT_TARGET, 'stale', 'request-closed'],
    ['a new candidate', requestRecord({ candidateCommit: 'd'.repeat(40) }), TIP_AT_TARGET, 'stale', 'candidate-changed'],
    [
      'a refreeze',
      requestRecord({ state: 'blocked', reason: 'review-stale' }),
      TIP_AT_TARGET,
      'stale',
      'candidate-changed'
    ],
    ['a new target ref', requestRecord({ targetRef: 'refs/heads/next' }), TIP_AT_TARGET, 'stale', 'target-advanced'],
    ['a new target commit', requestRecord({ expectedTargetCommit: MOVED_TARGET }), TIP_AT_TARGET, 'stale', 'target-advanced'],
    ['a new profile revision', requestRecord({ profileRevision: 3 }), TIP_AT_TARGET, 'stale', 'profile-changed'],
    ['a new profile digest', requestRecord({ profileDigest: 'digest-b' }), TIP_AT_TARGET, 'stale', 'profile-changed'],
    ['an unreadable tip', requestRecord(), { ok: false } as TipRead, 'uncertain', 'target-unreadable'],
    ['a moved tip', requestRecord(), { ok: true, value: MOVED_TARGET } as TipRead, 'stale', 'target-advanced'],
    ['a removed ref', requestRecord(), { ok: true, value: null } as TipRead, 'stale', 'target-advanced']
  ] as const)('reads %s as %s / %s', (_label, request, tip, state, reason) => {
    const classified = classifyReview({ bound: BOUND, request, receipt: receiptRecord(), tip });
    expect(classified).toMatchObject({ state, reason, landing: { eligible: false, reason: 'review-not-current' } });
    expect(classified.approval).toEqual({ eligible: false, reason: 'review-not-current' });
  });

  it('lets an earlier rule win over a later one', () => {
    const closedAndMoved = requestRecord({ state: 'landed', candidateCommit: 'd'.repeat(40), profileRevision: 9 });
    expect(classifyReview({ bound: BOUND, request: closedAndMoved, receipt: null, tip: { ok: false } }).reason).toBe(
      'request-closed'
    );
    const newCandidateAndProfile = requestRecord({ candidateCommit: 'd'.repeat(40), profileRevision: 9 });
    expect(classifyReview({ bound: BOUND, request: newCandidateAndProfile, receipt: null, tip: TIP_AT_TARGET }).reason).toBe(
      'candidate-changed'
    );
    const newTargetAndProfile = requestRecord({ expectedTargetCommit: MOVED_TARGET, profileRevision: 9 });
    expect(classifyReview({ bound: BOUND, request: newTargetAndProfile, receipt: null, tip: TIP_AT_TARGET }).reason).toBe(
      'target-advanced'
    );
    const newProfileAndUnreadable = requestRecord({ profileRevision: 9 });
    expect(classifyReview({ bound: BOUND, request: newProfileAndUnreadable, receipt: null, tip: { ok: false } }).reason).toBe(
      'profile-changed'
    );
  });
});

describe('classifyReview eligibility', () => {
  it('makes approval eligible for a current awaiting-review request with no receipt', () => {
    const classified = classifyReview({ bound: BOUND, request: requestRecord(), receipt: null, tip: TIP_AT_TARGET });
    expect(classified.approval).toEqual({ eligible: true, reason: null });
    expect(classified.landing).toEqual({ eligible: false, reason: 'receipt-missing' });
  });

  it('reads another request state as request-state for both', () => {
    const classified = classifyReview({
      bound: BOUND,
      request: requestRecord({ state: 'verifying' }),
      receipt: null,
      tip: TIP_AT_TARGET
    });
    expect(classified.state).toBe('current');
    expect(classified.approval).toEqual({ eligible: false, reason: 'request-state' });
    expect(classified.landing).toEqual({ eligible: false, reason: 'request-state' });
  });

  it('reads an existing receipt as already-approved', () => {
    const classified = classifyReview({ bound: BOUND, request: requestRecord(), receipt: receiptRecord(), tip: TIP_AT_TARGET });
    expect(classified.approval).toEqual({ eligible: false, reason: 'already-approved' });
    expect(classified.landing).toEqual({ eligible: true, reason: null });
  });

  it('reads a receipt for other values as receipt-mismatch', () => {
    const receipt = receiptRecord({ profileDigest: 'digest-z' });
    const classified = classifyReview({ bound: BOUND, request: requestRecord(), receipt, tip: TIP_AT_TARGET });
    expect(classified.landing).toEqual({ eligible: false, reason: 'receipt-mismatch' });
  });

  it('reads a receipt with an outcome as receipt-settled', () => {
    const receipt = receiptRecord({ outcome: 'landed' });
    const classified = classifyReview({ bound: BOUND, request: requestRecord(), receipt, tip: TIP_AT_TARGET });
    expect(classified.landing).toEqual({ eligible: false, reason: 'receipt-settled' });
  });
});
