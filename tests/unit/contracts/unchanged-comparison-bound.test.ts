// FR-R4-F17 (feature 245), contract S4 — the pure rule behind
// `schegent.loop.maxUnchangedComparisons`.
//
// One module answers three questions: what a setting value means (S4.1), whether the bound stops a
// loop at this decision (S4.2), and what the limits view shows (S4.3). The third is asked with the
// same "does the cap outcome fail" test as the second, so the last case compares them.
import { describe, expect, it } from 'vitest';
import {
  MAX_UNCHANGED_COMPARISONS,
  normalizeMaxUnchangedComparisons,
  stopsOnUnchangedMetrics,
  unchangedComparisonBoundState,
  type UnchangedComparisonBoundState
} from '../../../src/contracts/unchanged-comparison-bound';
import type { RetryCapOutcome } from '../../../src/contracts/process-definitions';

const CONDITION = 'pending_tasks > 0';

describe('MAX_UNCHANGED_COMPARISONS (S4)', () => {
  it('is 49, one under the default iteration cap of 50', () => {
    expect(MAX_UNCHANGED_COMPARISONS).toBe(49);
  });
});

describe('normalizeMaxUnchangedComparisons — FR-002, S4.1', () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [49, 49],
    [50, 0],
    [-1, 0],
    [2.5, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    ['2', 0],
    [null, 0],
    [undefined, 0],
    [true, 0]
  ] as const)('reads %o as %i', (raw, expected) => {
    expect(normalizeMaxUnchangedComparisons(raw)).toBe(expected);
  });
});

describe('stopsOnUnchangedMetrics — S4.2', () => {
  const stops = (
    bound: unknown,
    capOutcome: RetryCapOutcome | undefined,
    stalledCount: number | undefined
  ): boolean => stopsOnUnchangedMetrics({ bound, capOutcome, stalledCount });

  it('is false for a normalized bound of 0, whatever the count', () => {
    expect(stops(0, 'fail', 5)).toBe(false);
    expect(stops(50, 'fail', 5)).toBe(false);
    expect(stops(2.5, undefined, 5)).toBe(false);
    expect(stops('2', 'fail', 5)).toBe(false);
  });

  it('is false where the cap outcome continues, however high the count', () => {
    expect(stops(2, 'continue', 5)).toBe(false);
    expect(stops(2, 'continue-degraded', 5)).toBe(false);
  });

  it('is false when the evaluator has no count', () => {
    expect(stops(2, 'fail', undefined)).toBe(false);
    expect(stops(2, undefined, undefined)).toBe(false);
  });

  it('is true for a count at or above the bound when the outcome fails', () => {
    expect(stops(2, 'fail', 2)).toBe(true);
    expect(stops(1, 'fail', 1)).toBe(true);
    expect(stops(49, 'fail', 49)).toBe(true);
  });

  it('treats an absent cap outcome as fail, as the transition always has', () => {
    expect(stops(2, undefined, 2)).toBe(true);
  });

  it('is true for a count above the bound, which a bound lowered mid-loop produces', () => {
    expect(stops(2, 'fail', 4)).toBe(true);
    expect(stops(2, undefined, 4)).toBe(true);
  });

  it('is false for a count below the bound', () => {
    expect(stops(2, 'fail', 1)).toBe(false);
    expect(stops(2, undefined, 0)).toBe(false);
  });
});

describe('unchangedComparisonBoundState — FR-022, S4.3, data-model §10', () => {
  const state = (
    bound: unknown,
    capOutcome: RetryCapOutcome,
    retryCondition: string | undefined
  ): UnchangedComparisonBoundState =>
    unchangedComparisonBoundState({ bound, capOutcome, retryCondition });

  it('is active for a positive bound, a condition and a cap outcome of fail', () => {
    expect(state(2, 'fail', CONDITION)).toBe('active');
    expect(state(49, 'fail', CONDITION)).toBe('active');
  });

  it('is disabled for a normalized value of 0, including an out-of-range value', () => {
    expect(state(0, 'fail', CONDITION)).toBe('disabled');
    expect(state(50, 'fail', CONDITION)).toBe('disabled');
    expect(state(60, 'fail', CONDITION)).toBe('disabled');
    expect(state('2', 'fail', CONDITION)).toBe('disabled');
  });

  it('is inert-no-retry-condition for an absent, empty or whitespace-only condition', () => {
    expect(state(2, 'fail', undefined)).toBe('inert-no-retry-condition');
    expect(state(2, 'fail', '')).toBe('inert-no-retry-condition');
    expect(state(2, 'fail', '   \t\n')).toBe('inert-no-retry-condition');
  });

  it('is inert-cap-outcome where the cap outcome continues', () => {
    expect(state(2, 'continue', CONDITION)).toBe('inert-cap-outcome');
    expect(state(2, 'continue-degraded', CONDITION)).toBe('inert-cap-outcome');
  });

  it('lets disabled win over both inert reasons', () => {
    expect(state(0, 'continue', undefined)).toBe('disabled');
    expect(state(0, 'continue-degraded', '')).toBe('disabled');
  });

  it('lets no-retry-condition win over the cap outcome', () => {
    expect(state(2, 'continue', undefined)).toBe('inert-no-retry-condition');
    expect(state(2, 'continue-degraded', '   ')).toBe('inert-no-retry-condition');
  });

  it('is active exactly when the stop could apply: the same "fail" test as stopsOnUnchangedMetrics', () => {
    const outcomes: readonly RetryCapOutcome[] = ['fail', 'continue', 'continue-degraded'];
    const bounds: readonly unknown[] = [0, 1, 2, 49, 50, -1, 2.5, '2', null, undefined];
    for (const bound of bounds) {
      for (const capOutcome of outcomes) {
        const couldStop = stopsOnUnchangedMetrics({
          bound,
          capOutcome,
          stalledCount: MAX_UNCHANGED_COMPARISONS
        });
        expect(
          state(bound, capOutcome, CONDITION) === 'active',
          `${String(bound)} ${capOutcome}`
        ).toBe(couldStop);
      }
    }
  });
});
