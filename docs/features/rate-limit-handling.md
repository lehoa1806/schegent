# Rate-Limit Handling

When the Claude CLI hits Anthropic's rate limits, the host classifies the failure as `rate_limit` and schedules a **delayed retry** rather than failing immediately. This page explains how the host detects rate limits, how it schedules the retry, and what you can do as an operator.

## How rate limits are detected

The host's monitor scans the CLI's stdout and stderr for known rate-limit indicators. The indicators are pattern-based and include the standard Anthropic responses (e.g., `429 rate_limit_exceeded`, "you have exceeded your rate limit").

When the indicator fires, the monitor emits `monitor-rate-limited` with a `cause` discriminator and the phase classification path treats the failure as `rate_limit` rather than `transient_error`.

## The delayed-retry schedule

Two scheduling modes exist:

### Dynamic backoff (when the indicator includes a reset time)

If the CLI emits a parseable reset time (an ISO-8601 timestamp or epoch milliseconds), the host computes:

```text
delay = max(RETRY_FLOOR_MS, (resetsAtMs - Date.now()) + RETRY_BUFFER_MS)
```

- `RETRY_FLOOR_MS` is a small floor (a minimum delay) so the retry is not scheduled in the past.
- `RETRY_BUFFER_MS` is added on top so the retry fires *after* the rate-limit window resets, with margin.
- The host trusts `resetsAtMs` regardless of how far in the future it is. The `DELAYED_RETRY_CAP` (5 by default) bounds total attempts, not the per-attempt delay.

The pre-buffer `resetsAtMs` (not `resetsAtMs + RETRY_BUFFER_MS`) is recorded in the `retry-scheduled` audit payload so the retry time is derivable from logs alone.

### Fixed-60-minute fallback (when no parseable reset)

If the indicator does not include a reset time the host can parse, the host falls back to a fixed 60-minute delay. The CLI's rate-limit window is rolling, so this is the safest conservative choice.

## The retry cap

`schegent.retry.maxAttempts` (default `5`, range `1`–`5`) is the **maximum number of consecutive delayed retries** for a run before the queue is paused. Both `rate_limit` and `transient_error` failures count against this cap.

When the cap is reached:

1. The run is paused.
2. The queue is paused with `pauseSource: 'cascade'`.
3. The audit log records `queue-paused` with the cascade source.

The operator must resume manually. A successful recovery between cap hits resets the counter (see `retry-recovered` below).

## Audit-log surface

Four events trace the delayed-retry lifecycle:

### `retry-scheduled`

The host has classified a failure as transient or rate-limit and scheduled a retry. Payload:

- `pipelineId`, `phaseId`, `runId`
- `cause` — `'rate_limit'` | `'transient_error'`
- `attemptN` — the cumulative consecutive delayed-retry count, 1-indexed.
- `delayMs` — the computed delay.
- `resetsAtMs` — the parsed reset time (pre-buffer). Omitted when no parseable reset was available.

### `retry-manual`

The operator hit **Retry Active Run** while a delayed retry was scheduled. The scheduled timer is canceled; the manual retry runs immediately with `--continue`.

### `retry-recovered`

A previously-failing phase recovered (clean exit on the retry). The cumulative count resets to 0. The run continues normally.

### `queue-paused` (with `pauseSource: 'cascade'`)

The cap was exhausted. The run and queue are paused. The operator must intervene.

## What happens during the delay

While the delay timer is pending:

- The workspace lock is **retained** (paused runs hold the lock).
- The in-flight subprocess is killed (the rate-limit response terminated it).
- The sidebar shows the task in a "Waiting for retry" state, with the countdown to the scheduled retry.
- The audit log records the retry time.

You can:

- **Wait** for the timer to fire. The retry runs with `--continue` for context preservation.
- **Click Retry Active Run** to bypass the timer. The retry runs immediately. (If the rate-limit window has not yet expired, this likely fails again.)
- **Cancel** the run if you do not want to retry.

## The `--continue` flag

When a delayed retry fires (timer or manual), the host dispatches with `nextDispatchIsContinue = true`. The runner appends `-c` to the spawned argv so the CLI resumes its prior context.

This is critical for the implement phase: re-spawning the CLI without `--continue` would start the phase fresh, losing all the in-progress state.

See [Context-Preserving Retries](context-preserving-retries.md) for the full dispatch matrix.

## What you can do as an operator

### Wait it out

The most common case. The schedule is correct; the timer fires; the retry succeeds.

### Pre-emptively reduce demand

If you regularly hit rate limits, consider:

- Lowering the model used by long phases (`schegent.phases[speckit-implement].model: claude-sonnet-4-6`).
- Pausing the queue during peak hours (`schegent.pauseQueue` until the rate-limit window resets).

### React to a cascade pause

When you see `queue-paused` with `pauseSource: 'cascade'` in the audit log:

1. Read the `retry-scheduled` events leading up to the pause. Were they all rate-limit, or mixed with transient errors?
2. If rate-limit only: wait until the next rate-limit reset (often near a clock boundary), then `schegent.resumeQueue`.
3. If transient errors: investigate the root cause — the CLI may be misconfigured, the workspace may be in a bad state.
4. The `schegent.retryActiveRun` command resumes the in-flight phase immediately when ready.

### Inspect the timer state

The sidebar shows the next retry time for the in-flight delayed retry. The audit log has the structured record. There is no live "decrement-by-second" countdown — the host wakes the timer at the scheduled time and runs the retry; the UI shows a rough remaining estimate based on the same `resetsAtMs`.

## What gets reset

A `retry-recovered` event resets:

- The cumulative consecutive-retry counter (`delayedRetryCount`).
- Any `pendingRetryAt` / `pendingRetryCause` on the persisted `WorkflowRun`.

The state invariant is: `pendingRetryAt` and `pendingRetryCause` are both-null or both-non-null. The state store rejects mismatched values.

A new failure after a recovery starts the counter fresh at 1.

## Limits

- **No exponential backoff for transient errors.** Transient errors get a fixed 15-minute backoff (the precise floor is implementation-defined and may evolve). Rate limits get the dynamic or fallback 60-minute schedule.
- **No per-phase override of the cap.** `schegent.retry.maxAttempts` applies to the whole run, all phases.
- **The cap is per-run.** Each new run starts the counter at 0.

The next feature is [Context-Preserving Retries](context-preserving-retries.md).
