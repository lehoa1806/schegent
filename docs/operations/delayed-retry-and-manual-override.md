# Delayed Retry & "Retry Phase Now"

Schegent applies **delayed retries** to recoverable CLI failures. When a
phase invocation finishes with a non-zero exit code that is **not** a
fatal-signature match, the controller classifies the cause as
`rate_limit` (60-min backoff) or `transient_error` (15-min backoff) and
arms the watchdog timer. After 5 consecutive delayed retries on the same
run, the queue pauses with reason `retry-cap-exhausted:<runId>` and
waits for operator input.

This runbook is feature-011 territory. For a refresher on the canonical
classifier the parser uses, see
[handle-rate-limits.md](handle-rate-limits.md) and
[fail-fast-on-fatal-cli-errors.md](fail-fast-on-fatal-cli-errors.md).

## State machine

```
                 ┌──────────────────────────────────────────────┐
                 │                                              │
                 │           clean / issues_remain              │
                 │                  ▼                           │
   running ───► PhaseRunner ──► invocation result ──► outcome ──► advance
                                                  │
                                                  │ transient_error / rate_limit
                                                  ▼
                                       delayedRetryCount < CAP?
                                                  │ yes
                                                  ▼
                              schedule pauseAndPoll(cause, override)
                                                  │
                                                  ▼
                              pendingRetryAt = Date.now() + backoff
                              pendingRetryCause = cause
                              audit: retry-scheduled
                                                  │
                                                  ▼
                                  (15 or 60 min later)
                                                  ▼
                                       resume; re-invoke phase
                                                  │
                                  ┌───────────────┴───────────────┐
                                  ▼                               ▼
                              clean exit                    transient again
                                  │                               │
                                  ▼                               ▼
                  reset delayedRetryCount = 0          increment, loop above
                  audit: retry-recovered

                                  delayedRetryCount === CAP?
                                                  │ yes
                                                  ▼
                                scheduleQueuePauseAndFail(run, cause)
                                                  │
                                                  ▼
                                  queue.setPaused(true, "retry-cap-exhausted:<runId>")
                                  run.status = "paused"
                                  audit: queue-paused
```

## Configuration

The constants are compile-time per
[spec.md](../../../specs/011-webui-config-editor/spec.md) Assumptions and
live in [src/controller/retry-constants.ts](../../src/controller/retry-constants.ts):

| Constant | Value | Purpose |
|---|---|---|
| `TRANSIENT_BACKOFF_MS` | 15 min | Backoff between retries when cause is `transient_error`. |
| `RATE_LIMIT_BACKOFF_MS` | 60 min | Fallback backoff when cause is `rate_limit` and the CLI did not surface a parseable reset epoch. |
| `RETRY_BUFFER_MS` | 60 s | Feature 027 — wait-buffer added to the parsed reset epoch before re-arming the retry. |
| `RETRY_FLOOR_MS` | 60 s | Feature 027 — minimum forward wait when the parsed reset epoch is at-or-before `Date.now()`. |
| `DELAYED_RETRY_CAP` | 5 | Number of retries before queue pauses. |

### Feature 027 — dynamic quota reset countdown

When the cause is `rate_limit` AND the Claude CLI's stdout carried a
parseable reset epoch (either the stream-json
`rate_limit_event.resetsAt` field or the plain-text middle-dot
`· resets <time> (<tz>)` pattern), the controller schedules the retry
at `resetsAtMs + RETRY_BUFFER_MS` (clamped by `RETRY_FLOOR_MS` when the
epoch is already in the past). The fixed 60-minute `RATE_LIMIT_BACKOFF_MS`
is the fallback when no reset is parseable. The pre-buffer `resetsAtMs`
is logged in every `retry-scheduled` audit payload (a finite number for
the dynamic path; `null` for the fallback path) so the retry is fully
reproducible from logs alone — derive the actual scheduled retry as
`resetsAtMs + 60_000`.

A future iteration may promote these constants to workspace settings;
today they are deliberately immutable so emergency operator action is
not required.

## New audit events

Feature 011 adds four events to the existing audit pipeline. All four
flow through the **single sanitization point** in `audit-log-writer.ts`
and inherit existing redaction. Tail the log via:

```bash
tail -f .schegent/audit.log | grep -E 'retry-scheduled|retry-manual|retry-recovered|queue-paused'
```

### `retry-scheduled`

Emitted when the controller arms a delayed-retry timer.

```jsonc
{
  "eventType": "retry-scheduled",
  "outcome": "pending",
  "runId": "<runId>",
  "phaseId": "implement",
  "payload": {
    "cause": "transient_error",          // or "rate_limit"
    "delayedRetryCount": 1,              // post-increment, so first delay → 1
    "pendingRetryAt": 1736629200000,     // epoch ms when next attempt fires
    "backoffMs": 900000,                 // 15min for transient, dynamic or 60min for rate_limit
    "resetsAtMs": 1736629140000          // Feature 027 — pre-buffer parsed reset epoch
                                         //   (number for dynamic path, null for fallback,
                                         //   null when cause is transient_error). Derive
                                         //   actual retry as resetsAtMs + 60_000.
  }
}
```

