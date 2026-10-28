// FR-R4-F02 (spec 240, US1; contract U1 G1, G2; data-model §2; FR-001, FR-002) — one pure,
// allow-list decision for whether an unattended wakeup may resume a Run.
//
// At `5d700407` the credits-restored sweep resumed EVERY key of the Run map that had no pending
// delayed retry, so a failed sibling was restarted with a fresh retry budget, and an operator's own
// pause was undone. The decision below is the only rule. It is an ALLOW-list: a Run is eligible only
// when every rule passes, so a pause cause added later is ineligible without an edit here.
//
// Pure: no I/O, no clock read (the caller hands `now`), no `vscode`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideUnattendedEligibility,
  type UnattendedWakeup
} from '../../../src/services/unattended-eligibility';
import type { ManualPauseCause, WorkflowRun } from '../../../src/state/workflow-run';

const NOW = 1_700_000_000_000;
const QUEUE = 'queue-a';

const CREDITS: UnattendedWakeup = { cause: 'credits-restored', queueId: QUEUE, evidenceAt: NOW };
const BACKOFF: UnattendedWakeup = { cause: 'backoff-elapsed', queueId: QUEUE, deadline: NOW - 1 };

/** A Run paused for credits: paused, no pair of either kind, an open credit pause. */
function creditPausedRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'task-1',
    status: 'paused',
    currentPhase: 'speckit-plan',
    delayedRetryCount: 1,
    pendingRetryAt: null,
    pendingRetryCause: null,
    manualPauseAt: null,
    manualPauseCause: null,
    resumeTargetPhaseId: null,
    creditPause: { pausedAt: NOW - 5_000, windowStartedAt: NOW - 4_000, stoppedAt: null },
    ...overrides
  } as unknown as WorkflowRun;
}

/** A Run paused on a delayed retry whose deadline is `at`. */
function backoffRun(at: number, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return creditPausedRun({
    creditPause: null,
    pendingRetryAt: at,
    pendingRetryCause: 'rate_limit',
    ...overrides
  });
}

afterEach(() => vi.restoreAllMocks());

