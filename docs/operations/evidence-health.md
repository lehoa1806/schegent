# Execution Evidence Health

Schegent projects one workspace-scoped health state for its three execution
evidence sinks. The state appears in the sidebar/dashboard health strip and in
the VS Code status bar, so an operator does not need to correlate separate I/O
warnings.

## State and continuation policy

| Sink | Healthy state | Failure state | Continuation policy |
|---|---|---|---|
| Structured audit (`.schegent/audit.log`) | `healthy` | `unavailable` | **Fail closed.** The active run becomes failed before further CLI work and automatic queue drain stops. |
| Raw transcript (`.schegent/sessions/raw-<runId>.log`) | `healthy` | `degraded` | Continue. The bounded parser capture remains available, but verbatim evidence may be incomplete. |
| Runtime log (`.schegent/syslog`) | `healthy` | `degraded` | Continue. Output-channel and workflow operation remain available. |

The overall state is `unavailable` when structured audit is unavailable,
otherwise `degraded` when either optional sink is degraded, and `healthy` only
when all three sinks are healthy.

Health is intentionally sticky for the lifetime of the workspace host. A
successful write after an I/O failure does not prove that the missing evidence
was recovered. Resolve the cause and reload the VS Code window before resuming
or starting more work.

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
