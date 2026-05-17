# Architecture Overview

This page gives you the mental model you need to use Schegent confidently. It is not a code map — for that, read `ARCHITECTURE.md` in the repo. Here we explain the moving parts in terms of what the operator sees and influences.

## Three processes, one workflow

Three independent processes cooperate during every Schegent run:

```text
┌──────────────────────────────┐     ┌──────────────────────────────┐
│  VS Code Extension Host      │     │   Claude Code CLI subprocess │
│  (the "host")                │◄───►│   (the "runner")             │
│                              │     │                              │
│  • Owns workspace state      │     │  • Runs your prompts         │
│  • Orchestrates the pipeline │     │  • Executes tool calls       │
│  • Reads/writes audit log    │     │  • Spawned per phase         │
└────────────▲─────────────────┘     └──────────────────────────────┘
             │
             │ IPC messages
             │
┌────────────▼─────────────────┐
│  Webview UI (Svelte 5)       │
│  (the "sidebar" / dashboard) │
│                              │
│  • Renders the queue & runs  │
│  • Sends operator intent     │
│  • Receives state snapshots  │
└──────────────────────────────┘
```

- **The host** is the VS Code extension process. It owns the workspace state, the audit log, the queue, the lock, and the Claude CLI lifecycle. Everything you read, edit, or delete inside the sidebar ultimately routes through the host.
- **The runner** is a fresh Claude CLI subprocess that the host spawns once per phase. Its stdout and stderr stream back into the host, get parsed and sanitized, then projected to you. When the phase ends, the subprocess exits.
- **The webview** is the Svelte UI that renders inside the sidebar (and, when you open it, the dashboard). It has no direct access to your filesystem — it only sees what the host chooses to project.

## Trust boundaries

Schegent treats trust strictly: **the host trusts itself; everything outside the host is validated**. This shapes how each piece interacts.

- **Webview → host.** Every message the sidebar sends is parsed against typed runtime validators before any host action runs. Unknown shapes are rejected and recorded in the audit log.
- **Host → webview.** Every string the host pushes to the UI — last-error summaries, paused reasons, tool-call arguments — flows through a single sanitization function that strips secrets and bounded-length-truncates user-controllable content. There is one redaction set in the codebase; every sink uses it.
- **Runner → host.** The CLI subprocess is launched with broad permissions, but its stdout is parsed line-by-line and sanitized before reaching the audit log, the UI, or any downstream projection. The runner cannot inject UI content directly; everything it emits is data, not markup.
- **Host → disk.** Persistent state lives in three distinct locations with different durability and visibility properties — see [Sessions, Logs, and Audit Evidence](sessions-and-logs.md).

The single biggest implication for you: **operator-controllable strings (feature request descriptions, custom-phase prompts, retry conditions) are never trusted as code or as markup.** They are validated, sanitized, and treated as data.

## State versus evidence

Schegent splits its persisted information into two kinds:

- **State** lives in VS Code's `workspaceState` key-value store. This is the queue, the runs, the phase overrides, the breakpoints. State is *mutable* — pause flips a flag, resume flips it back. State has a schema version (`STATE_SCHEMA_VERSION`) and migrates forward across extension upgrades. State is the source of truth for *what should happen next*.
- **Evidence** is append-only structured data written to disk under `.schegent/`. It is the audit log, the per-run session tree, and (when you enable it) the verbose diagnostic files. Evidence is *immutable* once written — deleting a task does not erase its audit trail. Evidence has its own schema version (`AUDIT_SCHEMA_VERSION`). Evidence is the source of truth for *what already happened*.

Pause/resume changes state. Skipping a phase changes state. Reviewing what Claude did yesterday reads evidence.

## The pipeline at runtime

A typical run looks like this from the host's point of view:

1. **You enqueue a feature.** The webview sends a "create task" IPC message. The host validates it, appends it to the queue's pending list, and emits a `feature-request-created` audit event.
2. **The drainer picks it up.** When the queue is unpaused and no other task is in-flight, the host moves the task into `inFlight`, instantiates a `WorkflowRun` with a frozen pipeline snapshot, and acquires the workspace lock.
3. **Phase by phase.** The host spawns the Claude CLI subprocess with the prompt for the first phase. As output streams in, the host writes:
   - a sanitized line to the audit log,
   - a raw line to the per-run transcript (`.schegent/sessions/raw-<runId>.log`),
   - and, if verbose diagnostics is enabled, an unredacted record to the diagnostic sink.
   When the phase completes (success, failure, or paused-at-breakpoint), the host emits `phase-end`, updates state, and either advances to the next phase or stops.
4. **Termination.** When the run reaches `finalize` and exits cleanly, the host emits `feature-request-completed`, releases the lock, and the queue's drainer looks for the next pending task.

Pauses, retries, breakpoints, and fatal signatures all interrupt this loop at known points — they never half-leave a run with the lock held but no in-flight phase.

## The frozen pipeline snapshot

When a task enters `inFlight`, the host takes a *snapshot* of the active pipeline definition — the list of phases, their models, their effort levels, their timeouts — and stores it on the `WorkflowRun`. From that moment, **changes to phase settings in the sidebar do not retarget the in-flight run.** They will only affect tasks that haven't started yet.

This is deliberate. It means that mid-run you can adjust a phase's model without disrupting a working pipeline; the next time the same task type is enqueued, the new settings apply.

## What the operator does

You drive Schegent through three surfaces:

- **The sidebar.** Day-to-day work: enqueue tasks, monitor active runs, pause/resume, set breakpoints, review the phase log feed.
- **VS Code settings.** Persistent configuration: which Claude CLI binary to use, which models map to which phases, whether verbose diagnostics is on, what the wake-up scheduler should do.
- **The dashboard.** A full-window operator console for long-running supervision: bigger phase logs, queue overview, runtime log tail.

All three surfaces project the same underlying state. Changes you make in one are immediately visible in the others.

## What the operator never does directly

Some things are intentionally out of your reach:

- You do not manage the workspace lock by hand. The host releases it on every terminal branch.
- You do not write to `.schegent/audit.log` directly. The audit pipeline is the only writer; tampering is detectable and unsupported.
- You do not pass arguments to the Claude CLI subprocess yourself. The host composes them from the pipeline definition and your settings.
- You do not run multiple Schegent pipelines in parallel inside one workspace. The lock enforces single-run-per-workspace; concurrency happens by opening separate VS Code windows against separate workspaces.

The next page, [Pipelines & Phases](pipeline-and-phases.md), zooms into the seven built-in phases and how phase overrides let you tune them.
