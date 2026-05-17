/**
 * Feature 017 — Schedule mini-DSL parser (pure, no I/O, no clock).
 *
 * Two accepted shapes (FR-018, single-unit only — `in 2h30m` is rejected):
 *
 *   1. `in <N>m` — relative delay in minutes, `N ∈ [1, 1440]` (1 day cap).
 *   2. `in <N>h` — relative delay in hours,   `N ∈ [1, 24]`   (1 day cap).
 *   3. `at HH:MM` — absolute 24h local time. Returns the local minute-of-day
 *      `∈ [0, 1439]`. Callers that need a concrete next-occurrence timestamp
 *      using the injected save time.
 *
 * All input is trimmed once at the entry point and treated case-sensitively
 * (`In 5m` is rejected — operators paste from the UI form where the helper
 * placeholder shows the canonical lowercase form). Whitespace between the
 * keyword and the value is collapsed: `in   5m` is accepted.
 *
 * Returns a discriminated union — never throws — so callers can render the
 * error verbatim in the UI without exception plumbing. The error `code`
 * lets the host surface a stable telemetry signal.
 */

import type { QueueSchedule } from '../queue/queue-registry';

export const MIN_RELATIVE_MINUTES = 1;
export const MAX_RELATIVE_MINUTES = 1440;
export const MIN_RELATIVE_HOURS = 1;
export const MAX_RELATIVE_HOURS = 24;

export type ScheduleParseError =
  | 'empty-input'
  | 'unrecognized-format'
  | 'value-out-of-range'
  | 'invalid-time-of-day'
  | 'mixed-units';

export type ScheduleParseResult =
  | { readonly ok: true; readonly schedule: QueueSchedule }
  | { readonly ok: false; readonly code: ScheduleParseError; readonly message: string };

const RELATIVE_RE = /^in\s+(\d+)([mh])$/;
const ABSOLUTE_RE = /^at\s+(\d{1,2}):(\d{2})$/;
const MIXED_UNIT_HINT_RE = /^in\s+\d+[mh]\d+[mh]$/i;

export function parseSchedule(raw: string, now: number = Date.now()): ScheduleParseResult {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'empty-input', message: 'Schedule input must be a string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: 'empty-input', message: 'Schedule input is empty' };
  }

  if (MIXED_UNIT_HINT_RE.test(trimmed)) {
    return {
      ok: false,
      code: 'mixed-units',
      message: 'Schedules accept a single unit only (e.g. "in 2h" or "in 30m", not "in 2h30m")'
    };
  }

  const relMatch = RELATIVE_RE.exec(trimmed);
  if (relMatch) {
    const n = Number(relMatch[1]);
    const unit = relMatch[2];
    const expression = `in ${n}${unit}`;
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return {
        ok: false,
        code: 'value-out-of-range',
        message: `Schedule value must be a positive integer (got: ${relMatch[1]})`
      };
    }
    if (unit === 'm') {
      if (n < MIN_RELATIVE_MINUTES || n > MAX_RELATIVE_MINUTES) {
        return {
          ok: false,
          code: 'value-out-of-range',
          message: `Relative minutes must be in [${MIN_RELATIVE_MINUTES}, ${MAX_RELATIVE_MINUTES}] (got: ${n})`
        };
      }
      return {
        ok: true,
        schedule: makeSchedule('relative', expression, now, now + n * 60_000)
      };
    }
    if (n < MIN_RELATIVE_HOURS || n > MAX_RELATIVE_HOURS) {
      return {
        ok: false,
        code: 'value-out-of-range',
        message: `Relative hours must be in [${MIN_RELATIVE_HOURS}, ${MAX_RELATIVE_HOURS}] (got: ${n})`
      };
    }
    return {
      ok: true,
      schedule: makeSchedule('relative', expression, now, now + n * 3_600_000)
    };
  }

  const absMatch = ABSOLUTE_RE.exec(trimmed);
  if (absMatch) {
    const hh = Number(absMatch[1]);
    const mm = Number(absMatch[2]);
    if (!Number.isFinite(hh) || hh < 0 || hh > 23) {
      return {
        ok: false,
        code: 'invalid-time-of-day',
        message: `Hour must be in [0, 23] (got: ${absMatch[1]})`
      };
    }
    if (!Number.isFinite(mm) || mm < 0 || mm > 59) {
      return {
        ok: false,
        code: 'invalid-time-of-day',
        message: `Minute must be in [0, 59] (got: ${absMatch[2]})`
      };
    }
    return {
      ok: true,
      schedule: makeSchedule(
        'absolute',
        `at ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
        now,
        resolveAbsoluteTargetAt(hh, mm, now)
      )
    };
  }

  return {
    ok: false,
    code: 'unrecognized-format',
    message: `Unrecognized schedule. Expected "in <N>m", "in <N>h", or "at HH:MM" (got: ${trimmed})`
  };
}

/**
 * Resolve an absolute next-fire timestamp from a parsed schedule and the
 * caller's "now" (UTC ms). Pure function — for the absolute case the local
 * day is derived from `now` via a `Date` constructor (uses host TZ).
 */
export function resolveNextFireAt(schedule: QueueSchedule, now: number): number {
  const target = Date.parse(schedule.targetAt);
  return Number.isFinite(target) ? target : now;
}

function makeSchedule(
  kind: QueueSchedule['kind'],
  expression: string,
  setAtMs: number,
  targetAtMs: number
): QueueSchedule {
  return {
    kind,
    expression,
    targetAt: new Date(targetAtMs).toISOString(),
    setAt: new Date(setAtMs).toISOString(),
    recurrence: 'one-shot'
  };
}

function resolveAbsoluteTargetAt(hour: number, minute: number, now: number): number {
  const d = new Date(now);
  const target = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    hour,
    minute,
    0,
    0
  ).getTime();
  return target <= now ? target + 86_400_000 : target;
}
