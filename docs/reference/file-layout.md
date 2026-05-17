# File Layout

Schegent writes to two distinct locations on disk: the workspace `.schegent/` directory (per-workspace, local-only evidence) and VS Code's global storage (per-user, cross-workspace state for the wake-up scheduler).

This page maps every file Schegent creates and what it is for.

## Workspace `.schegent/` directory

Everything under `<workspaceRoot>/.schegent/` is **local-only**. It is intentionally not designed to be checked into version control; the directory's own `.gitignore` blocks itself.

```text
<workspaceRoot>/.schegent/
├── .gitignore                          # Self-gitignore (defense in depth)
├── audit.log                           # Active structured audit (sanitized)
├── audit.log.<YYYYMMDD-HHMMSS>         # Rotated audit archives
├── syslog                              # Active runtime log (sanitized)
├── syslog.1, syslog.2, syslog.3 ...    # Rotated runtime log generations
└── sessions/
    ├── raw-<runId>.log                 # Raw transcript for runId (unredacted)
    └── <runId>/
        ├── phase-message.env           # Optional inter-phase sidecar
        └── diagnostics/                # Verbose diagnostics (opt-in, unredacted)
            └── <pipelineId>/
                └── <phaseId>/
                    └── iter-<N>/
                        ├── debug.json
                        ├── stream.jsonl
                        └── verbose.log
```

### `.gitignore` (self)

A one-line file containing `*` that ensures the directory ignores itself. Defense-in-depth: a workspace-level `.gitignore` entry for `.schegent/` is still recommended (and is documented in [Installation](../getting-started/installation.md)).

### `audit.log`

The structured, sanitized, append-only record of every run. JSONL — one event per line. Every line passes through the central redaction set before it is written.

**Rotation:** automatic when either threshold is exceeded:
- File size exceeds `schegent.audit.rotation.sizeMB` (default 5 MB).
- File age exceeds `schegent.audit.rotation.maxAgeDays` (default 30 days).

**Pruning:** rotated archives are pruned per a built-in 7-day archive-age floor plus a count cap.

