# Execution Evidence Health

Schegent projects one workspace-scoped health state for its four execution
evidence sinks. The state appears in the sidebar/dashboard health strip and in
the VS Code status bar, so an operator does not need to correlate separate I/O
warnings.

## State and continuation policy

| Sink | Healthy state | Failure state | Continuation policy |
|---|---|---|---|
| Structured audit (`.schegent/audit.log`) | `healthy` | `unavailable` | **Fail closed.** The active run becomes failed before further CLI work and automatic queue drain stops. |
| Raw transcript (`.schegent/sessions/raw-<runId>.log`) | `healthy` | `degraded` | Continue. The bounded parser capture remains available, but verbatim evidence may be incomplete. |
| Runtime log (`.schegent/syslog`) | `healthy` | `degraded` | Continue. Output-channel and workflow operation remain available. |
| Metrics rollup (`.schegent/metrics-rollup.jsonl`) | `healthy` | `degraded` | Continue. The run executes and completes normally; only its durable contribution to cumulative totals is at risk. See [Metrics coverage and the rollup](metrics.md). |

The overall state is `unavailable` when structured audit is unavailable,
otherwise `degraded` when any optional sink is degraded, and `healthy` only
when all four sinks are healthy.

Health is intentionally sticky for the lifetime of the workspace host. A
successful write after an I/O failure does not prove that the missing evidence
was recovered. Resolve the cause and reload the VS Code window before resuming
or starting more work.

The metrics rollup is listed as a sink because its failure is otherwise
invisible. A run whose rollup append failed still executes, still completes, and
still appears in the dashboard — but it is then held only by its audit evidence,
so it stops being counted once rotation prunes the archive containing it, and
the cumulative totals regress at that point rather than at the time of the
failure. Schegent does not backfill the missed record from the log, because a
rebuild from a corpus that may already be incomplete reintroduces the defect the
rollup exists to remove. Treat the degraded badge as a warning about a *future*
regression in reported totals, not a current one.

## What is projected

Each sink exposes only bounded metadata:

- status and continuation policy;
- failure count and last-failure timestamp;
- a normalized cause such as `disk-full`, `permission-denied`,
  `read-only-filesystem`, `partial-write`, `stream-error`, or
  `cleanup-failed`.

Exception text, filesystem paths, prompts, transcript bytes, and environment
values are never part of the health snapshot. Repeated failures with the same
sink and cause update the count but produce one warning, reducing alert noise.

## Recovery playbook

1. Stop creating new work while the indicator is degraded or unavailable.
2. Check free space and permissions for the workspace and OS temporary
   directory. If the runtime log uses a custom path, check its parent too.
3. Preserve the existing structured audit log and any raw transcript that was
   written. Do not infer completeness across the reported failure window.
4. Fix the filesystem or configuration problem, then run **Developer: Reload
   Window**.
5. Confirm the evidence indicator is healthy before resuming the failed task
   or draining the queue.

An audit-unavailable task is recorded in workflow state and history with the
sanitized code `audit-evidence-unavailable`. Schegent deliberately does not
attempt to write another audit event to the failed sink as proof of that
failure.

## Fault coverage

Blocking tests inject permission denial, disk-full, partial spool copies,
stream failures, and spool-cleanup failures. They assert normalized metadata,
warning coalescing, raw-evidence fallback, audit fail-closed behavior, and the
absence of paths or secret-like text in host/webview projections.
