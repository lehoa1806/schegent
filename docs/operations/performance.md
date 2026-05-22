# Performance & Retention

A consolidated reference for Schegent's performance budgets, retention defaults, and observable knobs. Cross-referenced from [README.md](../../README.md), [handle-rate-limits.md](handle-rate-limits.md), and [inspect-audit-logs.md](inspect-audit-logs.md).

## CLI startup cost (per phase)

Every phase invocation spawns a fresh Claude CLI subprocess. There is no warm pool. Startup is measured by the time between `monitor-invocation-started` and the first `monitor-stdout-line`.

| Phase | Approximate startup | Notes |
|---|---|---|
| `claude -p /status` (watchdog poll) | ~1–3 s | No prompt processing — cheapest invocation. |
| Per-phase prompt | ~3–8 s | Dominated by CLI startup; prompt size is secondary. |
| Per-phase total wall time | varies widely | Dependent on phase complexity, file scan cost, model tier. |

Tune `schegent.invocation.timeoutSeconds` (default 5400) if your phase invocations regularly go idle near the threshold. The timer resets on every CLI output chunk, so a long phase that streams progress will not trip; the cap fires only after that many seconds of silence. A timeout is logged as `monitor-invocation-summary` with `outcome: failure`.

## State projection budget

The state projector debounces at ~100 ms and skips re-projection if the snapshot payload is identical to the previous one. Render budgets (verified in `tests/perf/render-budget.test.ts`):

| Metric | Budget |
|---|---|
| Median project() pass with 50-item queue | ≤ 16 ms |
| Total time for 100 project() passes | < 1.6 s |
| Snapshot serialization (queue + history + monitor + tail) | < 32 KB typical |

If you are seeing UI lag with a much larger queue (>100 items), file an issue — the projector is allocation-conscious but the budget targets sub-100 ms snapshots, not arbitrarily large state.

## Subprocess output cap

Each invocation captures stdout and stderr up to `MAX_BUFFER_BYTES` (4 MiB per stream). Beyond that, additional bytes are silently truncated. The subprocess continues running; the runner does not abort because the cap was reached. This protects the host from memory-pressure attacks via prompt-controlled stdout.

If you need a larger buffer, edit `MAX_BUFFER_BYTES` in [src/runner/claude-cli.ts](../../src/runner/claude-cli.ts) and re-run the runner test suite.

## Audit log rotation

| Setting | Default | What it does |
|---|---|---|
| `schegent.audit.rotation.sizeMB` | 5 | Rotate when active log exceeds size. |
| `schegent.audit.rotation.maxAgeDays` | 30 | Rotate when active log exceeds age. |

Rotation creates `.schegent/audit.log.<YYYYMMDD-HHMMSS>` and resumes appending to a fresh `.schegent/audit.log`. Whichever threshold trips first wins.

## Runtime log rotation

| Setting | Default | What it does |
|---|---|---|
| `schegent.logging.runtimeLogMaxBytes` | `5_242_880` (5 MiB) | Active-file size threshold. The sink rotates when `bytesOnDisk + line.length >= maxBytes`. |
| `schegent.logging.runtimeLogMaxGenerations` | `3` (range 0–10) | Number of rotated files (`<path>.1` … `<path>.<maxGens>`) kept on disk. `0` disables rotation (truncate-in-place). Worst-case disk usage ≈ `(maxGens + 1) × maxBytes`. |

Rotation walks `<path> → <path>.1 → <path>.2 → … → <path>.<maxGens>` and drops files beyond `<path>.<maxGens>`. Both settings are read on every emit (no caching), so a mid-run change takes effect at the next log line. See [runtime-log.md](runtime-log.md) for the full operator workflow.

## Audit archive retention

| Setting (compile-time) | Default | What it does |
|---|---|---|
| `retentionMaxArchives` | 10 | Keep up to N most recent rotated archives. |
| `retentionMaxArchiveAgeMs` | 90 days | Drop archives older than this. |

Both budgets apply: an archive must be in the most-recent N **and** within the age budget. Pruning runs immediately after every rotation. Failures are logged and swallowed; pruning never blocks the write chain.

## Watchdog polling

| Setting | Default | What it does |
|---|---|---|
| `schegent.watchdog.pollIntervalMinutes` | 30 | How often to poll `claude -p /status` while paused. |
| `schegent.watchdog.enabled` | `true` | Disable to require manual resume. |

The interval is observable: a configuration change emits a log line of the form `watchdog: pollIntervalMs <prev> → <next> (source=config-change)`. The next scheduled poll respects the new interval.

See [handle-rate-limits.md](handle-rate-limits.md) for how the watchdog interacts with rate-limit detection.

## Schema versions

| Constant | Value | Bump when |
|---|---|---|
| `AUDIT_SCHEMA_VERSION` | 1 | The persisted shape of audit entries changes. |
| `STATE_SCHEMA_VERSION` | 1 | The persisted shape of workspace state changes. |

Both are monotonic integers. The audit parser warns and preserves entries with a higher `schemaVersion`. The state store rejects state with a higher `schemaVersion` than the runtime supports.

## Where to look next

- [handle-rate-limits.md](handle-rate-limits.md) — full rate-limit operator workflow.
- [inspect-audit-logs.md](inspect-audit-logs.md) — audit log shape, sanitization, hydration warnings.
- [debug-stuck-runs.md](debug-stuck-runs.md) — diagnosis flow when phase progress stalls.
