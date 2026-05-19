# Inspect & Configure the Runtime Debug Log

The runtime debug log is an operator-configurable sanitized text sink
that captures the same redacted log lines that flow through Schegent's
sidebar OUTPUT channel and the structured audit pipeline, but writes
them to a single human-readable file on disk so operators can `tail -F`
a long-running session without watching the IDE.

It is **not** the audit log. The structured `.schegent/audit.log`
remains the canonical, schema-versioned, exfil-safe record of every
phase boundary and decision. The runtime log is a free-form diagnostic
tail for ad-hoc troubleshooting.

## File layout

| Path | Purpose |
|---|---|
| `<workspaceRoot>/.schegent/syslog` | Default runtime log file (created on first emit). |
| `<operator-configured path>` | Override via Settings → "Runtime Log File Path". Accepts an absolute path or a workspace-relative path. |

The file is append-only with **size-based rotation** (feature 056): when
the active file's size plus the next line's bytes meets or exceeds
`schegent.logging.runtimeLogMaxBytes` (default `5_242_880` / 5 MiB), the
sink rotates `<path> → <path>.1 → <path>.2 → … → <path>.<maxGens>` and
truncates the active file. Files beyond `<path>.<maxGens>` are dropped.
There is no machine parser; the format is human-readable text only.
Adding `.schegent/syslog*` to `.gitignore` (or your `.schegent/`
umbrella ignore) is recommended.

## Settings surface

Both controls live in the Schegent sidebar under **Settings → General**:

| Setting | Workspace key | Default | Notes |
|---|---|---|---|
| Runtime Log Level | `schegent.logging.runtimeLogLevel` | `INFO` | One of `DEBUG`, `INFO`, `WARN`, `ERROR`. Filters output to the configured severity or higher. |
| Runtime Log File Path | `schegent.logging.runtimeLogFilePath` | empty (resolves to `<workspaceRoot>/.schegent/syslog`) | Absolute path or workspace-relative. Relative paths containing `..` are rejected by the host validator. |
| Runtime Log Max Bytes | `schegent.logging.runtimeLogMaxBytes` | `5_242_880` (5 MiB) | Active-file size threshold that triggers a rotation. The check is `bytesOnDisk + line.length >= maxBytes`. |
| Runtime Log Max Generations | `schegent.logging.runtimeLogMaxGenerations` | `3` (range 0–10) | Number of rotated files (`<path>.1` … `<path>.<maxGens>`) kept on disk. `0` disables rotation: the active file is truncated in place. Worst-case disk usage ≈ `(maxGens + 1) × maxBytes`. |

Both settings are read on **every** log emission (never cached on the
runner). A change made mid-run takes effect at the next emission — no
reload, no restart.

## Quick inspection commands

Tail the live log in another terminal:

```bash
tail -F .schegent/syslog
```

Filter for ERRORs only:

```bash
grep ' ERROR ' .schegent/syslog
```

Truncate the file (preserves the inode — running processes keep
appending after the truncate, no need to restart):

```bash
: > .schegent/syslog
```

## Line shape

Every line is the same string that `SanitizedLogger` writes to the
OUTPUT channel:

```
[2026-05-13T17:24:33.421Z] INFO  workflow-controller: phase plan started
[2026-05-13T17:24:34.110Z] WARN  audit: rotation skipped — active size below threshold
[2026-05-13T17:24:34.205Z] ERROR runner: subprocess exited with code 1
```

The leading bracketed timestamp is ISO-8601 in UTC. The next token is
the severity (`DEBUG | INFO | WARN | ERROR`). Everything after the
severity is the sanitized message body.

## Redaction guarantees

Lines are **redacted before write**. The runtime log reuses
`SanitizedLogger`'s `SECRET_PATTERNS` set (the same source-of-truth
that gates the OUTPUT channel and audit-log writer). Secrets like
API tokens, Bearer headers, and JWTs are replaced with `***redacted***`
before any line touches disk. The sink never forks the redaction set —
extending `SECRET_PATTERNS` in `src/lib/logger.ts` automatically
extends every sink in the codebase.