This is the file you read when you want to know what happened during a run. It is also the safest sink to ship off-machine, attach to bug reports, or store in shared infrastructure — see [Sessions, Logs, and Audit Evidence](../concepts/sessions-and-logs.md#the-structured-audit-log).

### `audit.log.<YYYYMMDD-HHMMSS>`

Rotated archives. Same format as the active `audit.log`. The host emits an `audit-rotated` event in the new active file each time it rotates.

### `syslog`

The active runtime debug log. Mirrors the **Schegent** Output channel to disk, sanitized by the same central function.

**Settings:**
- `schegent.logging.runtimeLogFilePath` — empty string resolves to `<workspaceRoot>/.schegent/syslog`. You can redirect to any other path.
- `schegent.logging.runtimeLogLevel` — `DEBUG` | `INFO` | `WARN` | `ERROR` filter.
- `schegent.logging.runtimeLogMaxBytes` — rotation threshold in bytes (64 KiB–1 GiB, default 5 MiB).
- `schegent.logging.runtimeLogMaxGenerations` — number of `<path>.1` .. `<path>.N` to keep (0–20, default 3).

The runtime log is sanitized — secrets in operator-controllable text are stripped.

### `sessions/raw-<runId>.log`

The **raw transcript** for a given run. Captures the prompt, the CLI's stdout and stderr verbatim, and the exit code, with **no sanitization**.

The host writes this file as the run proceeds; nothing reads it back. There is no UI surface for the raw transcript — you open it in your editor.

`<runId>` is a UUID assigned when the task transitions to in-flight.

This file is the fallback when a failure correlates with a string the sanitizer masked from `audit.log`. Treat it like your shell history: useful, may contain sensitive context, do not check into version control.

### `sessions/<runId>/phase-message.env`

Optional sidecar file the phase runner uses to pass small typed values from one phase to the next. Lives only for the lifetime of the run (or until the operator removes the session tree via task deletion).

Audit events `phase-message-emitted`, `phase-message-truncated`, and `phase-message-invalid` record the lifecycle of this file.

### `sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/`

The verbose diagnostic capture directory for one phase invocation. Created when `schegent.logging.verbose` is enabled at the start of the phase.

Three files per invocation:

- `debug.json` — the CLI's `--debug-file` payload (full debug record).
- `stream.jsonl` — the `--output-format stream-json` event stream, one event per line.
- `verbose.log` — the `--verbose` stderr capture.

**These files are unredacted.** They are an operator opt-in for deep troubleshooting. Diagnostic files do not rotate; they accumulate per run until you delete them manually or via the task-deletion session-tree cleanup.

See [Verbose Diagnostics](../features/verbose-diagnostics.md).

## VS Code global storage (wake-up scheduler)

The wake-up scheduler stores per-user state under VS Code's `globalStorageUri`:

```text
<globalStorageUri>/wakeup/
├── workspace-roots.json     # Snapshot of operator's workspace roots
├── session.log              # Wake-up runner session log (sanitized at capture)
└── invocations.log          # Per-invocation byte counters (paths-free; JSONL)
```

The exact path of `<globalStorageUri>` depends on your OS and VS Code variant:

| Platform | Default path |
|---|---|
| macOS | `~/Library/Application Support/Code/User/globalStorage/<publisher>.<name>/` |
| Linux | `~/.config/Code/User/globalStorage/<publisher>.<name>/` |
| Windows | `%APPDATA%\Code\User\globalStorage\<publisher>.<name>\` |

The exact `<publisher>.<name>` directory name is `schegent.schegent` (or your installation's marketplace id).

### `wakeup/workspace-roots.json`

A snapshot of the operator's open workspace roots. Used by the OS-scheduled wake-up runner for its `cwdInsideWorkspace` safety check before spawning the priming CLI.

The audit log records updates to this snapshot via `wakeup-workspace-roots-updated` — with `rootCount` only, never paths.

### `wakeup/session.log`

The wake-up runner's session log. Captures the prompt, the CLI invocation, and the response. Sanitized at capture time by the same central redaction set; defense-in-depth re-sanitized on read at the IPC projection boundary.

Bounded — the file is trimmed to keep a rolling window; trims are recorded in `invocations.log`.

### `wakeup/invocations.log`

JSONL file recording per-invocation byte counters and outcomes for the wake-up runner.

Fields per record include `correlationId`, `outcome`, `sessionLogBytesAppended`, `sessionLogTrimmed`. **The structured audit log does not mirror byte counters** — the audit log stays enum/intent-only with `correlationId`, `requestedModel`, `actualModel`.

## OS-native scheduler entries (wake-up)

When `schegent.wakeUp.enabled` is `true`, the host writes an OS-native scheduled entry. The exact path depends on platform:

| Platform | Path |
|---|---|
| macOS | `~/Library/LaunchAgents/com.schegent.wakeup.plist` |
| Windows | A Scheduled Task under `\Schegent\Wakeup` |
| Linux (cron) | `~/.config/cron.d/schegent-wakeup` (or per-user crontab entry) |
| Linux (systemd-user) | `~/.config/systemd/user/schegent-wakeup.timer` and `.service` |

These are installed/updated/uninstalled via the host's daemon-driver. The audit log records `wakeup-daemon-installed`, `wakeup-daemon-updated`, `wakeup-daemon-uninstalled`, and `wakeup-daemon-install-failed` events for traceability.

## VS Code workspace state (not on disk)

Schegent persists run state, queue, pause records, and pending-retry schedules to **VS Code's `workspaceState`** — VS Code's per-workspace key-value store. This is *not* a file you can read with a text editor; it lives in VS Code's internal database.

The `STATE_SCHEMA_VERSION` is currently `6`. The host runs a forward migration on activation (v2 → v6) to handle records persisted by older versions.

To inspect or reset workspace state, use the **Reset Workspace State** command (`schegent.reset`). The audit log is not touched by this command.

## What never lives in any file

- **Operator credentials** — never written to disk by Schegent. The Claude CLI manages its own auth tokens under its own paths.
- **The workspace roots themselves in audit events** — only `rootCount` is recorded.
- **Phase-log paths in audit events** — only the selection tuple (queueId, taskId, pipelineId, phaseId, iterationN).
- **Wake-up session-log paths in audit events** — never.

This paths-free discipline keeps the audit log safe to ship off-machine.

## A note on `.gitignore`

Recommended additions to your **workspace** `.gitignore`:

```text
# Schegent runtime sidecar — local-only, append-only evidence
.schegent/
```

The directory's own `.gitignore` ignores itself as defense-in-depth, but a workspace-level entry survives `Reset Workspace State` and makes the intent explicit.

Recommended additions to your **global** `.gitignore` (optional, for paranoid setups):

```text
# Schegent raw transcripts and diagnostic files are unredacted
**/.schegent/sessions/raw-*.log
**/.schegent/sessions/*/diagnostics/
```

These would protect against accidental commits if you ever check `.schegent/` partially into a repository.

## Cleanup options

| What you want to remove | How |
|---|---|
| A single task's session tree | Task removal dialog → "Yes, remove session tree" |
| All runtime state (queue, pause, retries) | `schegent.reset` command |
| Old audit archives | Manual; the host's retention policy already prunes |
| Diagnostic files only | Manual `rm -rf .schegent/sessions/*/diagnostics/` |
| Wake-up scheduler entries | Toggle `schegent.wakeUp.enabled` off |
| Everything Schegent ever wrote | `rm -rf .schegent/`; also toggle wake-up off |

The next page is [File Layout](file-layout.md) — wait, you are reading it. Continue to the [Features](../README.md#features) section.
