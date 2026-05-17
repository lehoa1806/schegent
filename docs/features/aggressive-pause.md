# Aggressive Pause

When you click **Pause** on an in-flight task, Schegent does not wait for the current phase to finish. The host **immediately kills the active CLI subprocess** so the workspace returns to your control as fast as possible. This is called *aggressive pause*.

## What aggressive pause does

The sequence when you click Pause:

1. The host writes the pause state to `WorkflowRun` (`manualPauseAt`, `manualPauseCause: 'manually-paused-task'`).
2. The host **kills** the active CLI subprocess immediately (SIGTERM, then SIGKILL if needed).
3. The host emits a `phase-pause-requested` audit event.
4. The host emits `phase-paused`.
5. The workspace lock is **retained** (paused runs hold the lock — see [The Workspace Lock](../concepts/workspace-lock.md)).

The order is precise:

- The persisted pause-state write happens **before** the kill so the post-kill cleanup sees consistent state.
- The kill happens **before** the audit emission so the audit event reflects an actually-paused state.

## Why aggressive

A cooperative pause — waiting for the phase to reach a clean boundary before stopping — would mean:

- A long `speckit-implement` phase running a 10-minute build would have to finish that build before pausing.
- An infinitely-looping or stuck phase would never pause.
- The operator's "stop the world" intent would not be honored.

Aggressive pause prioritizes the operator. If you say Pause, the workspace is yours within a few hundred milliseconds. Any in-progress tool call dies with the subprocess.

## What happens to in-flight tool calls

The Claude CLI is mid-thought when the kill arrives:

- A `Bash` tool call may have a child process running. SIGTERM to the CLI propagates to its child; the child is killed.
- A `Write` or `Edit` tool call may have partially written a file. If the write completed before the kill, the file is on disk; if not, the file may be empty, truncated, or absent.
- An `Read` or `Grep` tool call typically completes quickly and is in-flight only briefly.

There is no way to know from the audit log alone which exact byte the CLI was processing when the kill landed. The raw transcript (`.schegent/sessions/raw-<runId>.log`) has the unredacted scrollback up to the kill point.

## Resume after an aggressive pause

When you click **Resume**, the controller dispatches with `nextDispatchIsContinue = true` and the runner spawns the CLI with `-c`. The Claude CLI resumes its prior conversation; the model picks up where it left off.

The model is **not** told that a kill happened. From its perspective, the conversation simply has a gap. If a tool call was mid-flight when the kill landed, the model may try to re-run it. Most of the time this is harmless (the tool call is idempotent or repeatable). Occasionally it produces a small redundancy.

See [Context-Preserving Retries](context-preserving-retries.md) for the dispatch matrix.

## The cascade-pause guarantee

Aggressive pause also triggers a **cascade pause** of the queue. From the queue's perspective:

1. The in-flight task transitions to paused.
2. The drainer would normally pick up the next pending task.
3. But the host queue is now paused with `pauseSource: 'cascade'` to prevent the next task from starting on top of the paused one's lock.

When you click Resume, the queue's cascade pause clears automatically (`pauseSource: 'cascade'` is a strict no-op when the operator initiates the resume).

If the operator had **separately** paused the queue with `pauseSource: 'operator'` before clicking Pause on the task, that pause survives. A `cascadedResume()` call against an operator-paused queue is a no-op.

## What aggressive pause is *not*

- **Not graceful.** No phase boundary is reached. No "finish writing the file" courtesy.
- **Not undoable mid-pause.** Once the kill is sent, you cannot "un-pause" back to a live subprocess. To continue, click Resume; the CLI re-spawns.
- **Not a cancel.** A pause retains the workspace lock and intends to resume. To cancel, click **Cancel** instead — that releases the lock and terminates the run as failed.
- **Not silent.** The audit log records `phase-pause-requested` and `phase-paused`. The sidebar updates to show the paused state.

## When aggressive pause is the right choice

Almost always:

- You want to inspect the workspace mid-run.
- You see something going wrong and want to stop immediately.
- You need to make a hand-edit between phases (use a [Phase Breakpoint](phase-breakpoints.md) for that ideally — it pauses *before* a phase rather than killing mid-phase).

When aggressive pause is the wrong choice:

- You only want to **pause future work** but let the current phase finish — use **Pause Queue** (`schegent.pauseQueue`) instead. The queue pause prevents the *next* task from starting; the in-flight task continues normally.

## Audit-log surface

Three events trace an operator-initiated pause:

- `phase-pause-requested` — operator clicked Pause. Logged before the kill so the request itself is captured.
- `phase-paused` — the run is now persisted as paused. Emitted after the kill and the state write.
- `queue-paused` with `pauseSource: 'cascade'` — the queue cascade fired.

When you resume:

- `phase-resumed` — operator clicked Resume.
- `queue-resumed` — the cascade pause clears.

## The cancel alternative

If you want the run to terminate rather than resume later, click **Cancel**:

1. The host kills the active subprocess (same aggressive kill).
2. The host writes the task as failed with `cause: canceled`.
3. The host releases the workspace lock.
4. The drainer is free to pick up the next pending task.

Audit events: `cancel` (lifecycle) and `task-canceled` (queue control).

Cancel is the right choice when you have decided the run should not continue.

## Limits

- **No granular pause.** You cannot pause between two tool calls within a phase. The granularity is "kill the subprocess".
- **No "soft pause" mode.** There is no setting to make pause cooperative. The design choice is operator-responsive over graceful.
- **No pause for non-CLI phases.** All phases today are CLI phases; this is not a current concern.

The next feature is [Telemetry Projection](telemetry-projection.md).
