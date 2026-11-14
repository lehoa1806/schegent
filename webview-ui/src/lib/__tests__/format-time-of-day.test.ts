// The time-of-day label: local "HH:MM" by default, "HH:MM:SS" when asked, and empty for a value
// that does not parse. A date-time without a zone parses as local time, so these hold in any zone.

import { describe, expect, it } from 'vitest';
import { formatTimeOfDay } from '../format-time-of-day';

describe('formatTimeOfDay', () => {
  it('gives hours and minutes by default', () => {
    expect(formatTimeOfDay('2026-05-14T09:03:04')).toBe('09:03');
  });

  it('adds seconds when asked', () => {
    expect(formatTimeOfDay('2026-05-14T09:03:04', { seconds: true })).toBe('09:03:04');
  });

  it('gives an empty string for a value that does not parse', () => {
    expect(formatTimeOfDay('not a time')).toBe('');
    expect(formatTimeOfDay('not a time', { seconds: true })).toBe('');
  });
});
