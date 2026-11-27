// FR-R6-F07 (FR-014) — saturating live-log counters.

import { describe, expect, it } from 'vitest';
import {
  LIVE_LOG_COUNTER_NAMES,
  LiveLogCounters
} from '../../../../src/services/phase-log/live-log-counters';
import { LIVE_LOG_COUNTER_MAX } from '../../../../src/contracts/phase-log-bounds';

describe('LiveLogCounters (FR-R6-F07)', () => {
  it('starts every counter at zero', () => {
    const snapshot = new LiveLogCounters().snapshot();
    expect(Object.keys(snapshot).sort()).toEqual([...LIVE_LOG_COUNTER_NAMES].sort());
    for (const name of LIVE_LOG_COUNTER_NAMES) expect(snapshot[name]).toBe(0);
  });

  it('adds integer amounts and defaults to one', () => {
    const counters = new LiveLogCounters();
    counters.add('omittedBytes', 300);
    counters.add('omittedBytes', 12);
    counters.add('deliveryGaps');
    expect(counters.snapshot()).toMatchObject({ omittedBytes: 312, deliveryGaps: 1 });
  });

  it('saturates at the counter maximum', () => {
    const counters = new LiveLogCounters();
    counters.add('replayAttempts', LIVE_LOG_COUNTER_MAX - 1);
    counters.add('replayAttempts', 5);
    counters.add('sourceResets', Number.MAX_SAFE_INTEGER);
    expect(counters.snapshot().replayAttempts).toBe(LIVE_LOG_COUNTER_MAX);
    expect(counters.snapshot().sourceResets).toBe(LIVE_LOG_COUNTER_MAX);
  });

  it('ignores amounts that are not positive integers', () => {
    const counters = new LiveLogCounters();
    for (const bad of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      counters.add('duplicateBatches', bad);
    }
    expect(counters.snapshot().duplicateBatches).toBe(0);
  });

  it('returns a frozen plain snapshot that later adds do not change', () => {
    const counters = new LiveLogCounters();
    counters.add('omittedRecords', 2);
    const snapshot = counters.snapshot();
    counters.add('omittedRecords', 3);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.getPrototypeOf(snapshot)).toBe(Object.prototype);
    expect(snapshot.omittedRecords).toBe(2);
  });
});
