// Feature 014 — Schedule specification normalization.
//
// Transforms the two user-facing strings (`chronologicalTime` like '04:00'
// and `periodicInterval` like 'Every 4h') into a single typed shape that
// every platform installer consumes. Reuses `parsePeriodic` from
// settings.ts so the periodic regex has a single source of truth.
//
// R-07: emit a warning when the periodic interval is < 5h, because the
// scheduler does NOT verify that the previous Claude 5-hour rolling
// allocation window has reset; firing more often than that wastes tokens.
// The warning is informational only — the install proceeds.

import type { WakeUpSettings } from './settings';
import { parsePeriodic } from './settings';

export type ScheduleKind = 'chronological' | 'periodic';

export interface NormalizedSchedule {
  readonly kind: ScheduleKind;
  /** Set when kind === 'periodic'. Milliseconds between firings. */
  readonly everyMs?: number;
  /** Set when kind === 'chronological'. 0-23 inclusive. */
  readonly hour?: number;
  /** Set when kind === 'chronological'. 0-59 inclusive. */
  readonly minute?: number;
}

const CHRONO_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/**
 * Project validated settings onto a normalized schedule shape. Callers
 * MUST have called `validateSettings` first; this function is the
 * "trusted projection" step that runs only after invariants pass.
 *
 * @throws {Error} If the underlying string fails its regex — indicates
 *   the caller skipped validation.
 */
export function normalizeSchedule(settings: WakeUpSettings): NormalizedSchedule {
  if (settings.schedulerType === 'chronological') {
    if (!CHRONO_RE.test(settings.chronologicalTime)) {
      throw new Error(`invalid chronological time: ${settings.chronologicalTime}`);
    }
    const [hourStr, minuteStr] = settings.chronologicalTime.split(':');
    return {
      kind: 'chronological',
      hour: Number.parseInt(hourStr, 10),
      minute: Number.parseInt(minuteStr, 10)
    };
  }
  const parsed = parsePeriodic(settings.periodicInterval);
  if (!parsed) {
    throw new Error(`invalid periodic interval: ${settings.periodicInterval}`);
  }
  return { kind: 'periodic', everyMs: parsed.everyMs };
}

/**
 * Per R-07: scheduling more frequently than Claude's 5-hour rolling
 * allocation reset means the next fire happens before the previous
 * window has refilled — tokens are wasted. UI may surface a soft
 * warning when this returns true. It does NOT block save.
 */
export function isSubFiveHourPeriodic(schedule: NormalizedSchedule): boolean {
  return schedule.kind === 'periodic'
    && typeof schedule.everyMs === 'number'
    && schedule.everyMs < FIVE_HOURS_MS;
}