describe('rules 1 to 6c, in order, each with its reason (contract U1 G1)', () => {
  it('rule 1: no Run on the queue is no-run', () => {
    expect(decideUnattendedEligibility(null, CREDITS, NOW)).toEqual({ eligible: false, reason: 'no-run' });
    expect(decideUnattendedEligibility(null, BACKOFF, NOW)).toEqual({ eligible: false, reason: 'no-run' });
  });

  it.each(['running', 'failed', 'completed', 'canceled'] as const)(
    'rule 2: a %s Run is not-paused',
    (status) => {
      const run = creditPausedRun({ status });
      expect(decideUnattendedEligibility(run, CREDITS, NOW)).toEqual({ eligible: false, reason: 'not-paused' });
      expect(decideUnattendedEligibility(run, BACKOFF, NOW)).toEqual({ eligible: false, reason: 'not-paused' });
    }
  );

  it('rule 3: a manual-pause cause is manual-pause, whichever wakeup asks', () => {
    const run = creditPausedRun({ manualPauseAt: NOW - 1, manualPauseCause: 'operator-paused' });
    expect(decideUnattendedEligibility(run, CREDITS, NOW)).toEqual({ eligible: false, reason: 'manual-pause' });
    const withBackoff = backoffRun(NOW - 1, { manualPauseAt: NOW - 1, manualPauseCause: 'operator-paused' });
    expect(decideUnattendedEligibility(withBackoff, BACKOFF, NOW)).toEqual({
      eligible: false,
      reason: 'manual-pause'
    });
  });

  it('rule 4b: a backoff wakeup for a Run with no retry pair is cause-mismatch', () => {
    expect(decideUnattendedEligibility(creditPausedRun(), BACKOFF, NOW)).toEqual({
      eligible: false,
      reason: 'cause-mismatch'
    });
  });

  it('rule 4b: a one-sided retry pair is cause-mismatch, never eligible', () => {
    const half = creditPausedRun({ creditPause: null, pendingRetryAt: NOW - 1, pendingRetryCause: null });
    expect(decideUnattendedEligibility(half, BACKOFF, NOW)).toEqual({
      eligible: false,
      reason: 'cause-mismatch'
    });
  });

  it('rule 5b: a backoff whose deadline is in the future is deadline-not-reached', () => {
    expect(decideUnattendedEligibility(backoffRun(NOW + 1), BACKOFF, NOW)).toEqual({
      eligible: false,
      reason: 'deadline-not-reached'
    });
  });

  it('rules 4b and 5b pass: a backoff whose deadline has elapsed is eligible, at or after the deadline', () => {
    expect(decideUnattendedEligibility(backoffRun(NOW), BACKOFF, NOW)).toEqual({ eligible: true });
    expect(decideUnattendedEligibility(backoffRun(NOW - 60_000), BACKOFF, NOW)).toEqual({ eligible: true });
  });

  it('rule 4c: a credits wakeup for a Run waiting on a backoff is backoff-pending (a pending backoff wins)', () => {
    const run = backoffRun(NOW + 60_000, { creditPause: { pausedAt: NOW, windowStartedAt: null, stoppedAt: null } });
    // The invariant forbids both at once on a persisted Run; the rule order is what is asserted.
    expect(decideUnattendedEligibility(run, CREDITS, NOW)).toEqual({ eligible: false, reason: 'backoff-pending' });
    expect(decideUnattendedEligibility(backoffRun(NOW + 60_000), CREDITS, NOW)).toEqual({
      eligible: false,
      reason: 'backoff-pending'
    });
  });

  it('rule 5c: a credits wakeup for a Run with no credit pause is cause-mismatch', () => {
    expect(decideUnattendedEligibility(creditPausedRun({ creditPause: null }), CREDITS, NOW)).toEqual({
      eligible: false,
      reason: 'cause-mismatch'
    });
    const absentKey = creditPausedRun();
    delete (absentKey as { creditPause?: unknown }).creditPause;
    expect(decideUnattendedEligibility(absentKey, CREDITS, NOW)).toEqual({
      eligible: false,
      reason: 'cause-mismatch'
    });
  });

  it('rule 6c: a credit pause whose polling stopped is credit-polling-stopped', () => {
    const stopped = creditPausedRun({
      creditPause: { pausedAt: NOW - 90_000, windowStartedAt: NOW - 89_000, stoppedAt: NOW - 1_000 }
    });
    expect(decideUnattendedEligibility(stopped, CREDITS, NOW)).toEqual({
      eligible: false,
      reason: 'credit-polling-stopped'
    });
  });

  it('every rule passing: a credit-paused Run with an open window is eligible for a credits wakeup', () => {
    expect(decideUnattendedEligibility(creditPausedRun(), CREDITS, NOW)).toEqual({ eligible: true });
    const unstarted = creditPausedRun({
      creditPause: { pausedAt: NOW - 5_000, windowStartedAt: null, stoppedAt: null }
    });
    expect(decideUnattendedEligibility(unstarted, CREDITS, NOW)).toEqual({ eligible: true });
  });

  it('a credit-paused Run is not eligible for a backoff wakeup, and the reverse', () => {
    expect(decideUnattendedEligibility(creditPausedRun(), BACKOFF, NOW).eligible).toBe(false);
    expect(decideUnattendedEligibility(backoffRun(NOW - 1), CREDITS, NOW).eligible).toBe(false);
  });
});

