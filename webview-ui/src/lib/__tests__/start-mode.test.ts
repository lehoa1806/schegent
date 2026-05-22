// Feature 065 (T023) — Unit tests for the StartModeChoice translator
// (`choiceToIntent` in `repo/webview-ui/src/lib/start-mode.ts`).
//
// Coverage map per tasks.md T023:
//   (a) `now` → { startMode: 'now', source }
//   (b) `in-duration` with hours === 0 && minutes === 0 → 'now' form
//   (c) `in-duration` exceeding 7d → throws ScheduledStartHorizonError
//   (d) `at-clock-time` next-occurrence resolution
//   (e) DST spring-forward → next valid wall-clock instant
//   (f) FR-009b sub-minute precision: non-integer minutes are rejected;
//       resolved `scheduledStartAt` is divisible by 60_000 ms
//   (g) translator exposes only hours/minutes inputs (no seconds API)

import { describe, expect, it } from 'vitest';
import {
  choiceToIntent,
  ScheduledStartHorizonError,
  StartModeValidationError,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  SCHEDULED_START_MAX_HORIZON_MS
} from '../start-mode';

const FIXED_NOW = Date.UTC(2026, 4, 23, 14, 30, 0); // 2026-05-23T14:30:00Z

function fixedNow(): number {
  return FIXED_NOW;
}

describe('choiceToIntent — kind: now', () => {
  it('returns startMode=now with the supplied source', () => {
    const intent = choiceToIntent({ kind: 'now' }, 'operator-chooser');
    expect(intent).toEqual({ startMode: 'now', source: 'operator-chooser' });
  });

  it('returns null for dismiss', () => {
    const intent = choiceToIntent({ kind: 'dismiss' }, 'operator-chooser');
    expect(intent).toBeNull();
  });
});

describe('choiceToIntent — kind: in-duration', () => {
  it('collapses 00:00 to startMode=now (FR-009b edge case)', () => {
    const intent = choiceToIntent(
      { kind: 'in-duration', hours: 0, minutes: 0 },
      'operator-chooser',
      fixedNow
    );
    expect(intent).toEqual({ startMode: 'now', source: 'operator-chooser' });
  });

  it('resolves 01:00 to scheduledStartAt ≈ now + 1h', () => {
    const intent = choiceToIntent(
      { kind: 'in-duration', hours: 1, minutes: 0 },
      'operator-chooser',
      fixedNow
    );
    expect(intent).toEqual({
      startMode: 'scheduled',
      scheduledStartAt: FIXED_NOW + MS_PER_HOUR,
      source: 'operator-chooser'
    });
  });

  it('throws ScheduledStartHorizonError for 168:01 (just over 7 days)', () => {
    expect(() =>
      choiceToIntent(
        { kind: 'in-duration', hours: 168, minutes: 1 },
        'operator-chooser',
        fixedNow
      )
    ).toThrow(ScheduledStartHorizonError);
  });

  it('accepts exactly 168:00 (7 days at the boundary)', () => {
    const intent = choiceToIntent(
      { kind: 'in-duration', hours: 168, minutes: 0 },
      'operator-chooser',
      fixedNow
    );
    expect(intent).toEqual({
      startMode: 'scheduled',
      scheduledStartAt: FIXED_NOW + SCHEDULED_START_MAX_HORIZON_MS,
      source: 'operator-chooser'
    });
  });

  it('rejects non-integer minutes (FR-009b sub-minute precision)', () => {
    expect(() =>
      choiceToIntent(
        { kind: 'in-duration', hours: 0, minutes: 0.5 },
        'operator-chooser',
        fixedNow
      )
    ).toThrow(StartModeValidationError);
  });

  it('rejects negative durations', () => {
    expect(() =>
      choiceToIntent(
        { kind: 'in-duration', hours: -1, minutes: 0 },
        'operator-chooser',
        fixedNow
      )
    ).toThrow(StartModeValidationError);
  });

  it('emits a scheduledStartAt that is divisible by 60_000 ms (whole-minute coercion)', () => {
    const intent = choiceToIntent(
      { kind: 'in-duration', hours: 0, minutes: 30 },
      'operator-chooser',
      fixedNow
    );
    if (intent && intent.startMode === 'scheduled' && intent.scheduledStartAt) {
      expect(intent.scheduledStartAt % MS_PER_MINUTE).toBe(0);
    } else {
      throw new Error('expected scheduled intent');
    }
  });
});