If you discover a redaction gap, please file an issue rather than
working around it locally.

## Severity ladder

```
DEBUG  ↓ verbose; per-emit hot path, expect thousands of lines per run
INFO   ↓ default; lifecycle events, save acks, queue transitions
WARN   ↓ recoverable failures, rotation skips, retry-once recoveries
ERROR  ↓ fail-fast classifications, fatal-signature matches, suppressions
```

The filter is **floor-inclusive**: setting the level to `WARN` emits
WARN and ERROR; setting it to `DEBUG` emits everything.

## Failure handling and suppression

If a write fails (e.g. `EACCES` on a path the operator can't reach,
`EROFS` on a read-only filesystem, or `ENOENT` on the parent directory
after a one-shot `mkdir` retry already failed), the sink:

1. Emits **one** WARN through the fallback OUTPUT-channel logger
   describing the failure cause (`ENOENT-parent`, `EACCES`, `EROFS`,
   or `unknown`).
2. Records the `(path, cause)` pair in an in-memory suppression set.
3. **Silently drops** every subsequent emission targeted at that
   path until either:
   - the operator saves a new value for `schegent.logging.runtimeLogLevel`
     or `schegent.logging.runtimeLogFilePath` (the post-save callback
     in `writeGeneralSettings` clears the suppression set), or
   - the extension is reloaded.

This means the sink will **not** spam your OUTPUT channel with a
repeated WARN once it knows the destination is broken. To recover
without reloading, fix the underlying issue (chmod, free disk,
correct the path) and then re-save the runtime-log settings — even
re-saving the same value triggers the suppression clear.

## Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No file at `.schegent/syslog` after enabling | No log lines have hit the configured floor yet — try setting the level to `DEBUG` and triggering a phase. | Run any pipeline; the file is created on the first matching emit. |
| WARN in OUTPUT channel: `runtime-log-sink: append failed for path (EACCES); suppressing until settings change.` | The host process cannot write to the configured path. | `chmod` the parent directory or pick a writable path, then re-save the Runtime Log File Path setting. |
| WARN in OUTPUT channel: `runtime-log-sink: append failed for path (ENOENT-parent); …` | Parent directory could not be created (e.g. operator-typoed an unreachable path). | Verify the path is reachable, then re-save the setting. |
| Path setting rejected by the Settings UI with `relative-traversal: ..` | Workspace-relative paths containing `..` are rejected at validator time to prevent escape from the workspace root. | Use an absolute path or a relative path that stays inside the workspace. |
| File is growing unbounded despite rotation | `runtimeLogMaxBytes` set very high, or `runtimeLogMaxGenerations: 0` (rotation disabled, truncate-in-place). | Lower the threshold or raise generations in Settings → General → Runtime Log Max Bytes / Max Generations. To force an immediate truncate without restart: `: > .schegent/syslog`. |

## Operator workflow: short-lived diagnostic capture

1. Open Schegent → Settings → General.
2. Set Runtime Log Level to `DEBUG`. Save.
3. Set Runtime Log File Path to e.g. `.schegent/syslog-debug-20260513.log`. Save.
4. In a terminal: `tail -F .schegent/syslog-debug-20260513.log`.
5. Trigger the failing run.
6. When done: revert the level to `INFO` and clear the path (empty string restores the default).
7. Move the captured file out of the workspace if you want to keep it
   around — `.schegent/` is gitignored by default.

## Related

- [docs/security/threat-model.md](../security/threat-model.md) T19 —
  threat surface and trust-boundary rationale.
- [docs/operations/inspect-audit-logs.md](inspect-audit-logs.md) — the
  structured, schema-versioned counterpart used for cross-run analysis.
- [docs/operations/inspect-raw-transcripts.md](inspect-raw-transcripts.md) —
  the developer-debug **unredacted** transcript writer; do NOT confuse
  with the runtime log.
