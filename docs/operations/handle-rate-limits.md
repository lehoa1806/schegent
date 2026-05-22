# Handle Rate Limits

The Claude CLI returns rate-limit signals when a credit budget is exhausted. Schegent's **credit watchdog** detects these signals, pauses the run with a recorded reason, polls the CLI on a configurable interval, and auto-resumes from the exact paused phase.

## How detection works

The CLI runner emits a `monitor-rate-limited` audit event when stdout matches one of the documented rate-limit patterns. The workflow controller pauses the active run and records `pausedReason: "rate-limited"` on the queue snapshot. No further phases are attempted while paused.

## Configuration

| Setting | Default | What it does |
|---|---|---|
| `schegent.watchdog.pollIntervalMinutes` | `30` | How often to poll `claude -p /status` while paused. |
| `schegent.watchdog.enabled` | `true` | Disable to require manual resume. |
| `schegent.invocation.timeoutSeconds` | `5400` | Per-phase idle timeout that aborts a stalled invocation (resets on each output chunk). |

Polling is observable: every poll emits a `watchdog-poll` audit event. Configuration changes also emit `watchdog-config-changed` so changes are auditable.

## Auto-resume

When `claude -p /status` reports credits available, the watchdog:

1. Emits `watchdog-credits-available`.
2. Calls `WorkflowController.resume()` with the previously recorded phase.
3. The phase runner re-spawns the CLI from that phase onwards.

You'll see the run transition out of paused state in the sidebar without operator intervention.

## Manual resume

If you've added credits or want to retry early:

- **Schegent: Resume Paused or Failed Workflow** (`schegent.resume`) resumes from the paused phase.
- **Schegent: Retry Active Run** (`schegent.retryActiveRun`) re-runs the phase from scratch (use this if the previous stdout was discarded).

## Tuning the poll interval

Lower intervals catch credit returns faster but make more CLI calls. Higher intervals are gentler on the CLI process. The default of 30 minutes works for typical Anthropic credit refresh cadence; tune to your provider.

```jsonc
// .vscode/settings.json
{
  "schegent.watchdog.pollIntervalMinutes": 10
}
```

The change is observed by the watchdog within one tick of its current interval. The new interval is logged.

## Expected CLI startup cost

Each poll spawns `claude -p /status`. CLI startup typically dominates poll cost:

| Phase | Approximate startup |
|---|---|
| `claude -p /status` (cheap) | ~1–3 s on a warm cache |
| Per-phase invocation | ~3–8 s before first stdout |

Phase invocation cost dominates total run time. The watchdog only adds the cheap poll cost while paused.

## When the watchdog can't help

| Symptom | Action |
|---|---|
| Status command itself rate-limits | Increase the poll interval. |
| Run paused with `pausedReason: stalled` (not `rate-limited`) | Read [debug-stuck-runs.md](debug-stuck-runs.md). |
| Credits restored but run does not resume | Disable and re-enable the watchdog setting; if still stuck, reset. |

## Relationship to delayed retry (feature 011)

The credit-watchdog covers **CLI-pattern-matched rate-limit signals**
(stdout phrases that the parser recognizes). Feature 011 added a
**delayed-retry** pathway that handles the broader case: any
unmatched non-zero exit gets classified as `transient_error` (15-min
backoff) or `rate_limit` (60-min backoff for the parser-detected
rate-limit case) and retried up to 5 times before the queue pauses
with reason `retry-cap-exhausted:<runId>`.

When the cause is `rate_limit`, both surfaces collaborate: the
watchdog provides the underlying timer plumbing while the delayed-
retry controller enforces the cap, manages `pendingRetryAt`
persistence, and emits the `retry-scheduled` / `retry-recovered` /
`queue-paused` audit events. Operators can short-circuit the wait
with **Schegent: Retry Phase Now** (`schegent.retryPhaseNow`); see
[delayed-retry-and-manual-override.md](delayed-retry-and-manual-override.md).

## Where to look next

- [delayed-retry-and-manual-override.md](delayed-retry-and-manual-override.md) — feature-011 retry cap, pendingRetryAt, Retry Phase Now.
- [debug-stuck-runs.md](debug-stuck-runs.md) — distinguish `stalled` from `rate-limited`.
- [performance.md](performance.md) — full performance & retention summary.
- [inspect-audit-logs.md](inspect-audit-logs.md) — every watchdog event is auditable.
