import { describe, expect, it } from 'vitest';
import {
  STALE_LIVE_MAX_MS,
  STALE_SLOWING_MAX_MS,
  computeFreshness
} from '../../../../src/ui/sidebar/freshness';

describe('freshness thresholds', () => {
  it('exposes the documented threshold constants', () => {
    expect(STALE_LIVE_MAX_MS).toBe(30_000);
    expect(STALE_SLOWING_MAX_MS).toBe(90_000);
  });
});

describe('computeFreshness — terminal/idle statuses', () => {
  it('idle status returns idle regardless of input', () => {
    expect(computeFreshness('idle', null)).toBe('idle');
    expect(computeFreshness('idle', 0)).toBe('idle');
    expect(computeFreshness('idle', 1_000_000)).toBe('idle');
  });

  it('completed status returns idle', () => {
    expect(computeFreshness('completed', null)).toBe('idle');
    expect(computeFreshness('completed', 1_000)).toBe('idle');
  });

  it('canceled status returns idle', () => {
    expect(computeFreshness('canceled', null)).toBe('idle');
    expect(computeFreshness('canceled', 1_000)).toBe('idle');
  });
});

describe('computeFreshness — paused status', () => {
  it('paused returns paused regardless of activity time', () => {
    expect(computeFreshness('paused', null)).toBe('paused');
    expect(computeFreshness('paused', 0)).toBe('paused');
    expect(computeFreshness('paused', 1_000_000)).toBe('paused');
  });
});

describe('computeFreshness — running status', () => {
  it('null msSinceLastActivity is presumed live', () => {
    expect(computeFreshness('running', null)).toBe('live');
  });

  it('returns live below the live threshold', () => {
    expect(computeFreshness('running', 0)).toBe('live');
    expect(computeFreshness('running', 1)).toBe('live');
    expect(computeFreshness('running', 29_999)).toBe('live');
  });

  it('returns slowing in the [30s, 90s) range', () => {
    expect(computeFreshness('running', 30_000)).toBe('slowing');
    expect(computeFreshness('running', 60_000)).toBe('slowing');
    expect(computeFreshness('running', 89_999)).toBe('slowing');
  });

  it('returns stalled at or above 90s', () => {
    expect(computeFreshness('running', 90_000)).toBe('stalled');
    expect(computeFreshness('running', 600_000)).toBe('stalled');
  });
});

describe('computeFreshness — failed status (carryover)', () => {
  it('null msSinceLastActivity returns live (fresh failure)', () => {
    expect(computeFreshness('failed', null)).toBe('live');
  });

  it('uses the running thresholds verbatim', () => {
    expect(computeFreshness('failed', 0)).toBe('live');
    expect(computeFreshness('failed', 29_999)).toBe('live');
    expect(computeFreshness('failed', 30_000)).toBe('slowing');
    expect(computeFreshness('failed', 89_999)).toBe('slowing');
    expect(computeFreshness('failed', 90_000)).toBe('stalled');
  });
});
