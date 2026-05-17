/**
 * Feature 011 — delayed-retry backoff constants.
 *
 * Compile-time per the spec's Assumptions (Phase 1). Future iterations may
 * promote these to `schegent.*` workspace settings. Until then, the values
 * are sourced exclusively from this module so that every retry-related
 * decision (controller, watchdog override, audit payload) reads the same
 * authoritative numbers.
 */

/** 15 minutes — backoff after a transient (non-fatal, non-rate-limited) error. */
export const TRANSIENT_BACKOFF_MS = 15 * 60 * 1000;

/** 60 minutes — backoff after a rate-limit match. */
export const RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Maximum delayed-retry attempts per run.
 *
 * Off-by-one semantics (see contracts/delayed-retry.md):
 *   - Failures 1..(DELAYED_RETRY_CAP - 1) schedule a delayed retry and
 *     increment `delayedRetryCount` to 1..4.
 *   - The DELAYED_RETRY_CAP-th failure (the 5th) sets `delayedRetryCount`
 *     to DELAYED_RETRY_CAP (5), transitions the run to `paused`, and pauses
 *     the queue with reason `retry-cap-exhausted:<runId>`.
 */
export const DELAYED_RETRY_CAP = 5;

/**
 * Feature 027 — Dynamic Quota Reset Countdown.
 *
 * `RETRY_BUFFER_MS` is added to a parsed `resetsAtMs` to compute the
 * dynamic delayed-retry deadline; `RETRY_FLOOR_MS` is the minimum
 * effective backoff when the parsed reset is in the past or imminent.
 *
 * The two are intentionally equal in v1 — see data-model.md Entity 6.
 * They are named separately so future iterations can tune them apart.
 */
export const RETRY_BUFFER_MS = 60 * 1000;
export const RETRY_FLOOR_MS = 60 * 1000;
