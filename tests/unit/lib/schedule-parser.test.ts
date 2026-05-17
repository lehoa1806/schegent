import { describe, it, expect } from 'vitest';
import { parseSchedule, resolveNextFireAt } from '../../../src/lib/schedule-parser';

const NOW = new Date(2026, 0, 1, 10, 0, 0).getTime();

describe('parseSchedule (017, T012)', () => {
  it('parses "in 5m" as relative 5 minutes', () => {
    const r = parseSchedule('in 5m', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schedule).toEqual({
        kind: 'relative',
        expression: 'in 5m',
        setAt: new Date(NOW).toISOString(),
        targetAt: new Date(NOW + 5 * 60_000).toISOString(),
        recurrence: 'one-shot'
      });
    }
  });

  it('parses "in 2h" as relative 2 hours', () => {
    const r = parseSchedule('in 2h', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schedule.targetAt).toBe(new Date(NOW + 2 * 3_600_000).toISOString());
    }
  });

  it('parses "at 09:30" as absolute minute-of-day 570', () => {
    const r = parseSchedule('at 09:30', NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schedule.expression).toBe('at 09:30');
      expect(r.schedule.targetAt).toBe(new Date(2026, 0, 2, 9, 30, 0).toISOString());
    }
  });

  it('parses "at 00:00" and "at 23:59" boundary values', () => {
    const a = parseSchedule('at 00:00', NOW);
    const b = parseSchedule('at 23:59', NOW);
    expect(a.ok && a.schedule.expression).toBe('at 00:00');
    expect(b.ok && b.schedule.expression).toBe('at 23:59');
  });

  it('trims surrounding whitespace', () => {
    const r = parseSchedule('   in 1m   ');
    expect(r.ok).toBe(true);
  });

  it('collapses whitespace between keyword and value', () => {
    const r = parseSchedule('in   5m');
    expect(r.ok).toBe(true);
  });

  it('rejects empty input', () => {
    const r = parseSchedule('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('empty-input');
  });

  it('rejects mixed units like "in 2h30m"', () => {
    const r = parseSchedule('in 2h30m');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('mixed-units');
  });

  it('rejects out-of-range minutes (0 and 1441)', () => {
    expect(parseSchedule('in 0m').ok).toBe(false);
    const r = parseSchedule('in 1441m');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('value-out-of-range');
  });

  it('rejects out-of-range hours (0 and 25)', () => {
    expect(parseSchedule('in 0h').ok).toBe(false);
    const r = parseSchedule('in 25h');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('value-out-of-range');
  });

  it('rejects invalid HH:MM', () => {
    const r1 = parseSchedule('at 24:00');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe('invalid-time-of-day');
    const r2 = parseSchedule('at 09:60');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('invalid-time-of-day');
  });

  it('rejects uppercase or unknown formats', () => {
    expect(parseSchedule('In 5m').ok).toBe(false);
    expect(parseSchedule('every 5m').ok).toBe(false);
    expect(parseSchedule('5m').ok).toBe(false);
  });

  it('rejects non-string input', () => {
    // @ts-expect-error invalid input on purpose
    const r = parseSchedule(null);
    expect(r.ok).toBe(false);
  });
});

describe('resolveNextFireAt (017, T012)', () => {
  it('adds delayMs to now for relative schedules', () => {
    const targetAt = new Date(1_700_000_000_000 + 5 * 60_000).toISOString();
    const out = resolveNextFireAt(
      {
        kind: 'relative',
        expression: 'in 5m',
        setAt: new Date(1_700_000_000_000).toISOString(),
        targetAt,
        recurrence: 'one-shot'
      },
      1_700_000_000_000
    );
    expect(out).toBe(1_700_000_000_000 + 5 * 60_000);
  });

  it('returns same-day target for absolute schedules in the future', () => {
    const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const targetAt = new Date(2026, 0, 1, 15, 0, 0).toISOString();
    const out = resolveNextFireAt(
      {
        kind: 'absolute',
        expression: 'at 15:00',
        setAt: new Date(now).toISOString(),
        targetAt,
        recurrence: 'one-shot'
      },
      now
    );
    expect(out).toBe(new Date(2026, 0, 1, 15, 0, 0).getTime());
  });

  it('rolls forward to tomorrow when absolute target has passed', () => {
    const now = new Date(2026, 0, 1, 16, 0, 0).getTime();
    const targetAt = new Date(2026, 0, 2, 15, 0, 0).toISOString();
    const out = resolveNextFireAt(
      {
        kind: 'absolute',
        expression: 'at 15:00',
        setAt: new Date(now).toISOString(),
        targetAt,
        recurrence: 'one-shot'
      },
      now
    );
    expect(out).toBe(new Date(2026, 0, 2, 15, 0, 0).getTime());
  });

  it('rolls forward when absolute target equals the current minute exactly', () => {
    const now = new Date(2026, 0, 1, 15, 0, 0).getTime();
    const parsed = parseSchedule('at 15:00', now);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(resolveNextFireAt(parsed.schedule, now)).toBe(new Date(2026, 0, 2, 15, 0, 0).getTime());
    }
  });
});
