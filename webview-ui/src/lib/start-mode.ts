// Feature 065 — Webview-side translator from the ephemeral `StartModeChoice`
// emitted by the StartModeChooser component to the host-facing
// `EnqueueStartIntent` IPC payload (or `null` when the operator dismisses).
//
// Acceptance scenarios live in
// specs/065-enqueue-start-separation/spec.md §User Story 1. Key rules:
//   - `kind: 'now'`                   → { startMode: 'now', source }
//   - `kind: 'in-duration' { 0, 0 }`  → collapses to { startMode: 'now' }
//   - `kind: 'in-duration'`           → { startMode: 'scheduled', scheduledStartAt: now + dur }
//   - `kind: 'at-clock-time'`         → next local-time occurrence of HH:MM
//   - `kind: 'dismiss'`               → null (no IPC commit)
//   - Horizon > 7 days                → throw `ScheduledStartHorizonError`
//   - DST spring-forward              → resolve to the next valid wall-clock instant
//   - Sub-minute precision (FR-009b)  → reject or coerce to whole-minute resolution

import type { IpcScheduledStartSource } from '../../../src/contracts/sidebar-ipc';

// Mirror the host `EnqueueStartIntent` shape (additive copy so the webview
// can build it without importing the host module from a webview entry point).
export interface EnqueueStartIntent {
  readonly startMode: 'now' | 'scheduled';
  readonly scheduledStartAt?: number;
  readonly source: IpcScheduledStartSource;
}

export type StartModeChoice =
  | { kind: 'now' }
  | { kind: 'in-duration'; hours: number; minutes: number }
  | { kind: 'at-clock-time'; hours: number; minutes: number }
  | { kind: 'dismiss' };

export const SCHEDULED_START_MAX_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;

export class ScheduledStartHorizonError extends Error {
  public readonly requestedScheduledStartAt: number;
  constructor(requestedScheduledStartAt: number) {
    super('scheduled-start-horizon-exceeded');
    this.name = 'ScheduledStartHorizonError';
    this.requestedScheduledStartAt = requestedScheduledStartAt;
  }
}

export class StartModeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartModeValidationError';
  }
}

function requireIntegerMinute(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new StartModeValidationError(
      `${label} must be a whole-minute integer (FR-009b)`
    );
  }
}

/**
 * For an in-duration choice (`hours: H, minutes: M`) compute the resolved
 * `scheduledStartAt`. Coerces to whole-minute resolution (per FR-009b — no
 * sub-minute precision). Throws `ScheduledStartHorizonError` if the result
 * exceeds 7 days from `now`.
 */
function resolveInDuration(
  hours: number,
  minutes: number,
  now: number
): number {
  requireIntegerMinute(hours, 'hours');
  requireIntegerMinute(minutes, 'minutes');
  if (hours < 0 || minutes < 0) {
    throw new StartModeValidationError('hours and minutes must be non-negative');
  }
  const offsetMs = hours * MS_PER_HOUR + minutes * MS_PER_MINUTE;
  const resolved = now + offsetMs;
  if (resolved - now > SCHEDULED_START_MAX_HORIZON_MS) {
    throw new ScheduledStartHorizonError(resolved);
  }
  return resolved;
}

/**
 * For an at-clock-time choice (local wall-clock `HH:MM`) compute the next
 * occurrence in the host's local timezone. If the requested time has already
 * passed today, resolve to the same time tomorrow. Per Acceptance #3.
 *
 * DST handling: when the local clock skips an interval (spring-forward gap),
 * fall forward to the next valid wall-clock instant. We rely on the platform
 * `Date` arithmetic; if the resolved Date's hours don't match the requested
 * hours (because the host clock skipped them), we advance to the next valid
 * minute boundary.
 */
function resolveAtClockTime(
  hours: number,
  minutes: number,
  now: number
): number {
  requireIntegerMinute(hours, 'hours');
  requireIntegerMinute(minutes, 'minutes');
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new StartModeValidationError('hours/minutes out of range');
  }
  const today = new Date(now);
  const candidate = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    hours,
    minutes,
    0,
    0
  );
  let resolved = candidate.getTime();
  if (resolved <= now) {
    const tomorrow = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + 1,
      hours,
      minutes,
      0,
      0
    );
    resolved = tomorrow.getTime();
  }
  // DST gap fall-forward: the resolved Date's wall-clock hours may not match
  // the requested hours if the platform skipped them. Advance one minute at
  // a time until we land on a valid wall-clock instant (max 120 steps =
  // 2 hours of DST gap, which is well beyond any real-world TZ offset).
  let resolvedDate = new Date(resolved);
  let safety = 120;
  while (
    safety-- > 0 &&
    (resolvedDate.getHours() !== hours || resolvedDate.getMinutes() !== minutes)
  ) {
    resolvedDate = new Date(resolvedDate.getTime() + MS_PER_MINUTE);
  }
  resolved = resolvedDate.getTime();
  if (resolved - now > SCHEDULED_START_MAX_HORIZON_MS) {
    throw new ScheduledStartHorizonError(resolved);
  }
  // Coerce to whole-minute resolution (FR-009b).
  return Math.floor(resolved / MS_PER_MINUTE) * MS_PER_MINUTE;
}

/**
 * Translate a `StartModeChoice` to the IPC-facing `EnqueueStartIntent`, or
 * `null` for `dismiss`. The `source` literal is supplied by the caller
 * (typically `'operator-chooser'` for the chooser flow). `nowFn` defaults to
 * `Date.now` and is parameterized for tests.
 */
export function choiceToIntent(
  choice: StartModeChoice,
  source: IpcScheduledStartSource,
  nowFn: () => number = () => Date.now()
): EnqueueStartIntent | null {
  if (choice.kind === 'dismiss') return null;
  if (choice.kind === 'now') {
    return { startMode: 'now', source };
  }
  const now = nowFn();
  if (choice.kind === 'in-duration') {
    // `Start in 00:00` collapses to `now` (per spec Edge Cases).
    if (choice.hours === 0 && choice.minutes === 0) {
      return { startMode: 'now', source };
    }
    return {
      startMode: 'scheduled',
      scheduledStartAt: resolveInDuration(choice.hours, choice.minutes, now),
      source
    };
  }
  // at-clock-time
  return {
    startMode: 'scheduled',
    scheduledStartAt: resolveAtClockTime(choice.hours, choice.minutes, now),
    source
  };
}
