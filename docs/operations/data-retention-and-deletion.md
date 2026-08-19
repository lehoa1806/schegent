# Data retention and deletion

Schegent writes to eleven places. Three of them are unredacted, one of them is
outside your workspace, and one of them has no bound at all. This page is the
single answer to *how long does each of these last, what makes it go away, and
can I get it back* — asked once per store, in one table, followed by the
procedures for removing each on purpose.

It is the companion to [File Layout](../reference/file-layout.md), which says
what each file *is* and where it lives. Nothing here repeats that; where a store
needs describing rather than bounding, this page links there and moves on.

## Every store, at a glance

Sizes are as shipped. Where a bound is a setting, the setting name is given and
you can change it; where it is a code-resident constant, it is marked as such
and changing it is a code change.

| Store | Location | Bound | What triggers removal | Recoverable |
|---|---|---|---|---|
| [Audit log](#audit-log-and-its-archives) | `.schegent/audit.log` | 5 MB or 30 days, then rotated (`schegent.audit.rotation.sizeMB`, `schegent.audit.rotation.maxAgeDays`) | Size or age reached on append | Rotated, not deleted — the content moves to an archive |
| [Audit archives](#audit-log-and-its-archives) | `.schegent/audit.log.<stamp>` | newest 10, and 90 days (code-resident; the age bound will not go below 7 days) | The rotation that creates archive 11, or a sweep past the age bound | **No** |
| [Runtime log](#runtime-log) | `.schegent/syslog` (or `schegent.logging.runtimeLogFilePath`) | 5 MiB × 3 generations (`schegent.logging.runtimeLogMaxBytes`, `schegent.logging.runtimeLogMaxGenerations`) | Size reached on write; the oldest generation is dropped | **No** |
| [CLI transport capture](#cli-transport-capture) | `.schegent/cli-transport.log` | 5 MiB × 3 generations (code-resident) | Size reached on write | **No** |
| [Raw transcripts](#session-artifacts-transcripts-and-diagnostics) | `.schegent/sessions/raw-<runId>.log` | 30 days and 512 MiB across all runs (`schegent.logging.sessionRetentionMaxAgeDays`, `schegent.logging.sessionRetentionMaxBytes`) | Activation sweep, a settings change, or task deletion | **No** |
| [Verbose diagnostics](#session-artifacts-transcripts-and-diagnostics) | `.schegent/sessions/<runId>/diagnostics/…` | same policy, same budget | same | **No** |
| [Phase message sidecars](#session-artifacts-transcripts-and-diagnostics) | `.schegent/sessions/<runId>/diagnostics/…/phase-message.env` | same policy, same budget | same | **No** |
| [Metrics rollup](#metrics-rollup) | `.schegent/metrics-rollup.jsonl` | **none, by design** | Nothing. Manual `rm` only | **No** — and it is the all-time totals |
| [Ownership registry](#ownership-registry) | `.schegent/ownership/*.json` | current generation only | Superseded by the next generation | Irrelevant — disposable by construction |
| [Recovery checkpoints](#recovery-checkpoints) | `<globalStorageUri>/checkpoints/<runId>/` — **outside the workspace** | 20 artifacts per run; 14 days and 256 MiB across runs, floor of the 10 newest runs (code-resident) | The next checkpoint in that run, or the activation sweep | **No** |
| [Run history](#run-history-and-workspace-state) | VS Code `workspaceState` | newest 50 entries **per queue** | The 51st entry for that queue | **No** |
| [Workspace state](#run-history-and-workspace-state) | VS Code `workspaceState` | none — it is current state, not a log | `Schegent: Reset Workspace State` | **No** |

Three of those are unredacted and worth naming again: raw transcripts, verbose
diagnostics, and checkpoint `.patch` files. `audit.log` and `syslog` pass through
the redaction set; the other three are verbatim captures, and the reason they
exist is that the redaction set sometimes masks the string you need. Treat them
as you would the working tree they came from.

## What each bound actually does

### Audit log and its archives

Two policies, and they are not the same policy.

**Rotation** is a setting. When `.schegent/audit.log` reaches
`schegent.audit.rotation.sizeMB` (5) or `schegent.audit.rotation.maxAgeDays`
(30), the next append renames it to `.schegent/audit.log.<stamp>` and starts a
fresh file. Nothing is lost at this step — the content moved.

**Archive retention** is code-resident and is where content is lost: the newest
10 archives are kept, and an archive older than 90 days is removed whichever
side of that count it falls on. A configured age below 7 days is raised to 7,
because an audit trail that can be configured down to nothing is not an audit
trail.

Rotation and retention both run on the append path, so a workspace nobody has
opened in a year has not swept anything. Opening it does.

Task deletion and phase deletion never touch this file. Erasing `audit.log` is
not how anything in Schegent removes a record; if you erase it by hand you have
removed the evidence for every task in the workspace, not one. See
[Inspect audit logs](inspect-audit-logs.md).

### Runtime log

Generational, not archival: `syslog`, `syslog.1`, `syslog.2`. When the live file
passes `schegent.logging.runtimeLogMaxBytes` (5 MiB) each generation shifts down
one and the last is dropped. `schegent.logging.runtimeLogMaxGenerations` (3)
accepts `0`, which means the live file is truncated with nothing kept behind it.

The path is redirectable with `schegent.logging.runtimeLogFilePath`, and a
redirected log rotates in its new location under the same bounds. See
[Runtime log](runtime-log.md).

### CLI transport capture

`.schegent/cli-transport.log` at 5 MiB × 3 generations, and both numbers are
code-resident constants rather than settings. It is a debugging capture of what
crossed the CLI boundary; the ceiling is 20 MiB and it is reached by volume, not
by time. Removing it costs nothing an operator relies on —
`rm -f .schegent/cli-transport.log*` is a supported thing to do at any moment.

### Session artifacts: transcripts and diagnostics

One policy covers the raw transcript, the diagnostics tree, and the phase-message
sidecars for a run, because they are one run's evidence and pruning half of it
would leave a set nobody can read. Two bounds, both settings:

- `schegent.logging.sessionRetentionMaxAgeDays` — 30
- `schegent.logging.sessionRetentionMaxBytes` — 536870912 (512 MiB), across every
  run in the workspace

The unit of removal is a **complete run group**, never an individual file. A run
that is still in flight is protected and is not a candidate however large or old
its artifacts are, so the byte bound can be exceeded by live work; it is enforced
against what is finished.

The sweep runs at activation, and again when either setting changes. It is also
the reason a workspace that has been closed for two months prunes on open rather
than on the calendar.

Task deletion removes one run's group immediately, ahead of the policy, when you
choose "remove session tree" in the removal dialog. That path and the retention
sweep both refuse a target they cannot prove is inside `.schegent/sessions/`, and
a refusal skips one group rather than abandoning the sweep.

Whether a raw transcript is written at all is
`schegent.logging.rawTranscriptMode` (`errors-only` by default); whether a
diagnostics tree is written is `schegent.logging.verbose` (off). Neither setting
removes what has already been written.

### Metrics rollup

`.schegent/metrics-rollup.jsonl` is the one store with **no retention policy at
all**, and that is deliberate. It holds all-time cumulative totals derived from
runs whose audit evidence has since rotated away, so a bound on it would silently
change the meaning of a number the dashboard presents as a lifetime figure.

It is append-only, one line per terminal run, and it grows without limit. In
practice that limit is remote — a line is a few hundred bytes and it takes one
run to write.

Deleting it resets the all-time totals to zero. The runs it summarised cannot be
recomputed once their audit evidence has rotated, so this is the least
recoverable deletion on this page even though the file is the smallest. See
[Metrics coverage and the rollup](metrics.md#deleting-it).

### Ownership registry

`.schegent/ownership/*.json` holds window-primacy records, one file per
generation, and records below the current generation are pruned as a matter of
course. There is nothing here to retain: the directory is disposable, deleting it
with no window open costs nothing, and deleting it with a window open makes that
window re-acquire at its next heartbeat. See
[Workspace lock](../concepts/workspace-lock.md).

### Recovery checkpoints

The only store outside your workspace. `<globalStorageUri>/checkpoints/<runId>/`
holds a `git diff --binary HEAD` per Git-capable phase, and the same directory
accumulates work from **every workspace this extension has ever opened** — so
`rm -rf .schegent/` does not reach it, `.gitignore` does not cover it, and the
session sweep does not visit it.

Two independent budgets, neither aware of the other:

| Bound | Value | Scope |
|---|---|---|
| Artifacts per run | newest 20 | Inside one run directory; declines count against it |
| Age | 14 days | Across run directories; the directory goes whole |
| Total size | 256 MiB | Across run directories, oldest first until it fits |
| Recent-run floor | newest 10 directories | Held back from the **size** bound only |

All four are code-resident constants, not settings. The bounds are age and
volume, never lifecycle: a run completing does not delete its checkpoints,
because a finished run's patch is exactly what you want when that run turns out
to have gone badly.

Nothing warns before a reap and there is no undo. **If you need a patch to
outlive these bounds, copy it out of the store.**
[Recovery checkpoints](recovery-checkpoints.md) has the full policy and the
by-hand `git apply` procedure.

### Run history and workspace state

Neither is a file. Both live in VS Code's `workspaceState`, which is a per-workspace
key-value store inside VS Code's own database — not something you can read with
an editor.

**History** is capped at the newest 50 entries **per queue**, not per workspace.
A workspace with several queues therefore holds more than 50 entries in total,
and one busy queue cannot evict another's history. The 51st entry for a queue
drops that queue's oldest.

**Workspace state** is not a log and has no retention: it is the current queue,
the live runs, the leases, the pause records, the pending retries, and your saved
confirmation choices. It changes as work proceeds and is removed only by
`Schegent: Reset Workspace State`, which clears every key except the schema
version and the reset marker.

Reset touches **no file on disk** — the audit log, its archives, every session
tree, the rollup, and the checkpoint store all survive it byte for byte, and the
reset itself is recorded as one `workspace-state-reset` audit entry. See
[Reset safely](reset-safely.md), which covers the preconditions and what happens
if the host dies part-way through one.

## Removing things on purpose

Nothing below is undone by a subsequent Schegent action. Read
[What is irreversible](#what-is-irreversible) first.

### Inside the workspace

Everything Schegent writes in your workspace is under `.schegent/`, so the
coarsest removal is one directory:

```sh
rm -rf <workspace>/.schegent/
```

That removes the audit log and every archive, the runtime log, the CLI capture,
every session tree, the metrics rollup, and the ownership registry. It does not
remove workspace state, and it does not remove checkpoints.

Finer-grained removals:

```sh
# Rotated audit archives only; the live log stays.
rm -f <workspace>/.schegent/audit.log.*

# Captured CLI output; rotation already caps this at 20 MiB.
rm -f <workspace>/.schegent/cli-transport.log*

# Runtime log and its generations.
rm -f <workspace>/.schegent/syslog*

# Unredacted diagnostics only; raw transcripts stay.
rm -rf <workspace>/.schegent/sessions/*/diagnostics/

# One run's evidence, transcript and diagnostics together.
rm -rf <workspace>/.schegent/sessions/<runId>/ \
       <workspace>/.schegent/sessions/raw-<runId>.log

# All-time metrics totals. Read the warning below first.
rm -f <workspace>/.schegent/metrics-rollup.jsonl
```

Prefer the task-removal dialog's "remove session tree" over the last per-run
command when the task is still in the queue: it proves containment before it
removes, and it records what it did.

### Outside the workspace

The checkpoint store is under VS Code's global storage for this extension. The
directory differs per platform and per install:

```text
macOS    ~/Library/Application Support/Code/User/globalStorage/<publisher>.<name>/checkpoints/
Linux    ~/.config/Code/User/globalStorage/<publisher>.<name>/checkpoints/
Windows  %APPDATA%\Code\User\globalStorage\<publisher>.<name>\checkpoints\
```

Substitute VS Code Insiders, VSCodium, or a portable install's own user-data
directory as appropriate. To remove one run's checkpoints, or the store entirely:

```sh
rm -rf '<globalStorage>/checkpoints/<runId>/'
rm -rf '<globalStorage>/checkpoints/'
```

Removing the store while a run is in flight is safe in the sense that nothing
crashes — the next Git-capable phase recreates what it needs — but it is
fail-closed, so a store the host cannot write to blocks that phase rather than
skipping it.

Releases up to and including the Wake-up scheduler's withdrawal also left a
`wakeup/` subdirectory there. Nothing reads or writes it now; delete it if you
want the space back.

### Workspace state

Use the command, not the filesystem:

```text
Command Palette → Schegent: Reset Workspace State
```

It cancels any running phase first and refuses outright — clearing nothing — if a
CLI subprocess has not exited within 10 seconds. Editing VS Code's state database
by hand is not a supported path and can leave a record the schema loader refuses.

### Removing everything

In order, because the last step is the one that needs the extension working:

```sh
rm -rf <workspace>/.schegent/
rm -rf '<globalStorage>/checkpoints/'
```

then `Schegent: Reset Workspace State`, then check
[Scheduled entries left by earlier releases](../reference/file-layout.md#scheduled-entries-left-by-earlier-releases)
if you have run a release that created one.

## What is irreversible

Every deletion on this page is irreversible in the ordinary sense — there is no
undo, no trash, and no in-product restore for any store. Three are worth calling
out because their cost is larger than the file:

**The metrics rollup.** Deleting it zeroes the all-time totals. Those totals
cover runs whose audit evidence has already rotated away, so they cannot be
recomputed from anything that remains. The dashboard will present the new,
smaller numbers as lifetime figures without any indication that history was lost.

**Audit archives.** The audit log is the record of what Schegent did. An archive
removed by hand — or aged out at 90 days — takes with it the only account of the
runs it covered. Rotation is safe; removing `audit.log.*` is not the same
operation.

**Checkpoint patches.** A `.patch` is the only copy of an uncommitted working
tree at a moment that has since passed. Once the age or size bound reaps its run
directory, the file is gone and the runtime log records how many directories a
sweep removed, not which. Copy anything you might want before it ages out.

Two things are *not* irreversible and are often mistaken for it. Audit
**rotation** moves content rather than removing it. And workspace-state reset
removes coordination state, not evidence — every file on this page survives it,
so a reset is recoverable in the sense that you can see what happened before it
from the audit log.

## Where to look next

- [File Layout](../reference/file-layout.md) — what each file is and what it contains
- [Reset safely](reset-safely.md) — the reset command's preconditions and failure modes
- [Recovery checkpoints](recovery-checkpoints.md) — the checkpoint store's full policy
- [Metrics coverage and the rollup](metrics.md) — why the rollup has no bound
- [Inspect audit logs](inspect-audit-logs.md) — reading what the audit log kept
- [Settings](../reference/settings.md) — every retention setting named on this page
