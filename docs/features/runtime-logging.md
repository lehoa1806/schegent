# Runtime Logging

The runtime log mirrors Schegent's VS Code Output channel to a file on disk so you can `tail`, `grep`, ship to other tools, or post-mortem after a crash. This page covers the on-disk runtime log — distinct from the structured audit log and from the operator-opt-in verbose diagnostics.

## What goes into the runtime log

The Output channel ("Schegent" in VS Code's Output panel) emits log records during normal operation:

- Lifecycle events (extension activated, deactivated).
- IPC traffic between the webview and the host (which commands fired, what they returned).
- State migrations on activation.
- Background process events (drainer, watchdog, wake-up scheduler).
- Warnings and errors from the host's day-to-day operation.

The runtime log file is a **disk mirror** of the same records, filtered by severity, rotated by size, and sanitized.

## Sanitization

The runtime log uses the **same central sanitization function** as the audit log. `SECRET_PATTERNS` is the single source of truth for redaction. A secret pattern stripped from the audit log is stripped from the runtime log.

There is no separate sanitizer for the runtime log. There is no double sanitization (only one pass; the writer assumes its input is already sanitized by the logger).

## Settings

### `schegent.logging.runtimeLogLevel`

- **Default:** `INFO`
- **Enum:** `DEBUG` | `INFO` | `WARN` | `ERROR`

Severity filter. Records at or above the configured level are appended; lower-severity records are dropped at the sink.

The setting is read on every emit (no cache). Mid-run changes apply at the next event boundary.

### `schegent.logging.runtimeLogFilePath`

- **Default:** `""` (empty)

Empty resolves to `<workspaceRoot>/.schegent/syslog`. Otherwise:

- An **absolute path** (POSIX `/var/log/schegent.log` or Windows `C:\\logs\\schegent.log`) is used as-is.
- A **workspace-relative** path is resolved against the workspace root.
- Paths containing `..` segments are **rejected** (prevents escape outside the workspace).

The parent directory is auto-created on the first write. The file is created with mode `0644` on POSIX.

### `schegent.logging.runtimeLogMaxBytes`

- **Default:** `5242880` (5 MiB)
- **Range:** `65536` (64 KiB) to `1073741824` (1 GiB)

Maximum size of the active runtime log file before rotation. On a write that would push the file past this threshold, the active file rotates to `<path>.1`; existing generations shift by one (`.1` → `.2`, etc.).

### `schegent.logging.runtimeLogMaxGenerations`

- **Default:** `3`
- **Range:** `0` to `20`

Number of rotated generations to keep (`<path>.1` through `<path>.N`). Older generations are deleted on the next rotation. A value of `0` means no rotated generations are kept (each rotation immediately deletes the previous file's content).

## File rotation

When the next write would push the active file past `runtimeLogMaxBytes`:

1. The active file is renamed to `<path>.1`.
2. Existing `<path>.1` becomes `<path>.2`, etc.
3. The oldest generation past `runtimeLogMaxGenerations` is deleted.
4. A new active file is opened.

Rotation is per-write, not on a timer. A quiet log will not rotate.

## ENOENT-retry

If the runtime log writer hits `ENOENT` (the parent directory disappeared — e.g., the operator manually deleted `.schegent/`), the writer retries once after creating the parent directory. If the retry succeeds, the write proceeds normally. If it fails, the path is added to a **suppression map**.

## Suppression map

If the writer encounters an I/O error other than the ENOENT-retry case (disk full, permission denied, write-protected), it suppresses further writes for the same path and surfaces a `SanitizedLogger.warn` line. The suppression persists until cleared.

### Clearing the suppression

The suppression map is cleared from the post-save callback when **either** of these settings is saved:

- `schegent.logging.runtimeLogLevel`
- `schegent.logging.runtimeLogFilePath`

The clear fires even when the **saved value is unchanged** — so saving the setting again is a valid recovery affordance. The operator can "Save" the same value from the sidebar settings panel after fixing the disk-full condition or the permissions, and the writer resumes.

## Per-path serialization

If multiple sources write to the same runtime log path concurrently (rare but possible — the same file path used by a second workspace, for example), the writer serializes writes to that path so two concurrent writes do not corrupt each other.

## Concurrent paths

If you change `runtimeLogFilePath` mid-run, the writer transitions to the new path on the next emit. The old file is left alone (no truncation, no rename). The old file's rotation state is forgotten — a subsequent reversion to the old path starts fresh.

## The single sink rule

The runtime log writer at `src/lib/runtime-log/runtime-log-sink.ts` is the **only** module allowed to call `fs.appendFile(...)` (or any sibling write API) against a path containing the literal `syslog`. A lint regression test pins the allowlist of `fs.appendFile` call sites in `src/`.

A parallel writer would bypass:

- The shared redaction (the sink relies on its caller already sanitizing).
- The suppression map.
- The per-path serialization.
- The ENOENT-retry.

If you ever need a second consumer of runtime log data, route it through `SanitizedLogger` and register a new `LogSink` — do not bypass the sink.

## Reading the runtime log

The runtime log is a plain text file. Open it in any editor.

If you have a long log and want to tail the latest:

```bash
tail -f .schegent/syslog
```

To filter by severity:

```bash
grep '^WARN ' .schegent/syslog
grep '^ERROR ' .schegent/syslog
```

To find records from a specific timeframe:

```bash
sed -n '/2026-05-17T12:/,/2026-05-17T13:/p' .schegent/syslog
```

## How the runtime log differs from the audit log

| Sink | Format | Sanitized? | Rotates? | Purpose |
|---|---|---|---|---|
| Audit log | JSONL (structured) | yes | yes (size+age) | Append-only structured evidence |
| Runtime log | Text (severity-prefixed lines) | yes | yes (size only) | Operator-readable mirror of the Output channel |

The audit log is for *evidence* — a queryable record of every run. The runtime log is for *diagnostics* — what the host was doing internally.

Both are local-only and sanitized through the same central function.

## How the runtime log differs from raw transcripts

The runtime log is **host-generated**. Each line was emitted by the extension's code.

The raw transcript (`.schegent/sessions/raw-<runId>.log`) is **CLI-generated**. Each line was emitted by the Claude CLI subprocess as it ran.

The runtime log is sanitized. The raw transcript is not.

You use the runtime log when you want to know what the *host* was doing. You use the raw transcript when you want to know what the *CLI* said.

## Limits

- **No JSONL.** The runtime log is plain text, not structured.
- **No remote sinks.** The log is local-file only. No syslog protocol, no HTTP push.
- **No per-emitter routing.** All host log records funnel through the same sink.
- **No backfill.** A sanitization change is not retroactively applied to lines already in the file.

The runtime log is the next thing you reach for when the audit log is not granular enough but you do not want the unredacted depth of the raw transcript.

The next feature page is [Wake-up Scheduler](wake-up-scheduler.md) — already written separately.