describe('the sibling states of SC-001 (data-model §2)', () => {
  const SIBLINGS: ReadonlyArray<readonly [string, Partial<WorkflowRun>, string]> = [
    ['failed', { status: 'failed', creditPause: null, delayedRetryCount: 5 }, 'not-paused'],
    ['running', { status: 'running', creditPause: null }, 'not-paused'],
    [
      'operator-paused',
      { creditPause: null, manualPauseAt: NOW, manualPauseCause: 'operator-paused' },
      'manual-pause'
    ],
    [
      'queue-paused mid-run',
      { creditPause: null, manualPauseAt: NOW, manualPauseCause: 'queue-paused-mid-run' },
      'manual-pause'
    ],
    [
      'breakpoint-paused',
      {
        creditPause: null,
        manualPauseAt: NOW,
        manualPauseCause: 'breakpoint-paused',
        resumeTargetPhaseId: 'speckit-plan'
      },
      'manual-pause'
    ],
    [
      'verify-paused',
      { creditPause: null, manualPauseAt: NOW, manualPauseCause: 'verify-paused' },
      'manual-pause'
    ],
    [
      'spend-paused',
      { creditPause: null, manualPauseAt: NOW, manualPauseCause: 'spend-bound-reached' },
      'manual-pause'
    ]
  ];

  it.each(SIBLINGS)('%s: ineligible for both wakeups', (_name, overrides, reason) => {
    const run = creditPausedRun(overrides);
    expect(decideUnattendedEligibility(run, CREDITS, NOW)).toEqual({ eligible: false, reason });
    expect(decideUnattendedEligibility(run, BACKOFF, NOW)).toEqual({ eligible: false, reason });
  });

  it('a future backoff: deadline-not-reached on a backoff event, backoff-pending on a credits event', () => {
    const run = backoffRun(NOW + 3_600_000);
    expect(decideUnattendedEligibility(run, BACKOFF, NOW)).toEqual({
      eligible: false,
      reason: 'deadline-not-reached'
    });
    expect(decideUnattendedEligibility(run, CREDITS, NOW)).toEqual({
      eligible: false,
      reason: 'backoff-pending'
    });
  });

  it('a retry-cap-exhausted pause (paused, count at the cap, both pairs null, no credit pause) is cause-mismatch', () => {
    const run = creditPausedRun({ creditPause: null, delayedRetryCount: 5 });
    expect(decideUnattendedEligibility(run, CREDITS, NOW)).toEqual({ eligible: false, reason: 'cause-mismatch' });
    expect(decideUnattendedEligibility(run, BACKOFF, NOW)).toEqual({ eligible: false, reason: 'cause-mismatch' });
  });
});

describe('the allow-list is closed against a pause cause added later (contract U1 G2)', () => {
  // Typed as `Record<ManualPauseCause, true>`, so a member added to the union fails
  // `typecheck:tests` here until someone decides it. The loop then asserts the decision for each.
  const EVERY_MANUAL_PAUSE_CAUSE: Readonly<Record<ManualPauseCause, true>> = {
    'operator-paused': true,
    'queue-paused-mid-run': true,
    'breakpoint-paused': true,
    'verify-paused': true,
    'spend-bound-reached': true
  };

  it.each(Object.keys(EVERY_MANUAL_PAUSE_CAUSE) as ManualPauseCause[])(
    '%s is manual-pause for both wakeups',
    (cause) => {
      const credit = creditPausedRun({ manualPauseAt: NOW, manualPauseCause: cause });
      const backoff = backoffRun(NOW - 1, { manualPauseAt: NOW, manualPauseCause: cause });
      expect(decideUnattendedEligibility(credit, CREDITS, NOW)).toEqual({ eligible: false, reason: 'manual-pause' });
      expect(decideUnattendedEligibility(backoff, BACKOFF, NOW)).toEqual({ eligible: false, reason: 'manual-pause' });
    }
  );

  it('control: the enumeration is not empty', () => {
    expect(Object.keys(EVERY_MANUAL_PAUSE_CAUSE).length).toBeGreaterThanOrEqual(5);
  });
});

describe('the decision is pure (contract U1 G1)', () => {
  it('reads no clock: the instant is an argument', () => {
    const now = vi.spyOn(Date, 'now');
    decideUnattendedEligibility(backoffRun(NOW), BACKOFF, NOW);
    decideUnattendedEligibility(creditPausedRun(), CREDITS, NOW);
    expect(now).not.toHaveBeenCalled();
  });

  it('does not change the Run it is given', () => {
    const run = creditPausedRun();
    const before = JSON.stringify(run);
    decideUnattendedEligibility(run, CREDITS, NOW);
    expect(JSON.stringify(run)).toBe(before);
  });
});
