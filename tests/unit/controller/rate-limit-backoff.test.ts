import { describe, it, expect, beforeEach } from 'vitest';
import {
  RATE_LIMIT_FAMILY,
  backoffForCause,
  toDelayedRetryCause,
  type BackoffClock
} from '../../../src/controller/rate-limit-backoff';
import {
  RATE_LIMIT_BACKOFF_MS,
  RETRY_BUFFER_MS,
  RETRY_FLOOR_MS,
  TRANSIENT_BACKOFF_MS
} from '../../../src/controller/retry-constants';

class FixedClock implements BackoffClock {
  constructor(private epoch: number) {}
  now(): number {
    return this.epoch;
  }
  set(t: number): void {
    this.epoch = t;
  }
}

describe('Feature 034 Item 047 — RateLimitBackoff (extracted from workflow-controller)', () => {
  describe('RATE_LIMIT_FAMILY', () => {
    it('contains every operator-visible rate-limit cause label (027 FR-016, 066 FR-009)', () => {
      // Pinned matrix — adding a new label requires a matching audit-log
      // consumer update, so the test fails the build when the set drifts.
      expect([...RATE_LIMIT_FAMILY].sort()).toEqual([
        'credits-exhausted',
        'out-of-credits',
        'out-of-usage',
        'quota-exceeded',
        'rate-limit',
        'rate_limit'
      ]);
    });
  });

  describe('toDelayedRetryCause', () => {
    it('returns transient_error verbatim', () => {
      expect(toDelayedRetryCause('transient_error')).toBe('transient_error');
    });

    it('normalizes every rate-limit family label to rate_limit', () => {
      for (const cause of RATE_LIMIT_FAMILY) {
        expect(toDelayedRetryCause(cause)).toBe('rate_limit');
      }
    });

    it('returns null for unknown causes', () => {
      expect(toDelayedRetryCause('unrecognized')).toBeNull();
      expect(toDelayedRetryCause()).toBeNull();
      expect(toDelayedRetryCause(undefined)).toBeNull();
    });
  });

  describe('backoffForCause — transient_error', () => {
    it('returns the fixed TRANSIENT_BACKOFF_MS regardless of resetsAtMs', () => {
      expect(backoffForCause('transient_error')).toBe(TRANSIENT_BACKOFF_MS);
      expect(backoffForCause('transient_error', 9_999_999)).toBe(TRANSIENT_BACKOFF_MS);
      expect(backoffForCause('transient_error', null)).toBe(TRANSIENT_BACKOFF_MS);
    });
  });

  describe('backoffForCause — rate_limit', () => {
    const NOW = 1_700_000_000_000;
    let clock: FixedClock;
    beforeEach(() => {
      clock = new FixedClock(NOW);
    });

    it('falls back to RATE_LIMIT_BACKOFF_MS when resetsAtMs is null', () => {
      expect(backoffForCause('rate_limit', null, clock)).toBe(RATE_LIMIT_BACKOFF_MS);
    });

    it('falls back to RATE_LIMIT_BACKOFF_MS when resetsAtMs is undefined', () => {
      expect(backoffForCause('rate_limit', undefined, clock)).toBe(RATE_LIMIT_BACKOFF_MS);
    });

    it('falls back to RATE_LIMIT_BACKOFF_MS when resetsAtMs is NaN', () => {
      expect(backoffForCause('rate_limit', NaN, clock)).toBe(RATE_LIMIT_BACKOFF_MS);
    });

    it('falls back to RATE_LIMIT_BACKOFF_MS when resetsAtMs is Infinity', () => {
      expect(backoffForCause('rate_limit', Infinity, clock)).toBe(RATE_LIMIT_BACKOFF_MS);
    });

    it('returns RETRY_FLOOR_MS when parsed reset is in the past (027 FR-010)', () => {
      // Past epoch — dynamic wait is negative, floor takes over.
      expect(backoffForCause('rate_limit', NOW - 60_000, clock)).toBe(RETRY_FLOOR_MS);
    });

    it('returns RETRY_FLOOR_MS when parsed reset equals now', () => {
      expect(backoffForCause('rate_limit', NOW, clock)).toBe(RETRY_FLOOR_MS);
    });

    it('returns parsed delta + RETRY_BUFFER_MS when resetsAtMs is far in the future (027 FR-009)', () => {
      const delta = 30 * 60 * 1000; // 30 minutes in future
      const got = backoffForCause('rate_limit', NOW + delta, clock);
      expect(got).toBe(delta + RETRY_BUFFER_MS);
    });

    it('trusts the parsed resetsAtMs even when it is hours ahead (027 + CLAUDE.md hard rule)', () => {
      // The dynamic path explicitly does NOT cap; DELAYED_RETRY_CAP bounds attempts.
      const delta = 6 * 60 * 60 * 1000; // 6 hours
      const got = backoffForCause('rate_limit', NOW + delta, clock);
      expect(got).toBe(delta + RETRY_BUFFER_MS);
      expect(got).toBeGreaterThan(RATE_LIMIT_BACKOFF_MS);
    });

    it('honors the injected clock for deterministic test runs', () => {
      const future = NOW + 5 * 60 * 1000;
      const got1 = backoffForCause('rate_limit', future, clock);
      clock.set(NOW + 60_000);
      const got2 = backoffForCause('rate_limit', future, clock);
      // After 1 minute passes, the dynamic wait shrinks by 60_000 ms.
      expect(got1 - got2).toBe(60_000);
    });
  });

  // Feature 066 — past-timestamp safety guard for out-of-credits causes.
  // The CLI returns `resetsAt` as the LAST rolling reset (already in the
  // past) for hard-cap accounts; without this guard the dynamic path
  // would clamp to RETRY_FLOOR_MS and produce a 1-minute retry loop.
  describe('backoffForCause — out-of-credits past-timestamp guard (Feature 066)', () => {
    const NOW = 1_700_000_000_000;
    let clock: FixedClock;
    beforeEach(() => {
      clock = new FixedClock(NOW);
    });

    it('returns RATE_LIMIT_BACKOFF_MS when originalCause is out-of-credits AND reset is in the past', () => {
      const past = NOW - 60 * 60 * 1000; // 1 hour ago
      expect(backoffForCause('rate_limit', past, clock, 'out-of-credits')).toBe(
        RATE_LIMIT_BACKOFF_MS
      );
    });

    it('returns RATE_LIMIT_BACKOFF_MS when originalCause is out-of-credits AND reset equals now', () => {
      expect(backoffForCause('rate_limit', NOW, clock, 'out-of-credits')).toBe(
        RATE_LIMIT_BACKOFF_MS
      );
    });

    it('keeps the dynamic 1-minute floor for non-out-of-credits causes when reset is in the past (FR-011 regression)', () => {
      const past = NOW - 60 * 60 * 1000;
      expect(backoffForCause('rate_limit', past, clock, 'rate-limit')).toBe(RETRY_FLOOR_MS);
      expect(backoffForCause('rate_limit', past, clock, 'out-of-usage')).toBe(RETRY_FLOOR_MS);
      expect(backoffForCause('rate_limit', past, clock, 'credits-exhausted')).toBe(RETRY_FLOOR_MS);
      expect(backoffForCause('rate_limit', past, clock, 'quota-exceeded')).toBe(RETRY_FLOOR_MS);
    });

    it('keeps the dynamic floor when originalCause is omitted (pre-066 callers byte-for-byte)', () => {
      const past = NOW - 60 * 60 * 1000;
      expect(backoffForCause('rate_limit', past, clock)).toBe(RETRY_FLOOR_MS);
    });

    it('does NOT fire the guard when reset is in the future, even for out-of-credits', () => {
      const future = NOW + 5 * 60 * 1000; // 5 minutes ahead
      const got = backoffForCause('rate_limit', future, clock, 'out-of-credits');
      // Dynamic path: future - now + RETRY_BUFFER_MS
      expect(got).toBe(5 * 60 * 1000 + RETRY_BUFFER_MS);
    });

    it('returns RATE_LIMIT_BACKOFF_MS when resetsAtMs is null AND originalCause is out-of-credits (existing null path unchanged)', () => {
      expect(backoffForCause('rate_limit', null, clock, 'out-of-credits')).toBe(
        RATE_LIMIT_BACKOFF_MS
      );
    });

    it('toDelayedRetryCause normalizes out-of-credits to rate_limit (FR-009)', () => {
      expect(toDelayedRetryCause('out-of-credits')).toBe('rate_limit');
    });
  });
});
