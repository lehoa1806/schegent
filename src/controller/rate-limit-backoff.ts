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
 * CLAUDE.md hard rule preservation: the dynamic path trusts the parsed
 * `resetsAtMs` regardless of distance from now; the `DELAYED_RETRY_CAP`
 * (owned by the controller) bounds total attempts. The fixed 60-minute
 * fallback applies ONLY when the parser returned no parseable reset.
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
 */
export const RATE_LIMIT_FAMILY: ReadonlySet<string> = new Set([
  'rate_limit',
  'rate-limit',
  'out-of-usage',
  'credits-exhausted',
  'quota-exceeded'
]);

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
 * @param cause       Normalized retry cause (`'rate_limit'` or `'transient_error'`).
 * @param resetsAtMs  Parsed epoch when the quota resets, or null/undefined
 *                    when the parser found no value. Non-finite values
 *                    are treated as null (defensive against CLI drift).
 * @param clock       Injectable clock (default: system Date.now). Tests
 *                    can substitute a frozen clock for deterministic
 *                    pre-buffer calculation.
 */
export function backoffForCause(
  cause: DelayedRetryCause,
  resetsAtMs?: number | null,
  clock: BackoffClock = systemClock
): number {
  if (cause !== 'rate_limit') return TRANSIENT_BACKOFF_MS;
  if (resetsAtMs === null || resetsAtMs === undefined || !Number.isFinite(resetsAtMs)) {
    return RATE_LIMIT_BACKOFF_MS;
  }
  const dynamicWait = resetsAtMs - clock.now() + RETRY_BUFFER_MS;
  return Math.max(RETRY_FLOOR_MS, dynamicWait);
}
