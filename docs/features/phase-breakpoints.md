# Phase Breakpoints

A phase breakpoint pauses an in-flight run **before** a specific phase begins. Use breakpoints when you want to inspect or modify the generated artefacts (spec, plan, tasks, code) between phases, or hand-edit something before the next phase reads it.

## When to use a breakpoint

Common scenarios:

- **Review the spec before plan.** Set a breakpoint on `speckit-plan`. When the run completes `speckit-specify` and `speckit-clarify`, it pauses. You read `spec.md`, make tweaks, and resume.
- **Approve the task list before implementation.** Set a breakpoint on `speckit-implement`. The run pauses after `speckit-tasks`; you review `tasks.md` and adjust before the long implement phase starts.
- **Sandbox the final verification.** Set a breakpoint on `finalize`. The run pauses with all code written but not yet verified; you run your own tests, make manual changes, then resume.

A breakpoint is **per run**. It does not affect future enqueued tasks.

## How to set a breakpoint

Two paths:

### From the sidebar

1. Find the in-flight task.
2. Click **Set Breakpoint** in the phase log feed controls.
3. A list of upcoming phases appears. Pick one.
4. The breakpoint is now armed. The audit log records a `phase-breakpoint-set` event.

You can also set a breakpoint from the **dashboard** — same control, same effect.

### From the command palette

There is no first-class command palette entry today. Use the sidebar.

## What happens when the breakpoint fires

When the run reaches the breakpoint:

1. The runner detects the armed breakpoint at the entry of the phase.
2. The runner emits `phase-breakpoint-fired` with the run id, phase id, pipeline id, and iteration number.
3. The runner returns without spawning the CLI subprocess.
4. The workflow controller transitions the run to **paused** with `manualPauseCause: 'breakpoint-paused'` and `resumeTargetPhaseId` set to the breakpoint phase.
5. The workspace lock is **retained** (paused runs hold the lock — see [The Workspace Lock](../concepts/workspace-lock.md)).
6. The sidebar shows the task as Paused with the cause "Breakpoint".

The breakpoint is then **consumed** — `phase-breakpoint-cleared` is emitted with `cause: 'consumed-by-fire'`. A subsequent resume will run the breakpoint phase normally; you do not need to clear it manually.

## How to resume past a breakpoint

Click **Resume** on the paused task. The run picks up at the breakpoint phase. The next dispatch arms `--continue`, so Claude resumes its prior context across the pause boundary.

If you decide *not* to run that phase at all, you have two options:

- **Cancel** — the run terminates as failed (`canceled`). The workspace lock is released.
- **Skip** — open the phase override surface and disable the phase before resuming. The runner advances past the disabled phase. `phase-disabled` is recorded; `phase-skipped` fires when the runner advances.

## How to clear a breakpoint without firing it

You may want to remove an armed breakpoint without pausing — for example, you changed your mind, or you discovered the phase has already passed.

- Open the breakpoint surface in the sidebar.
- Click **Clear Breakpoint**.

The audit log records `phase-breakpoint-cleared` with `cause: 'operator'`.

A breakpoint also clears automatically when:

- The breakpoint phase fires the breakpoint (`cause: 'consumed-by-fire'`).
- The operator applies a per-run phase override that disables the breakpoint phase (`cause: 'override-applied'`).
- The run ends (`cause: 'run-ended'`).

## Multiple breakpoints

You can set breakpoints on multiple phases in the same run. They are persisted as a set on `WorkflowRun.phaseBreakpoints`. Each breakpoint fires independently when its phase begins.

## What you can do while paused at a breakpoint

The pause is **aggressive**: there is no live subprocess. The workspace is yours.

Common operations:

- **Edit files** — modify the spec, plan, tasks, or implementation code.
- **Run commands** — execute tests, build the project, inspect the diff.
- **Read the audit log** — `Cmd/Ctrl + Shift + P` → "Schegent: Show Audit Log".
- **Read the raw transcript** — open `.schegent/sessions/raw-<runId>.log` in an editor for the unredacted scrollback.
- **Reorder pending tasks** — the queue is still active; you can drag other tasks around. But the in-flight task holds the lock, so no other task starts.

What you **cannot** do:

- Run a second feature concurrently — the workspace lock is held by the paused run.
- Edit the in-flight run's *pipeline snapshot* — that is frozen at run start.

## Audit-log surface

Three event types form the breakpoint surface:

- `phase-breakpoint-set` — armed. Payload: `runId`, `phaseId`, `actor` (`'operator'` | `'system'`).
- `phase-breakpoint-cleared` — cleared. Payload includes `cause`: `operator`, `consumed-by-fire`, `override-applied`, `run-ended`.
- `phase-breakpoint-fired` — fired (the paused state was reached). Payload: `runId`, `phaseId`, `pipelineId`, `iterationN`.

The `pauseSource` cascade rules from queue/phase interactions still apply: a breakpoint pause persists past a queue pause/resume, because the queue pause cascade is a no-op on operator-initiated pauses.

## State invariants

A few invariants the host enforces:

- `manualPauseCause === 'breakpoint-paused'` if and only if `resumeTargetPhaseId !== null`. Neither half can exist without the other.
- A breakpoint can be armed for any phase id that appears in the run's frozen pipeline snapshot. Phases not in the snapshot cannot be set as targets.
- The breakpoint setter is recorded as `actor: 'operator'` for operator-set breakpoints; `actor: 'system'` exists for forward compatibility but is not used today.

These invariants exist so that paused runs reload cleanly across an extension reload. If the persisted state somehow violates them, the v6 state migration on activation rejects the run (or migrates it to a valid shape, depending on the discrepancy).

## What breakpoints do *not* let you do

- **Step inside a phase.** Breakpoints are phase-boundary granular. You cannot pause between two tool calls within the same phase.
- **Modify the phase argv.** The breakpoint pauses *before* the phase starts; the phase will run with the same argv composition it would have run anyway. To change the model, effort, or other CLI parameters, use [Phase Overrides](phase-overrides.md) **before** the run starts (or, per-run, via the override surface).
- **Re-target the pipeline.** The pipeline snapshot is frozen on `WorkflowRun.pipeline` at the moment the task transitioned to in-flight. Editing a phase or pipeline definition while paused has no effect on the in-flight run; it will take effect on the *next* enqueue.

The next feature page is [Phase Overrides](phase-overrides.md).
