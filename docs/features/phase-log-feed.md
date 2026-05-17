# The Phase Log Feed

The phase log feed renders the live activity of the in-flight phase as it streams in from the Claude CLI subprocess. It is the operator's window into what the autonomous run is doing right now, with enough fidelity to intervene if something looks wrong.

## What the feed shows

The feed is a filtered, sanitized projection of the CLI's stream. For each phase, you see:

- **Tool calls** — every CLI tool invocation (`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, etc.) with sanitized arguments. Tool names render as badges; arguments are folded by default but expand on click.
- **Messages** — text Claude emits between tool calls.
- **Phase markers** — start and end boundaries, with the phase id and outcome.
- **Errors and warnings** — anything Claude or the host classifies as concerning.

What you do *not* see:

- **Raw tokens** — secrets the central redaction set masks are replaced with `[REDACTED]`.
- **The unredacted CLI debug output** — that lives in the raw transcript and (opt-in) the verbose diagnostics directory.
- **Tool call results** — the feed shows what the model asked the CLI to do, not the CLI's response. Results are inferred from the next phase boundary.

## Where it lives

Two places, the same data:

1. The **sidebar phase log feed**, beneath the in-flight task.
2. The **dashboard**, side-by-side with the runtime debug log.

Both consume the same projector. State stays in sync between them in real time.

## Controls

Above the feed:

- **Pause** — same as the queue panel's pause button. Aggressive: kills the active subprocess.
- **Set Breakpoint** — opens a list of upcoming phases; pick one and the run pauses *before* that phase starts. See [Phase Breakpoints](phase-breakpoints.md).
- **Open in Dashboard** — opens the same feed in the full-window console for a roomier view.

Within the feed:

- Click a tool call to expand its arguments.
- Click a phase marker to scroll to that phase boundary.
- Right-click any line for **Copy line** (sanitized text) and **Reveal in audit log**.

## Selection tuple

The feed is identified by a **selection tuple**:

```text
queueId : taskId : pipelineId : phaseId : iterationN
```

For built-in pipelines, `queueId` is always `default`. The tuple is stable as the run progresses; the operator can switch to viewing past phases of the in-flight run by selecting them in the feed history.

The host validates every tuple against the current `WorkflowSnapshot` (queue membership, task in-flight or in pending/recent/history, pipeline and phase catalog membership) before composing any filesystem path. Operator-supplied path components are *never* trusted.

## Sanitization

The feed is host-sanitized at the IPC boundary, in the fixed order:

1. **Project** — extract operator-relevant events from the raw CLI stream.
2. **Truncate** — cap large argument values.
3. **Sanitize** — apply the central redaction set.

The same `SECRET_PATTERNS` source of truth that scrubs the audit log scrubs the feed. The webview never re-sanitizes or re-stringifies.

## Tail vs. read

The feed supports two access modes:

### Read

The operator clicks a past phase or a past iteration; the host reads the manifest for that selection tuple and projects the events. No subscription.

### Tail

While a phase is in-flight, the feed automatically subscribes to a **live tail session** that pushes new events as they arrive. At most one tail session per host is allowed; switching the selection ends the previous tail.

When the task leaves the in-flight state, the tail session is automatically ended and a synthetic `tail-ended` push reaches the webview. The webview transitions to a static read.

Both modes emit audit events (`phase-log-read`, `phase-log-tail-started`, `phase-log-tail-stopped`) so an operator's interaction history is reconstructable.

## What the feed is **not**

- **A full debugger.** You can pause, set breakpoints, and observe — but you cannot step at the tool-call level inside a phase. The granularity is the phase, not the individual tool call.
- **A logger you can write to.** The feed is read-only. To inject directives between phases, use the `phase-message.env` sidecar (see [Custom Phases](custom-phases.md)) or modify the spec/plan/tasks files mid-pause and resume.
- **The audit log.** The feed is a UI projection. The canonical record is the audit log (`audit.log`); the feed will show fewer fields, with one-line-per-event rendering instead of structured payloads.

## Common operator tasks

### "What is the current phase doing right now?"

The most recent block in the feed shows the active tool call. Look at the tool name and the (expandable) argument summary.

### "What did the implement phase do five minutes ago?"

Scroll up in the feed. Phases are demarcated by clear start/end boundaries; you can also click into a specific phase boundary to anchor the scroll.

### "Did the phase write the file I expected?"

Look for `Write` and `Edit` tool calls in the feed. The path argument is shown (sanitized — typically paths are preserved, but secrets in paths are scrubbed).

For deeper inspection, open the raw transcript at `.schegent/sessions/raw-<runId>.log` — it has the unredacted CLI scrollback.

### "Why is the phase taking so long?"

The feed surfaces `Bash` tool calls. A long-running test suite or build command will appear with its command line, and the next event will lag behind the start of that command.

The dashboard shows the runtime debug log alongside the feed; that log has stall-detection records (`monitor-stall`) that fire when no output has appeared for a configured threshold.

## Limits and behavior

- **Phase boundary granularity** — the feed shows events at the phase boundary level. The actual CLI stream is finer-grained; the feed projection drops events that are not operator-relevant.
- **One tail per host** — switching the selection tuple ends the previous tail. If you have two VS Code windows open against the same workspace, each has its own tail cap.
- **Read-only on secondary hosts** — multi-window operators can monitor a workspace from a second window but cannot pause/resume from there.
- **Truncation thresholds** — large tool-call arguments are truncated in the feed. The full unredacted value is available in the raw transcript.

The phase log feed is a window. The canonical record is `audit.log`; the deep debug is the raw transcript and the opt-in verbose diagnostics.

## Where the feed file lives

Internally, the host writes a manifest and event files per selection tuple under `.schegent/sessions/<runId>/phase-logs/...`. **You do not interact with these directly** — the IPC contract handles paths. The audit log records the selection tuple only, never a filesystem path; this is by design (the paths-free audit discipline).

If you want to inspect the raw bytes anyway, the raw transcript (`.schegent/sessions/raw-<runId>.log`) is the supported way to see the unsanitized stream.

Next: [Phase Breakpoints](phase-breakpoints.md) for intervening at phase boundaries.
