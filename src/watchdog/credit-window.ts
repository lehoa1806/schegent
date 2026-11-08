// FR-R4-F02 (spec 240, US6; contract W3 G5 to G8, W6 G20; data-model §3; FR-020, FR-021) — the
// 24-hour window a credit-paused Run is polled for, as one pure patch.
//
// The window is per Run and persisted with the pause (`creditPause`), so a reload cannot start it
// over and one Run's expiry cannot end a sibling's polling. The watchdog applies this patch inside
// the `KEYS.run` chain, one link per Run, at the start of each poll: the patch reads the Run as it
// is THEN, so a Run resumed, replaced or already stopped between the watchdog's read and the write
// is left exactly as it is.
import {
  DEFAULT_MONITORING_WINDOW_MS,
  MAX_MONITORING_WINDOW_MS,
  MIN_MONITORING_WINDOW_MS
} from '../contracts/backend-availability';
import { CREDIT_POLL_WINDOW_MS } from '../contracts/retry-bounds';
import { creditPauseOf, type RunPatch, type WorkflowRun } from '../state/workflow-run';

/**
 * The notice a Run's window stop raises, once per Run (W6 G20). Fixed text: no account text, no
 * amount, and no Run or queue name rides on it.
 */
export const CREDIT_WINDOW_STOPPED_NOTICE =
  'Schegent stopped checking credits for a paused run after 24 hours. Resume it when your account has credits.';

/**
 * FR-R5-F28 (SPEC-06, D1, D7) — Clamp or default a monitoring window duration to the
 * allowed 60,000..172,800,000 ms bounds (default 86,400,000 ms).
 */
export function normalizeMonitoringWindowMs(windowMs?: number): number {
  if (
    windowMs === undefined ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < MIN_MONITORING_WINDOW_MS ||
    windowMs > MAX_MONITORING_WINDOW_MS
  ) {
    return DEFAULT_MONITORING_WINDOW_MS;
  }
  return windowMs;
}

/**
 * The patch that moves `current`'s credit window forward at poll time `now`: start it when it has
 * not started, stop it when it has run its length, and leave it alone otherwise (including when
 * the Run holds no open credit pause any more).
 */
export function creditWindowPatch(
  current: WorkflowRun,
  now: number,
  windowDurationMs: number = CREDIT_POLL_WINDOW_MS
): RunPatch {
  const pause = creditPauseOf(current);
  if (pause === null || pause.stoppedAt !== null) return {};
  if (pause.windowStartedAt === null) return { creditPause: { ...pause, windowStartedAt: now } };
  if (pause.windowStartedAt + windowDurationMs <= now) {
    return { creditPause: { ...pause, stoppedAt: now } };
  }
  return {};
}

/** A Run whose credit window is open: paused for credits and not stopped. */
export function hasOpenCreditWindow(run: WorkflowRun): boolean {
  const pause = creditPauseOf(run);
  return pause !== null && pause.stoppedAt === null;
}
