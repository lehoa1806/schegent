/**
 * Feature 034 Item 047 — extracted dynamic + fallback backoff computation.
 *
 * Pure module. No `vscode` import. The function and the family-set predicate
 * were previously inlined on `SchegentWorkflowController` (027 FR-009..011).
 *
 * Semantics — preserved byte-for-byte:
 *   - Transient errors return `TRANSIENT_BACKOFF_MS`.
 *   - Rate-limit errors with a parseable `resetsAtMs` return
 *     `Math.max(RETRY_FLOOR_MS, (resetsAtMs - now) + RETRY_BUFFER_MS)`.
 *   - Rate-limit errors with a null/undefined/non-finite `resetsAtMs`
 *     return the fixed `RATE_LIMIT_BACKOFF_MS` fallback.
 *
 * Feature 066 — `out-of-credits` past-timestamp guard. When the original
 * cause is `out-of-credits` (hard-cap quota; resetsAt is the previous
 * rolling reset, not a future recovery), a past `resetsAtMs` falls back
 * to the 60-minute `RATE_LIMIT_BACKOFF_MS` instead of clamping to the
 * 1-minute `RETRY_FLOOR_MS`. All other rate-limit-family causes are
 * unchanged. See specs/066-stdout-credit-detect/.
 *
 * CLAUDE.md hard rule preservation: the dynamic path trusts the parsed
 * `resetsAtMs` regardless of distance from now for every cause EXCEPT
 * `out-of-credits`; the `DELAYED_RETRY_CAP` (owned by the controller)
 * bounds total attempts. The fixed 60-minute fallback applies when the
 * parser returned no parseable reset, OR when the original cause is
 * `out-of-credits` and the parsed reset is in the past.
 */

import type { DelayedRetryCause } from '../state/workflow-run';
import {
  RATE_LIMIT_BACKOFF_MS,
  RETRY_BUFFER_MS,
  RETRY_FLOOR_MS,
  TRANSIENT_BACKOFF_MS
} from './retry-constants';

/**
 * Rate-limit family — every label that maps to the `rate_limit`
 * `DelayedRetryCause` so they share the dynamic-backoff path. Operator-
 * facing cause strings vary across CLI versions and quota families.
 *
 * Feature 066 — `out-of-credits` joins the family so the detector's new
 * hard-cap cause routes through `toDelayedRetryCause('out-of-credits')
 * === 'rate_limit'` and reaches the past-timestamp safety guard in
 * `backoffForCause`.
 */
export const RATE_LIMIT_FAMILY: ReadonlySet<string> = new Set([
  'rate_limit',
  'rate-limit',
  'out-of-usage',
  'credits-exhausted',
  'quota-exceeded',
  'out-of-credits'
]);

/** Feature 066 — sentinel cause string for the past-timestamp guard. */
const OUT_OF_CREDITS_CAUSE = 'out-of-credits';

export function toDelayedRetryCause(cause?: string): DelayedRetryCause | null {
  if (cause === 'transient_error') return cause;
  if (cause !== undefined && RATE_LIMIT_FAMILY.has(cause)) {
    return 'rate_limit';
  }
  return null;
}

export interface BackoffClock {
  now(): number;
}

const systemClock: BackoffClock = { now: () => Date.now() };

/**
 * Compute the delayed-retry backoff in milliseconds for the given cause.
 *
 * @param cause         Normalized retry cause (`'rate_limit'` or `'transient_error'`).
 * @param resetsAtMs    Parsed epoch when the quota resets, or null/undefined
 *                      when the parser found no value. Non-finite values
 *                      are treated as null (defensive against CLI drift).
 * @param clock         Injectable clock (default: system Date.now). Tests
 *                      can substitute a frozen clock for deterministic
 *                      pre-buffer calculation.
 * @param originalCause Optional. The pre-normalization cause string. When
 *                      `'out-of-credits'` AND the parsed `resetsAtMs` is
 *                      in the past, the function falls back to
 *                      `RATE_LIMIT_BACKOFF_MS` instead of clamping to
 *                      `RETRY_FLOOR_MS` (Feature 066, FR-010). Omitted
 *                      callers observe pre-066 behavior byte-for-byte.
 */
export function backoffForCause(
  cause: DelayedRetryCause,
  resetsAtMs?: number | null,
  clock: BackoffClock = systemClock,
  originalCause?: string
): number {
  if (cause !== 'rate_limit') return TRANSIENT_BACKOFF_MS;
  if (resetsAtMs === null || resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) {
    return RATE_LIMIT_BACKOFF_MS;
  }
  // Feature 066 — past-timestamp guard for hard-cap quotas. The API's
  // `resetsAt` for an out-of-credits account is the LAST rolling reset
  // (already in the past), not a future recovery; the dynamic path
  // would clamp to RETRY_FLOOR_MS and produce a 1-minute retry loop.
  if (originalCause === OUT_OF_CREDITS_CAUSE && resetsAtMs <= clock.now()) {
    return RATE_LIMIT_BACKOFF_MS;
  }
  const dynamicWait = resetsAtMs - clock.now() + RETRY_BUFFER_MS;
  return Math.max(RETRY_FLOOR_MS, dynamicWait);
}
