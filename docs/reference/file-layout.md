# File Layout

Schegent writes to two locations on disk: the workspace `.schegent/` directory
(per-workspace, local-only evidence), and — for recovery checkpoints only — VS
Code's global storage for this extension, which is **outside your workspace**.

This page maps every file Schegent creates and what it is for. For how long each
one lasts, what removes it, and how to remove it yourself, see
[Data retention and deletion](../operations/data-retention-and-deletion.md).

## Workspace `.schegent/` directory

Everything under `<workspaceRoot>/.schegent/` is **local-only**. It is intentionally not designed to be checked into version control; the directory's own `.gitignore` blocks itself.

```text
<workspaceRoot>/.schegent/
├── .gitignore                          # Self-gitignore (defense in depth)
├── audit.log                           # Active structured audit (sanitized)
├── audit.log.<YYYYMMDD-HHMMSS-mmm-id>  # Rotated audit archives
├── syslog                              # Active runtime log (sanitized)
├── syslog.1, syslog.2, syslog.3 ...    # Rotated runtime log generations
├── cli-transport.log                   # Active CLI stdout/stderr capture (sanitized)
├── cli-transport.log.1 ... .3          # Rotated CLI capture generations
├── metrics-rollup.jsonl                # Durable per-run metrics rollup (never pruned)
├── ownership/
│   └── <resource>.<hash>.g<NNNNNNNNN>.json  # Window-primacy ownership records
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

### `cli-transport.log`

Every line the Claude CLI printed on stdout and stderr, one record per line, in
the order the host received them:

```text
<ISO-8601 timestamp>\t<runId>\t<phase>\t<stream>\t<the line the CLI printed>
```

Tab-separated with the content last, so `cut -f5- .schegent/cli-transport.log`
gives you the CLI's own bytes back and `jq` still works on a stream-json run. No
per-line truncation is applied — a long line is written whole.

This is the file to read when you want to know what the CLI actually said. Until
the release that added it, those lines were individual entries in `audit.log`,
where they accounted for **93.2% of the file** and crowded out the run history
the metrics dashboard reads. They are a copy of the subprocess's own output
rather than a record of anything Schegent decided, so they now have their own
file and their own budget.

**Rotation:** 5 MiB per generation, 3 generations behind the live file
(`cli-transport.log.1` … `.3`), so the whole capture is bounded at 20 MiB per
workspace. These bounds are built in — deliberately not settings, because an
operator raising one would then be able to starve the audit log's retention,
which is the coupling this split removed.

**Best-effort.** If the file cannot be written, the phase is unaffected and runs
normally; you get one warning in the runtime log per distinct cause, and that
warning never names the path. Nothing here is load-bearing evidence: the audit
log keeps the per-invocation summary (line counts, first and last output
timestamps, exit status, detected issues) either way, and the unredacted raw
transcript under `sessions/raw-<runId>.log` is unaffected.

**Sanitized,** through the same redaction set as `audit.log` and `syslog`. One
difference from `audit.log` is deliberate: this file **does** contain filesystem
paths, because raw CLI output names the files the CLI touched and stripping them
would leave a record you could not use. Treat it like `syslog` — safe to read,
worth a glance before attaching it to a bug report.

### `metrics-rollup.jsonl`

One JSON object per line, one line per terminal run, appended when the run
reaches `completed`, `failed`, or `canceled`:

```json
{"v":1,"runId":"run-4f2c","terminalStatus":"completed","startedAt":"2026-08-18T09:14:02.113Z","endedAt":"2026-08-18T10:02:44.887Z","durationMs":2922774,"phasesTotal":7,"phasesCompleted":7,"phasesSkipped":0,"backendInvocations":19,"costUsd":3.41}
```

An id, a terminal status, two timestamps, six integer counters, and an optional
cost. That is all — no task description, no path, no prompt, no CLI output.
`costUsd` is **omitted** rather than zeroed when the CLI reported no cost, so
"not reported" stays distinguishable from "reported as zero". Written mode
`0600`.

**No rotation, no retention, never pruned** — uniquely among the files on this
page, and deliberately. Everything else the metrics dashboard shows is folded
out of `audit.log`, so it reports the rotation window rather than the history;
before this file existed, a *cumulative* total went down when an archive was
pruned. At roughly 200 bytes per run, 10,000 runs is about 2 MB, so the file is
bounded by how much work the workspace actually does rather than by a budget it
would have to share.

**Append-only and never recomputed.** Records are not rewritten, and the file is
never rebuilt from the audit corpus — a rebuild from a corpus that may already be
pruned would reintroduce the defect the file removes. The append is idempotent
per run id, so a crash-replayed terminal transition does not double-count.

**Best-effort.** If it cannot be written the run is unaffected, one sanitized
warning names the run id and a normalized cause, and evidence health reports the
`metrics rollup` sink as degraded. That run then keeps its totals contribution
only as long as its audit evidence.

Deleting it is safe for execution but permanently drops the runs it covered from
all-time totals. See
[Metrics Coverage and the Rollup](../operations/metrics.md).

### `ownership/<resource>.<hash>.g<NNNNNNNNN>.json`

The window-primacy ownership records. One file per generation, for example
`primacy.9f21c4e0.g000000004.json`.

Two VS Code windows opened on the same workspace arbitrate here: acquiring
means exclusively creating the *next* generation's file, and exclusive creation
is atomic, so exactly one window wins a given generation and the losers re-read
and find the winner. The generation number in the filename **is** the fencing
token — a window that stalls past the staleness threshold is reclaimed at
generation N+1, and when it revives its writes are rejected on the fence.

Records below the current generation are pruned, never re-issued. Files are
written mode `0600` in a directory created mode `0700`; a record names window
owner ids and timestamps, nothing else. These files are disposable — deleting
the directory while no window is open costs nothing, and deleting it while one
is open makes that window re-acquire at the next heartbeat.

See [Workspace lock](../concepts/workspace-lock.md).

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

A `.declined.json` marker means the snapshot could not be attributed to a single
run, so none was taken. It carries a bounded `reason` and a `detail` naming what
to deal with. That is a recorded decision, not a failure — the phase proceeded.
[Recovery checkpoints](../operations/recovery-checkpoints.md) lists every reason
and what to do about each.

The metadata beside a `.patch` carries `runId`, `phaseId`, `capturedAt`,
`baseCommit`, the `git status --porcelain=v1` manifest, and an `attribution`
block of `{mode, inFlightRuns, paths}`. Use `baseCommit` when applying: with
several runs in flight the patch holds one run's sections only, so it is a
subset of a tree that has kept moving.

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

To inspect or reset workspace state, use the **Reset Workspace State** command (`schegent.reset`).

Reset clears **every** key in this store — not a subset. The cleared set is derived from the key map rather than maintained by hand, so a key introduced by a later release is cleared by default; the schema version and the reset marker are the only exemptions, and each carries a recorded reason in the source.

Reset touches **no file on disk**. `.schegent/audit.log`, its rotated archives, and every per-run session tree under `.schegent/sessions/` survive it byte for byte, and the command appends one `workspace-state-reset` entry to the audit log recording what it did. Nothing on this page is created, moved, or deleted by a reset.

It is also not a bare wipe: it cancels any running phase first and refuses outright — clearing nothing — if a CLI subprocess has not exited within 10 seconds. See [The reset command](../concepts/workspace-lock.md#4-the-reset-command) for the full sequence and for what happens if the host dies part-way through one.

## What never lives in any file

- **Operator credentials** — never written to disk by Schegent. The Claude CLI manages its own auth tokens under its own paths.
- **The workspace roots themselves in audit events** — only `rootCount` is recorded.
- **Phase-log paths in audit events** — only the selection tuple (queueId, taskId, pipelineId, phaseId, iterationN).

This paths-free discipline keeps the audit log safe to ship off-machine.

## What Schegent will refuse to touch

Everything above is a location Schegent *writes*. Some of them it also removes,
renames, or truncates on its own initiative — audit, runtime log and CLI-capture
rotation, the session-artifact retention sweep, task-deletion cleanup,
checkpoint pruning, and the ownership registry. Those are the only destructive operations
the host performs, and each one proves where the path actually leads before it
acts.

The check resolves symlinks rather than comparing text, because a path built by
joining strings is not the same thing as a path inside a directory: `..` is
something string comparison can count, and a symlink is not. If a component of
the target has been replaced with a link out of the tree — `.schegent/` itself,
one run's session directory, the file `schegent.logging.runtimeLogFilePath`
points at — the operation is **refused and recorded** rather than followed.

What that means in practice:

- **A refusal skips one thing, not the sweep.** A retention pass that cannot
  prove one session directory prunes every other one and reports the refused
  group as not pruned. It is never counted as removed.
- **A refused task-deletion cleanup removes nothing** and tells you so. The
  task still leaves the queue — the cleanup is what is refused, not the
  deletion.
- **If the host cannot resolve a path at all, that is also a refusal.** It does
  not fall back to comparing the text and hoping.
- **A missing path is not a refusal.** There is nothing to delete, which is the
  ordinary state before a first run.
- **Refusals name no path.** `audit.log` gets a bounded reason code —
  `not-contained` or `resolve-failed` — consistent with the paths-free
  discipline above. `syslog` gets the operator-facing detail: which operation
  was refused, and why. Neither records the location, so if you need to know
  *which* file was involved you are looking for what changed in the tree, not
  for a line in a log.

**This is risk reduction, not a guarantee.** The host checks and then acts, and
those are two separate operations — a sufficiently well-timed change to the
tree between them still wins. What the check buys is the size of that window:
the gap between two adjacent system calls, instead of the whole time Schegent
has been running. If you are protecting a workspace against something that can
write to it at will, the containment check is not the control you want; file
permissions are.

None of this changes where Schegent writes — the locations are the ones listed
on this page. It changes what happens when the tree turns out not to be shaped
the way the host assumed.

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
| All workspace state (queue, runs, pause, retries, leases, saved prompt choices) | `schegent.reset` command — clears every key, no file |
| Old audit archives | Manual; the host's retention policy already prunes |
| Captured CLI output | Manual `rm -f .schegent/cli-transport.log*`; rotation already caps it at 20 MiB |
| All-time metrics totals | Manual `rm -f .schegent/metrics-rollup.jsonl`; nothing prunes it. Irreversible for any run whose audit evidence has already rotated away — see [Metrics Coverage and the Rollup](../operations/metrics.md#deleting-it) |
| Diagnostic files only | Manual `rm -rf .schegent/sessions/*/diagnostics/` |
| Recovery checkpoints | Manual `rm -rf '<globalStorage>/checkpoints/'` — **not** under `.schegent/`; see [Data retention and deletion](../operations/data-retention-and-deletion.md#outside-the-workspace) for the per-platform path |
| A scheduled entry left by an earlier release | See [Scheduled entries left by earlier releases](#scheduled-entries-left-by-earlier-releases) |
| Everything Schegent ever wrote | `rm -rf .schegent/` **and** the checkpoint store above, plus any leftover scheduled entry. `.schegent/` alone is not everything — the checkpoint store is outside the workspace and holds patches from every workspace this extension has opened |

Each of those is irreversible in a different way, and the table above says how
rather than how much. [Data retention and deletion](../operations/data-retention-and-deletion.md)
carries the full inventory — every store with its bound, what triggers removal,
and what cannot be recovered afterwards.

Continue to the [Features](../README.md#features) section.
