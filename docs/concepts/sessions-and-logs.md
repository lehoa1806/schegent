# Sessions, Logs, and Audit Evidence

Schegent writes to disk in five distinct places, each with a different purpose, durability, and trust profile. This page is the map. After reading it you will know exactly what survives a run, what gets sanitized, and where to look when you need to investigate something.

## The six sinks at a glance

| Sink | Location | Sanitized? | Rotates? | Purpose |
|---|---|---|---|---|
| Structured audit log | `<workspaceRoot>/.schegent/audit.log` | yes | yes | Append-only structured evidence of every run |
| Raw transcript | `<workspaceRoot>/.schegent/sessions/raw-<runId>.log` | **no** (local-only) | no | Per-run scrollback equivalent for deep debug |
| Verbose diagnostic files | `<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/...` | **no** (opt-in) | no | Per-invocation unredacted debug payloads |
| Runtime debug log | `<workspaceRoot>/.schegent/syslog` (default) | yes | yes | Sanitized mirror of the Output channel |
| CLI transport capture | `<workspaceRoot>/.schegent/cli-transport.log` | yes (paths retained) | yes | Line-by-line record of what the CLI emitted |
| Metrics rollup | `<workspaceRoot>/.schegent/metrics-rollup.jsonl` | n/a (no free text) | **never pruned** | One counters-only record per terminal run, so all-time totals outlive rotation |

## 1. The structured audit log

`.schegent/audit.log` is the **single canonical record** of what Schegent did. It is the file you read when you want to know "what happened during run X". It is also the file CI systems and operators can grep for cross-run trends.

### What class of evidence this is

**Diagnostic evidence, not tamper-evident compliance evidence.** Schegent's writer is append-only and never rewrites a line it has already written, which is what makes the log trustworthy for reconstructing a run. It is still an ordinary file on your disk: any process running under your account can edit or delete it, and Schegent has no hash chain, signature, or external sink with which to notice. Rotation and retention also prune old archives on a schedule.

So: rely on it to answer "what did this run do", to attach to a bug report, and to grep for trends. Do not rely on it as an immutable record for audit or compliance purposes. A hash-chained or externally-sinked audit is a separate capability Schegent does not have today.

### Format

JSONL — one event per line. Every event has at least:

- `timestamp` — ISO-8601 UTC.
- `eventType` — one of the audit-event enum values (see the [Audit Events reference](../reference/audit-events.md)).
- `runId`, `pipelineId`, `phaseId` — present where applicable.
- `outcome` — `success` or `failure` where applicable.
- Event-specific fields (`pauseCause`, `fromPosition`, `signature`, etc.).

### Sanitization

Every string written to `audit.log` passes through the host's central sanitization function. There is **one** redaction set in the codebase; every sink that touches operator-controllable text uses it. The same patterns that scrub secrets from the audit log also scrub them from the runtime log, the Output channel, and the phase log feed in the sidebar.

If a value in `audit.log` is replaced with `[REDACTED]`, that is the redaction set at work.

### Rotation

The active `audit.log` rotates to `audit.log.<YYYYMMDD-HHMMSS-mmm-id>` when either of these is true. The millisecond and short random suffix prevent same-second archive collisions; legacy seconds-only archives remain supported:

- File size exceeds `schegent.audit.rotation.sizeMB` megabytes (default 5).
- Active log age exceeds `schegent.audit.rotation.maxAgeDays` days (default 30).

Rotated archives are pruned per retention policy (a 7-day archive-age floor, plus a count cap). The rotation and retention events themselves appear in the log (`audit-rotated`, `audit-retention-applied`).

### What never appears in the audit log

Audit schema v3 is a bounded, metadata-only projection. You will *never* see in new v3 records:

- The list of workspace roots (only `rootCount` appears).
- The path of the phase log feed file (only the selection tuple — queueId, taskId, pipelineId, phaseId, iterationN).
- Executable paths, argv, commands, endpoints, session/conversation ids, model-output notes/errors, or repository-relative filenames.
- Operator credentials, environment variables, or tokens. Unsafe payloads fail the append; the runtime log records only the event type and rejection reason code.

Legacy v1/v2 records remain readable and are not rewritten. Review or export logs through the v3 counts-only export path before sharing them off-machine.

## 2. The raw transcript

`.schegent/sessions/raw-<runId>.log` is the local-debug equivalent of your terminal scrollback for a run. It captures the prompt, the CLI's stdout and stderr verbatim, and the exit code — **without** sanitization.

### Why it is unredacted

The raw transcript is the canonical *what-actually-happened* artefact. If a run fails in a way that the sanitized audit log cannot explain — because the failure correlates with a string the redaction set masked — the raw transcript is your fallback.

### Where it lives, who reads it