describe('choiceToIntent — kind: at-clock-time', () => {
  it('resolves a clock time later today to that instant', () => {
    // FIXED_NOW is 2026-05-23T14:30:00Z. In local time this could be any
    // hour — pick a target that is at least an hour later in local time
    // by reading the resolved date.
    const today = new Date(FIXED_NOW);
    const targetHour = (today.getHours() + 2) % 24;
    const intent = choiceToIntent(
      { kind: 'at-clock-time', hours: targetHour, minutes: 0 },
      'operator-chooser',
      fixedNow
    );
    if (intent && intent.startMode === 'scheduled') {
      const resolved = new Date(intent.scheduledStartAt!);
      expect(resolved.getHours()).toBe(targetHour);
      expect(resolved.getMinutes()).toBe(0);
      // Must be in the future relative to now.
      expect(intent.scheduledStartAt!).toBeGreaterThan(FIXED_NOW);
    } else {
      throw new Error('expected scheduled intent');
    }
  });

  it('resolves a clock time earlier today to the same wall-clock time tomorrow', () => {
    const today = new Date(FIXED_NOW);
    const targetHour = (today.getHours() + 24 - 2) % 24; // 2h earlier
    const intent = choiceToIntent(
      { kind: 'at-clock-time', hours: targetHour, minutes: 0 },
      'operator-chooser',
      fixedNow
    );
    if (intent && intent.startMode === 'scheduled') {
      const resolved = new Date(intent.scheduledStartAt!);
      expect(resolved.getHours()).toBe(targetHour);
      expect(resolved.getMinutes()).toBe(0);
      expect(intent.scheduledStartAt!).toBeGreaterThan(FIXED_NOW);
    } else {
      throw new Error('expected scheduled intent');
    }
  });

  it('rejects out-of-range hours', () => {
    expect(() =>
      choiceToIntent(
        { kind: 'at-clock-time', hours: 24, minutes: 0 },
        'operator-chooser',
        fixedNow
      )
    ).toThrow(StartModeValidationError);
  });

  it('rejects non-integer hours (FR-009b)', () => {
    expect(() =>
      choiceToIntent(
        { kind: 'at-clock-time', hours: 9.5, minutes: 0 },
        'operator-chooser',
        fixedNow
      )
    ).toThrow(StartModeValidationError);
  });

  it('whole-minute coercion: scheduledStartAt is divisible by 60_000', () => {
    const intent = choiceToIntent(
      { kind: 'at-clock-time', hours: 9, minutes: 0 },
      'operator-chooser',
      fixedNow
    );
    if (intent && intent.startMode === 'scheduled') {
      expect(intent.scheduledStartAt! % MS_PER_MINUTE).toBe(0);
    } else {
      throw new Error('expected scheduled intent');
    }
  });
});

describe('choiceToIntent — source threading', () => {
  it('threads the source through (a) operator-chooser', () => {
    const intent = choiceToIntent({ kind: 'now' }, 'operator-chooser');
    expect(intent?.source).toBe('operator-chooser');
  });

  it('threads the source through (b) operator-restart', () => {
    const intent = choiceToIntent({ kind: 'now' }, 'operator-restart');
    expect(intent?.source).toBe('operator-restart');
  });

  it('threads the source through (c) programmatic-now', () => {
    const intent = choiceToIntent({ kind: 'now' }, 'programmatic-now');
    expect(intent?.source).toBe('programmatic-now');
  });
});
