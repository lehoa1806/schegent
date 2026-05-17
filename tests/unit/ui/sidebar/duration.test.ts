import { describe, expect, it } from 'vitest';
import { formatDuration } from '../../../../src/ui/sidebar/duration';

describe('formatDuration', () => {
  it('returns 0s for zero or negative values', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-1)).toBe('0s');
    expect(formatDuration(-1_000)).toBe('0s');
  });

  it('returns 0s for non-finite values', () => {
    expect(formatDuration(Number.NaN)).toBe('0s');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0s');
    expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe('0s');
  });

  it('renders sub-second values as 0s', () => {
    expect(formatDuration(1)).toBe('0s');
    expect(formatDuration(999)).toBe('0s');
  });

  it('renders seconds-only durations under a minute', () => {
    expect(formatDuration(1_000)).toBe('1s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(59_000)).toBe('59s');
    expect(formatDuration(59_999)).toBe('59s');
  });

  it('renders minutes-and-seconds durations under an hour', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(83_000)).toBe('1m 23s');
    expect(formatDuration(3_540_000)).toBe('59m 0s');
    expect(formatDuration(3_599_000)).toBe('59m 59s');
  });

  it('renders hours-and-minutes durations at or above an hour', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(7_380_000)).toBe('2h 3m');
    expect(formatDuration(36_000_000)).toBe('10h 0m');
  });

  it('caps at 99h 59m for unreasonably large values', () => {
    expect(formatDuration(360_000_000)).toBe('99h 59m');
    expect(formatDuration(Number.MAX_SAFE_INTEGER)).toBe('99h 59m');
  });
});