- Path: `<workspaceRoot>/.schegent/sessions/raw-<runId>.log`.
- Written by the host as the run proceeds.
- Captured through private, mode-`0600`, backpressured stdout/stderr spools in
  the OS-managed temporary directory so the final transcript stays verbatim
  even when bounded parser buffers retain only their head and tail; completed
  spools are removed immediately and abandoned owner-PID spools are scavenged.
- **Never read back** by the host or webview. There is no UI that surfaces its contents. You open it with your editor of choice.
- Listed in the best-effort `.schegent/.gitignore` Schegent writes on first
  runtime-directory use, and ideally in the workspace `.gitignore` too — it is
  local-only by design.

Treat raw transcripts like you treat your shell history: they are useful, they may contain sensitive context, do not check them into version control or share them publicly without review.

## 3. Verbose diagnostic files (opt-in)

When you set `schegent.logging.verbose: true`, the host adds three CLI flags to every phase invocation — `--debug-file`, `--output-format stream-json`, and `--verbose` — and tees the resulting streams to a per-invocation directory:

```text
<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/
├── debug.json       # full CLI debug payload
├── stream.jsonl     # the stream-json output, one event per line
└── verbose.log      # the --verbose stderr capture
```

### Why opt-in

Verbose diagnostics are **intentionally unredacted**. They exist so you can deeply troubleshoot a phase that is misbehaving — a hung tool call, an unexpected prompt format, a model regression — without the sanitizer eliding the field you actually need.

Because they are unredacted, they are off by default. Toggle them on only when investigating a specific failure, and turn them off again afterward.

### Mid-run toggling

The verbose flag is *not cached*. The host re-reads it at the entry of every phase invocation. Toggling it mid-run takes effect on the *next* phase; the in-flight phase is not retroactively re-captured.

### What rotates and what does not

Diagnostic files **do not rotate** individually. Raw transcripts and diagnostic
trees are managed as per-run groups: after a run is inactive, the shared
retention service removes groups older than the configured age and, if needed,
the oldest groups until the configured byte budget is met. Running and paused
runs are protected. Manual cleanup and the **Task deletion** flow remain
available.

## 4. The runtime debug log

The Output channel ("Schegent" in the VS Code Output panel) is where the extension emits structured log records during normal operation. The runtime debug log mirrors that channel to disk so you can `tail`, `grep`, and ship records to other tools.

### Settings

- `schegent.logging.runtimeLogLevel` — `DEBUG`, `INFO`, `WARN`, or `ERROR`. Default `INFO`. Records below the threshold are dropped.
- `schegent.logging.runtimeLogFilePath` — file path. Empty string resolves to `<workspaceRoot>/.schegent/syslog`. Accepts absolute paths or workspace-relative paths; `..` segments are rejected.
- `schegent.logging.runtimeLogMaxBytes` — rotation threshold in bytes (default 5 MiB, range 64 KiB–1 GiB).
- `schegent.logging.runtimeLogMaxGenerations` — how many `<path>.1`, `<path>.2`, … to keep (default 3, range 0–20).

### Sanitization is shared

Like `audit.log`, the runtime log is sanitized by the same central function. A secret stripped from one is stripped from the other. There is no separate redaction set for the runtime log.

### Suppression on write failure

If the runtime log writer encounters an I/O error (disk full, permission denied), it suppresses further writes for the same path and surfaces a warning. The suppression clears when you save the runtime-log settings again, even if you save the *same* values — that is the operator-visible recovery affordance.

## 5. The CLI transport capture

`.schegent/cli-transport.log` holds the lines the CLI emitted, one per line:

```text
<ISO-8601 timestamp>\t<runId>\t<phase>\t<stream>\t<the line the CLI printed>
```

