import { describe, expect, it } from 'vitest';

import { PressureStatusTracker } from '../../../src/services/runtime-resource-budgets/pressure-status.js';

describe('PressureStatusTracker (FR-017)', () => {
  it('validates constructor thresholds and interval', () => {
    expect(
      () =>
        new PressureStatusTracker({
          id: 'bad-hysteresis',
          raiseAt: 70,
          clearAt: 80,
          minWarningIntervalMs: 1_000
        })
    ).toThrow(/clearAt/);
  });

  it('raises at raiseAt, remains raised in the hysteresis band, and clears only at or below clearAt', () => {
    const tracker = new PressureStatusTracker({
      id: 'accounting-intent-backlog',
      raiseAt: 8_000,
      clearAt: 6_000,
      minWarningIntervalMs: 30_000
    });

    const below = tracker.observe(7_999, 1_000);
    expect(below.status).toBe('clear');
    expect(below.transition).toBeNull();
    expect(below.warningEmitted).toBe(false);

    const raised = tracker.observe(8_000, 2_000);
    expect(raised.status).toBe('raised');
    expect(raised.transition).toBe('raised');
    expect(raised.warningEmitted).toBe(true);

    // Inside hysteresis band (6_001..7_999): does NOT clear
    const inBand = tracker.observe(6_500, 3_000);
    expect(inBand.status).toBe('raised');
    expect(inBand.transition).toBeNull();

    // Clears only when measured sample <= clearAt (6_000)
    const cleared = tracker.observe(6_000, 4_000);
    expect(cleared.status).toBe('clear');
    expect(cleared.transition).toBe('cleared');
  });

  it('rate-limits repeated warnings across minWarningIntervalMs and counts suppressed warnings', () => {
    const tracker = new PressureStatusTracker({
      id: 'usage-ingestion-pressure',
      raiseAt: 100,
      clearAt: 80,
      minWarningIntervalMs: 10_000
    });

    const firstRaise = tracker.observe(105, 1_000);
    expect(firstRaise.warningEmitted).toBe(true);
    expect(firstRaise.suppressedWarnings).toBe(0);

    // Clear and re-raise within the 10s interval
    tracker.observe(75, 2_000);
    const secondRaise = tracker.observe(110, 5_000);
    expect(secondRaise.status).toBe('raised');
    expect(secondRaise.transition).toBe('raised');
    expect(secondRaise.warningEmitted).toBe(false);
    expect(secondRaise.suppressedWarnings).toBe(1);

    // Still high within the interval
    const stillHigh = tracker.observe(120, 8_000);
    expect(stillHigh.warningEmitted).toBe(false);
    expect(stillHigh.suppressedWarnings).toBe(2);

    // After minWarningIntervalMs has elapsed
    const afterInterval = tracker.observe(120, 11_000);
    expect(afterInterval.warningEmitted).toBe(true);
    expect(afterInterval.suppressedWarnings).toBe(2);
  });
});