### `retry-recovered`

Emitted on the first clean success after at least one delayed retry. The
`delayedRetryCount` field on the run is reset to 0 in the same tick.

```jsonc
{
  "eventType": "retry-recovered",
  "outcome": "success",
  "runId": "<runId>",
  "phaseId": "implement",
  "payload": {
    "priorDelayedRetryCount": 3   // value before the reset
  }
}
```

### `retry-manual`

Emitted when the operator invokes **Schegent: Retry Phase Now**
(`schegent.retryPhaseNow`) via the command palette or the sidebar
affordance.

```jsonc
{
  "eventType": "retry-manual",
  "outcome": "pending",
  "runId": "<runId>",
  "phaseId": "implement",
  "payload": {
    "priorDelayedRetryCount": 4,
    "priorPendingRetryCause": "transient_error"
  }
}
```

### `queue-paused`

Emitted when the retry cap is exhausted and the queue transitions to
paused.

```jsonc
{
  "eventType": "queue-paused",
  "outcome": "failure",
  "runId": "<runId>",
  "payload": {
    "reason": "retry-cap-exhausted:<runId>",
    "cause": "transient_error",           // or "rate_limit"
    "delayedRetryCount": 5
  }
}
```

## The "Retry Phase Now" command

When the run is in `pendingRetryAt !== null` state, operators see a
**Retry Phase Now** button in the sidebar phase tile alongside a
countdown ("Pending retry in M:SS"). The same action is available via
the command palette: **Schegent: Retry Phase Now**
(`schegent.retryPhaseNow`).

The command:

1. Verifies an active run exists and is in `pendingRetryAt !== null`
   state. Else returns `rejected:no-active-run` or
   `rejected:not-pending-retry`.
2. Calls `watchdog.cancelPendingTimer()` to release the in-memory
   `setTimeout` handle.
3. Resets `run.delayedRetryCount = 0`, clears `pendingRetryAt` and
   `pendingRetryCause`.
4. If the queue was paused with reason `retry-cap-exhausted:<thisRunId>`,
   unpauses it. Unrelated queue pauses are **not** touched.
5. Emits the `retry-manual` audit event above.
6. Re-arms `resumeExisting()` on the next tick (via `setImmediate`) so
   the phase re-runs within ~1 second (SC-003).

The command is **primary-only** — secondary VS Code windows on the same
workspace see the button as read-only / disabled. The IPC handler
rejects mutating commands from non-primary hosts with reason
`secondary-window-readonly`.

## Restart resilience (SC-012)

`pendingRetryAt` and `pendingRetryCause` are persisted to
`workspaceState`. On extension activation
([src/extension.ts](../../src/extension.ts) `activate()`),
`WorkflowController.resumeExistingFromActivation()` runs:

- If `pendingRetryAt !== null` and `Date.now() >= pendingRetryAt`,
  resume on the next tick.
- If still in the future, re-arm the watchdog with
  `durationOverrideMs = pendingRetryAt - Date.now()`.

This means a 30-minute backoff that crosses a VS Code restart resumes
at exactly the deadline, not 30 minutes from the restart time.

The state-store invariant
`pendingRetryAt === null XOR pendingRetryCause === null` is enforced on
`setRun()`; any persistence write that splits the pair is rejected and
the in-flight transition rolls back.

## Tips for triage

| Symptom | What to check | Action |
|---|---|---|
| Queue paused after 5 retries | `audit-log` `queue-paused` payload | If cause is `rate_limit`, wait for credits. If `transient_error`, inspect verbose diagnostics (T10) for the underlying CLI failure. |
| Retry Phase Now button does nothing | Sidebar shows `Pending retry in M:SS`? | If no countdown, the run is not in pending-retry state; the button is hidden by design (FR-008). |
| Retry runs but fails identically | The underlying CLI failure is deterministic | Open Settings → Fatal Signatures and consider adding an operator-defined signature so the next failure short-circuits delayed retry. |
| Timer didn't survive restart | `pendingRetryAt` persisted? | Run `grep retry-scheduled .schegent/audit.log` to confirm the persistence write completed. Re-armed timer is logged on activation. |
| Want to skip backoff immediately | Operator decision (no quota concern) | Use **Retry Phase Now** — resets the counter to 0 (clean slate, not "use the 5th retry"). |

## Where to look next

- [handle-rate-limits.md](handle-rate-limits.md) — credit-watchdog
  behavior shared with the delayed-retry path.
- [fail-fast-on-fatal-cli-errors.md](fail-fast-on-fatal-cli-errors.md) —
  why some non-zero exits skip the delayed-retry loop entirely.
- [recover-after-restart.md](recover-after-restart.md) — broader
  restart-resilience contract.
- [inspect-audit-logs.md](inspect-audit-logs.md) — interpret
  `retry-scheduled` / `retry-manual` / `retry-recovered` / `queue-paused`
  alongside the rest of the event vocabulary.
