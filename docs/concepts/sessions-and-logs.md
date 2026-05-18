# Sessions, Logs, and Audit Evidence

Schegent writes to disk in four distinct places, each with a different purpose, durability, and trust profile. This page is the map. After reading it you will know exactly what survives a run, what gets sanitized, and where to look when you need to investigate something.

## The four sinks at a glance

| Sink | Location | Sanitized? | Rotates? | Purpose |
|---|---|---|---|---|
| Structured audit log | `<workspaceRoot>/.schegent/audit.log` | yes | yes | Append-only structured evidence of every run |
| Raw transcript | `<workspaceRoot>/.schegent/sessions/raw-<runId>.log` | **no** (local-only) | no | Per-run scrollback equivalent for deep debug |
| Verbose diagnostic files | `<workspaceRoot>/.schegent/sessions/<runId>/diagnostics/<pipelineId>/<phaseId>/iter-<N>/...` | **no** (opt-in) | no | Per-invocation unredacted debug payloads |
| Runtime debug log | `<workspaceRoot>/.schegent/syslog` (default) | yes | yes | Sanitized mirror of the Output channel |

A fifth sink, the wake-up session log, lives under VS Code global storage rather than `.schegent/` — see [Wake-up Scheduler](../features/wake-up-scheduler.md).

## 1. The structured audit log

`.schegent/audit.log` is the **single canonical record** of what Schegent did. It is the file you read when you want to know "what happened during run X". It is also the file CI systems and operators can grep for cross-run trends.

### Format

JSONL — one event per line. Every event has at least:

- `timestamp` — ISO-8601 UTC.
- `eventType` — one of the audit-event enum values (see the [Audit Events reference](../reference/audit-events.md)).
- `runId`, `pipelineId`, `phaseId` — present where applicable.
- `outcome` — `success` or `failure` where applicable.
- Event-specific fields (`pauseCause`, `fromPosition`, `signature`, etc.).

### Sanitization

Every string written to `audit.log` passes through the host's central sanitization function. There is **one** redaction set in the codebase; every sink that touches operator-controllable text uses it. The same patterns that scrub secrets from the audit log also scrub them from the runtime log, the Output channel, the phase log feed in the sidebar, and the wake-up session log.

If a value in `audit.log` is replaced with `[REDACTED]`, that is the redaction set at work.

### Rotation

The active `audit.log` rotates to `audit.log.<YYYYMMDD-HHMMSS>` when either of these is true:

- File size exceeds `schegent.audit.rotation.sizeMB` megabytes (default 5).
- Active log age exceeds `schegent.audit.rotation.maxAgeDays` days (default 30).

Rotated archives are pruned per retention policy (a 7-day archive-age floor, plus a count cap). The rotation and retention events themselves appear in the log (`audit-rotated`, `audit-retention-applied`).

### What never appears in the audit log

The audit log is intentionally **paths-free** for sensitive locations. You will *never* see in `audit.log`:

- The path of `wakeup/session.log` or any wake-up session-log path.
- The list of workspace roots (only `rootCount` appears).
- The path of the phase log feed file (only the selection tuple — queueId, taskId, pipelineId, phaseId, iterationN).
- Operator credentials, environment variables, or tokens (the redaction set strips these from any string that reaches the writer).

This is by design: the audit log is the safest sink to ship off-machine, attach to bug reports, or store in shared infrastructure.

## 2. The raw transcript

`.schegent/sessions/raw-<runId>.log` is the local-debug equivalent of your terminal scrollback for a run. It captures the prompt, the CLI's stdout and stderr verbatim, and the exit code — **without** sanitization.

### Why it is unredacted

The raw transcript is the canonical *what-actually-happened* artefact. If a run fails in a way that the sanitized audit log cannot explain — because the failure correlates with a string the redaction set masked — the raw transcript is your fallback.

### Where it lives, who reads it

- Path: `<workspaceRoot>/.schegent/sessions/raw-<runId>.log`.
- Written by the host as the run proceeds.
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

Diagnostic files **do not rotate**. They accumulate per run. If you leave verbose on for weeks, the per-run directories will grow. Clean them up manually or use the **Task deletion** flow which optionally removes the per-run session tree.

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

## The session tree, per run

Each run gets its own subtree under `.schegent/sessions/<runId>/`:

```text
<workspaceRoot>/.schegent/
├── audit.log                       <- structured evidence (shared across all runs)
├── audit.log.<rotation-stamp>      <- rotated archives
├── syslog (or syslog.1, .2 ...)    <- runtime log + rotations
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

In **either case**, the structured `audit.log` is **never** modified by task deletion. The audit log is append-only evidence: deleting a task records a `task-removed` event with the optional `sessionCleaned` flag; it does not erase the events that came before.

## Why three different local-only sinks?

You may have noticed that Schegent has three local-only diagnostic sinks with stricter handling rules:

1. The raw transcript (always written, local-only, gitignored).
2. The verbose diagnostic files (opt-in, local-only, gitignored).
3. The wake-up session log (under global storage, sanitized at capture, defense-in-depth re-sanitized on read).

The raw transcript and verbose diagnostics trade strictly-local unredacted bytes for the operator's ability to deeply debug a real failure. The wake-up session log is sanitized, but still records local execution context outside workspace-level `.gitignore` coverage. The architectural mitigations — never serializing sensitive local artifact paths to audit events, keeping workspace-local diagnostic sinks gitignored, and re-sanitizing wake-up session-log reads — keep them from accidentally leaving the operator's machine.

If you cannot tolerate unredacted bytes on disk, you can:

- Leave `schegent.logging.verbose` at its default (false).
- Add `.schegent/sessions/raw-*.log` to a global git ignore policy.
- Treat `.schegent/` as you would your shell history.

Whether the trade-off makes sense for your environment is your decision; the next page in the security section, [Operator Threat Model](../security/threat-model.md), discusses it explicitly.

The next concept page is [Getting Started → Installation](../getting-started/installation.md), which walks you through wiring all of this up.
