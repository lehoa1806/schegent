# File Layout

Schegent writes to one location on disk: the workspace `.schegent/` directory (per-workspace, local-only evidence).

This page maps every file Schegent creates and what it is for.

## Workspace `.schegent/` directory

Everything under `<workspaceRoot>/.schegent/` is **local-only**. It is intentionally not designed to be checked into version control; the directory's own `.gitignore` blocks itself.

```text
<workspaceRoot>/.schegent/
├── .gitignore                          # Self-gitignore (defense in depth)
├── audit.log                           # Active structured audit (sanitized)
├── audit.log.<YYYYMMDD-HHMMSS-mmm-id>  # Rotated audit archives
├── syslog                              # Active runtime log (sanitized)
├── syslog.1, syslog.2, syslog.3 ...    # Rotated runtime log generations
└── sessions/
    ├── raw-<runId>.log                 # Raw transcript for runId (unredacted)
    └── <runId>/
        └── diagnostics/                # Phase sidecars and verbose diagnostics
            └── <pipelineId>/
                └── <phaseId>/
                    └── iter-<N>/
                        ├── phase-message.env  # Optional inter-phase sidecar
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

### `audit.log.<YYYYMMDD-HHMMSS-mmm-id>`

Rotated archives. Same format as the active `audit.log`. Milliseconds plus a
short random identifier make every archive name collision-resistant when
several rotations happen in one second. Legacy seconds-only archive names
remain eligible for retention. The host emits an `audit-rotated` event in the
new active file each time it rotates.

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

This file is the fallback when a failure correlates with a string the sanitizer masked from `audit.log`. Treat it like your shell history: useful, may contain sensitive context, do not check into version control. Complete inactive-run groups are removed by the shared session-artifact age and byte policy.

### `sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/phase-message.env`

Optional sidecar file the phase runner uses to pass small typed values from one phase to the next. Lives only for the lifetime of the run (or until the operator removes the session tree via task deletion).

Audit events `phase-message-emitted`, `phase-message-truncated`, and `phase-message-invalid` record the lifecycle of this file.

### `sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/`

The verbose diagnostic capture directory for one phase invocation. Created when `schegent.logging.verbose` is enabled at the start of the phase.

Three files per invocation:

- `debug.json` — the CLI's `--debug-file` payload (full debug record).
- `stream.jsonl` — the `--output-format stream-json` event stream, one event per line.
- `verbose.log` — the `--verbose` stderr capture.

**These files are unredacted.** They are an operator opt-in for deep troubleshooting. Diagnostic files do not rotate individually. Complete inactive-run groups are pruned by the shared session-artifact age and byte policy; manual and task-deletion cleanup remain available.

See [Verbose Diagnostics](../features/verbose-diagnostics.md).

## VS Code global storage

Schegent writes **recovery checkpoints** to VS Code's `globalStorageUri`, and
nothing else:

```text
<globalStorageUri>/checkpoints/<runId>/
├── <timestamp>-<phaseId>.patch          # git diff --binary HEAD, mode 0600
├── <timestamp>-<phaseId>.json           # metadata for the patch above
└── <timestamp>-<phaseId>.declined.json  # marker; no patch was taken
```

Written by `RunCheckpointService` before a Git-capable phase runs. The
directory is created mode `0700` and each file mode `0600`, because a patch of
your working tree is as sensitive as the tree. **A `.patch` file is unredacted
source.**

A `.declined.json` marker with `reason: "concurrent-runs-share-one-worktree"`
means more than one run was in flight, so a diff of the single shared working
tree could not be attributed to one run and none was taken. That is a recorded
decision, not a failure — the phase proceeded. See
[the queue concurrency cap](settings.md#schegentqueueglobalconcurrencycap).

There is no in-product restore. A checkpoint is applied by hand with
`git apply`, which is why the declined case writes no patch at all rather than
writing one and hiding it.

The directory is also referenced as an allowed root for
`schegent.logging.runtimeLogFilePath`, alongside the workspace root, the OS
temp directory, and your home directory.

Releases up to and including the Wake-up scheduler's withdrawal wrote a
`wakeup/` subdirectory there (`workspace-roots.json`, `session.log`,
`invocations.log`). Nothing reads or writes it now; delete it if you want the
space back.

## Scheduled entries left by earlier releases

Releases that shipped the Wake-up scheduler installed an OS-native scheduled
entry when `schegent.wakeUp.enabled` was `true`. The setting and the code that
installed, updated, and removed those entries are gone, so an entry installed by
an earlier release stays registered with your OS until you remove it by hand:

| Platform | Path / location | Removal |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.schegent.wakeup.plist` | `launchctl bootout gui/$UID/com.schegent.wakeup` then delete the plist |
| Windows | A Scheduled Task under `\Schegent\Wakeup` | Task Scheduler, or `schtasks /Delete /TN "\Schegent\Wakeup" /F` |
| Linux (cron) | `~/.config/cron.d/schegent-wakeup` or a per-user crontab entry | Delete the file, or `crontab -e` and drop the line |
| Linux (systemd-user) | `~/.config/systemd/user/schegent-wakeup.timer` and `.service` | `systemctl --user disable --now schegent-wakeup.timer` then delete both units |

To check whether you have one: `launchctl list | grep schegent` (macOS),
`crontab -l` / `systemctl --user list-timers` (Linux), or Task Scheduler
(Windows). A leftover entry invokes a runner script that is no longer shipped,
so it fails harmlessly — but it keeps firing on its schedule until removed.

## VS Code workspace state (not on disk)

Schegent persists run state, queue, pause records, and pending-retry schedules to **VS Code's `workspaceState`** — VS Code's per-workspace key-value store. This is *not* a file you can read with a text editor; it lives in VS Code's internal database.

The `STATE_SCHEMA_VERSION` is currently `6`. The host runs a forward migration on activation (v2 → v6) to handle records persisted by older versions.

To inspect or reset workspace state, use the **Reset Workspace State** command (`schegent.reset`). The audit log is not touched by this command.

## What never lives in any file

- **Operator credentials** — never written to disk by Schegent. The Claude CLI manages its own auth tokens under its own paths.
- **The workspace roots themselves in audit events** — only `rootCount` is recorded.
- **Phase-log paths in audit events** — only the selection tuple (queueId, taskId, pipelineId, phaseId, iterationN).

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
| A scheduled entry left by an earlier release | See [Scheduled entries left by earlier releases](#scheduled-entries-left-by-earlier-releases) |
| Everything Schegent ever wrote | `rm -rf .schegent/`, plus any leftover scheduled entry |

The next page is [File Layout](file-layout.md) — wait, you are reading it. Continue to the [Features](../README.md#features) section.