Content comes last so `cut -f5-` gives you back the CLI's own bytes, and
`awk -F'\t' '$2 == "<runId>"'` narrows the file to one run. See the
[file layout reference](../reference/file-layout.md#cli-transportlog) for the
full description.

### Why it is not in the audit log

It used to be. The monitor wrote one `monitor-stdout-line` audit event per line,
and those events came to 93.2% of a measured `audit.log` — enough to push the
Metrics dashboard's window down to roughly forty runs, because the audit log's
rotation budget was being spent on CLI transport rather than on the run events
the dashboard reads. Separating the two lets each have its own budget. The
*counts* stayed in the audit log: one `monitor-invocation-summary` per
invocation carries `stdoutLines`, `stderrLines`, `firstOutputAt`, and
`lastOutputAt`.

### Retention

The capture is bounded in code, not by settings: 5 MiB active file plus three
rotated generations, so 20 MiB per workspace. They are not operator-tunable on
purpose — a raisable bound would put this file back into competition with the
audit log's retention.

### Best-effort, unlike the audit log

A failed audit append fails the run closed. A failed transport write does not
affect the phase at all: it warns once per cause in the runtime log and capture
stops for that cause. So treat the file as a convenience for reconstructing a
timeline, not as evidence that must be complete. The raw transcript remains the
canonical byte-for-byte artefact, and it is unaffected by this sink.

### Sanitization and paths

Lines pass through the same central redaction set as the audit log. Unlike the
audit log, this sink does **not** apply the paths-free discipline — the CLI's
output routinely names files, and stripping paths would leave the lines
useless. That makes it sanitized but path-bearing: safer than the raw
transcript, less bounded than a v3 audit payload.

## 6. The metrics rollup

`.schegent/metrics-rollup.jsonl` is the odd one out on this page. The other five
sinks record *what happened*; this one records *how much*, and it exists because
the other five all rotate.

One line per terminal run, appended at `completed`, `failed`, or `canceled`,
holding an id, a terminal status, two timestamps, six integer counters and an
optional cost — nothing else. There is no description, no path, no prompt, no CLI
output, which is why the sanitization column reads n/a: there is no free text in
it to redact.

### Why it is never pruned

Every other metric the dashboard shows is a fold over `audit.log` and its
archives, so it reports the *rotation window* rather than the history. Applied to
a cumulative figure that is a defect rather than a limitation: when rotation
pruned an archive, the all-time total went **down**. The rollup is written while
the evidence is still present and then left alone, so those totals stop depending
on what the log still holds. At roughly 200 bytes per run it costs bytes per day,
which is why it can afford to have no retention policy at all.

It is append-only and **never recomputed** — rebuilding it from a corpus that may
already be pruned would reintroduce exactly the defect it removes — and the
append is idempotent per run id, so a crash-replayed terminal transition does not
double-count.

### What it is not

Not evidence. It carries no record of what a run *did*, only of its size, and it
is not a substitute source for anything `audit.log` holds. A rollup write failure
never fails a phase; it warns once, shows up as a degraded `metrics rollup` sink
in evidence health, and leaves that one run's totals contribution to expire with
its audit evidence.

See [Metrics Coverage and the Rollup](../operations/metrics.md) for the operator
view, including how to report from the file with `jq`.

## The session tree, per run

Each run gets its own subtree under `.schegent/sessions/<runId>/`:

```text
<workspaceRoot>/.schegent/
├── audit.log                       <- structured evidence (shared across all runs)
├── audit.log.<rotation-stamp>      <- rotated archives
├── syslog (or syslog.1, .2 ...)    <- runtime log + rotations
├── cli-transport.log (+ .1 ... .3) <- captured CLI output (shared across runs)
├── metrics-rollup.jsonl            <- one counters-only record per terminal run
└── sessions/
    ├── raw-<runId>.log             <- raw transcript for runId
    └── <runId>/
        └── diagnostics/
            └── <pipelineId>/<phaseId>/iter-<N>/
                ├── phase-message.env  <- optional inter-phase sidecar
                └── ...                <- verbose diagnostics if enabled
```

The `runId` is a UUID; you find it in audit-log events for the run, in the sidebar's run-detail view, and in the dashboard.

## Task deletion and the session tree

When you delete a task, Schegent gives you a confirmation dialog with an option to remove the per-run session tree (`raw-<runId>.log` and `sessions/<runId>/`). The decision is yours:

- **Yes, remove** — the runId directory and the raw transcript are deleted best-effort. If a file is locked or unavailable, the audit log records the failure and the queue removal proceeds.
- **No, keep** — the session tree survives the task removal. You can review or delete it manually later.

Kept session trees still participate in the normal automatic retention policy.

In **either case**, the structured `audit.log` is **never** modified by task deletion. The audit log is append-only evidence: deleting a task records a `task-removed` event with the optional `sessionCleaned` flag; it does not erase the events that came before.

## Why two different local-only sinks?

You may have noticed that Schegent has two local-only diagnostic sinks with stricter handling rules:

1. The raw transcript (always written, local-only, gitignored).
2. The verbose diagnostic files (opt-in, local-only, gitignored).

Both trade strictly-local unredacted bytes for the operator's ability to deeply debug a real failure. The architectural mitigations — never serializing sensitive local artifact paths to audit events and keeping workspace-local diagnostic sinks gitignored — keep them from accidentally leaving the operator's machine.

If you cannot tolerate unredacted bytes on disk, you can:

- Leave `schegent.logging.verbose` at its default (false).
- Add `.schegent/sessions/raw-*.log` to a global git ignore policy.
- Treat `.schegent/` as you would your shell history.

Whether the trade-off makes sense for your environment is your decision; the next page in the security section, [Operator Threat Model](../security/threat-model.md), discusses it explicitly.

The next concept page is [Getting Started → Installation](../getting-started/installation.md), which walks you through wiring all of this up.
