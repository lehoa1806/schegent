// FR-R3-008 (T380) — the webview's read seam for the two reload-durable Run
// readings: when the Run last produced output, and how far through its frozen
// plan it is.
//
// A helper rather than expressions inside the component, because the rule these
// encode is the one the acceptance criterion names and it is the rule a renderer
// gets wrong by accident: **absent is unknown, never zero**. A Run written before
// the feature carries no liveness stamp and no recorded total, and the honest
// rendering of that is "unknown" — not "silent for 0s", which reads as *just now*,
// and not "0%", which reads as *no progress yet*. Both of those are stale
// readings dressed as fresh ones, and both are indistinguishable from the real
// values they impersonate. Keeping the decision here means one place decides it
// and a unit test can pin it without mounting a component.
//
// Nothing here recomputes a fraction. `percent` arrives rounded and clamped from
// the host (`projectRunProgress`), which divides the numerator and denominator
// that `run-planned-total.ts` keeps consistent; dividing them again on this side
// is how the two ends come to disagree.

import { formatDuration } from './format-duration';
import type { RunLivenessProjection, RunProgressProjection } from './snapshot-types';

/** The one word both readings use for absence. Exported so tests name it once. */
export const UNKNOWN_LABEL = 'unknown';

export interface RunLivenessView {
  /** False when the record carries no stamp; the labels below say so in words. */
  readonly known: boolean;
  /** e.g. `last output 2m 14s ago`, or `unknown`. */
  readonly label: string;
  /** e.g. `1204 stdout / 3 stderr lines this phase`; empty when unknown. */
  readonly detail: string;
}

export interface RunProgressView {
  readonly known: boolean;
  /** e.g. `3 of 7 phases (43%)`, or `unknown`. */
  readonly label: string;
  /** 0..100 for a meter's width, or `null` — a meter must not be drawn at 0. */
  readonly percent: number | null;
  /** The frozen cap this Run runs with, in words; empty when unknown. */
  readonly detail: string;
}

const UNKNOWN_LIVENESS: RunLivenessView = Object.freeze({
  known: false,
  label: UNKNOWN_LABEL,
  detail: ''
});

const UNKNOWN_PROGRESS: RunProgressView = Object.freeze({
  known: false,
  label: UNKNOWN_LABEL,
  percent: null,
  detail: ''
});

/**
 * How long the Run has been silent, in words.
 *
 * `nowMs` is passed in rather than read from the clock so the reading refreshes
 * on the shared tick the rest of the webview already pays for, and so a test can
 * state a time instead of mocking one.
 *
 * A stamp in the future — a clock that moved between the write and this read —
 * is floored to zero rather than rendered as a negative age. That is a display
 * detail; the host never writes a stamp backwards.
 */
export function deriveRunLivenessView(
  liveness: RunLivenessProjection | null | undefined,
  nowMs: number
): RunLivenessView {
  if (!liveness) return UNKNOWN_LIVENESS;
  const at = Date.parse(liveness.lastActivityAt);
  if (!Number.isFinite(at)) return UNKNOWN_LIVENESS;
  const elapsed = Math.max(0, nowMs - at);
  return Object.freeze({
    known: true,
    label: `last output ${formatDuration(elapsed)} ago`,
    detail: `${liveness.stdoutLines} stdout / ${liveness.stderrLines} stderr lines this phase`
  });
}

/**
 * Progress against the total the Run froze at creation.
 *
 * `phaseCount === 0` is a real state — a Run whose every phase the operator
 * overrode — and the host reports it as 100%. It is reported as known here for
 * the same reason: there is nothing outstanding, which is a fact about the plan
 * rather than a missing reading.
 */
export function deriveRunProgressView(
  progress: RunProgressProjection | null | undefined
): RunProgressView {
  if (!progress) return UNKNOWN_PROGRESS;
  if (!Number.isFinite(progress.percent)) return UNKNOWN_PROGRESS;
  const percent = Math.min(100, Math.max(0, Math.round(progress.percent)));
  const noun = progress.phaseCount === 1 ? 'phase' : 'phases';
  return Object.freeze({
    known: true,
    label: `${progress.phasesCompleted} of ${progress.phaseCount} ${noun} (${percent}%)`,
    percent,
    detail: `up to ${progress.maxPhaseInvocations} invocations at this run's frozen cap of ${progress.iterationCap}`
  });
}
