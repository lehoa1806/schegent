# Intervention Playbook

Sometimes a run does not need to be left alone. You see it going off-track, or you want to check the spec before plan starts, or a phase fails in a way that needs a manual fix. This page is the operator's playbook for intervening — when to use which control, and what trade-offs each carries.

## The intervention toolkit

| Control | Effect | When to use |
|---|---|---|
| **Pause** | Kills the in-flight subprocess; the run is paused, lock retained | "Stop now, I want to look" |
| **Set Breakpoint** | Run pauses *before* a specific phase | "Pause at a clean boundary, not mid-phase" |
| **Resume** | Resume a paused run with `--continue` | After a pause; continue where you left off |
| **Restart Active Phase** | Re-run the active phase from scratch | The phase produced bad state; start over |
| **Retry Active Run** | Bypass a scheduled delayed-retry; run now | Skip the rate-limit wait |
| **Cancel** | Terminate the run as failed; release the lock | "I do not want this run to continue at all" |
| **Pause Queue** | Stop the drainer; the in-flight task continues | "Let this finish, but stop accepting new ones" |
| **Edit pending task** | Modify description or per-phase overrides | "I want to change what is going to run" |
| **Reorder pending tasks** | Drag or arrow keys | "This task is more important; move it up" |

## Pause vs. Set Breakpoint

Both intervene at a phase boundary. They differ on **when**.

**Pause** is *aggressive*: the in-flight CLI subprocess is killed immediately. Mid-phase state may be inconsistent (a partial file write, a half-completed Bash command). When you resume, the model resumes its conversation; it may re-run an in-progress tool call.

**Breakpoint** is *clean*: the run reaches the configured phase boundary and pauses *before* the phase starts. No subprocess was killed mid-flight. The workspace is in a consistent state — every prior phase completed normally.

Use Pause when you need to stop *right now* (something is going wrong).

Use Breakpoint when you can wait for a clean phase boundary (planned inspection).

See [Aggressive Pause](../features/aggressive-pause.md) and [Phase Breakpoints](../features/phase-breakpoints.md).

## Resume vs. Restart Active Phase

After a pause:

**Resume** appends `--continue` to the next dispatch. The model picks up where it left off. The work-in-progress is preserved.

**Restart Active Phase** does *not* append `--continue`. The model starts the phase from scratch. Anything the model did in this phase (before the pause) is discarded.

Use Resume when the work-in-progress was on track and you just want to continue.

Use Restart when the work-in-progress was the problem (e.g., the model went down a bad path, you fixed the input files, now you want it to try again with the corrected inputs).

See [Context-Preserving Retries](../features/context-preserving-retries.md).

## Retry Active Run

If a delayed retry is scheduled (e.g., a rate-limit triggered a 60-minute wait), **Retry Active Run** bypasses the timer and runs the retry immediately. The retry uses `--continue` for context preservation.

Useful when:

- The rate-limit window has already reset (you happen to know).
- You want to test whether a different model would unblock the run (change the phase override first).
- You misjudged and a retry now would succeed.

If the rate-limit window has not actually reset, the manual retry likely fails again with another rate-limit response and another scheduled delay.

Audit event: `retry-manual`.

## Pause vs. Cancel

Pause **retains** the workspace lock. The run intends to resume.

Cancel **releases** the lock. The run is failed. The drainer can pick up the next pending task.

If you click Pause and then decide the run should not continue, click Cancel.

If you click Cancel by mistake, the run is genuinely terminated. To run the same task again, use **Rerun From History** on the failed entry.

## Pause Queue vs. Pause (task)

Pause Queue stops *new* tasks from starting. The in-flight task continues.

Pause (task) stops the *current* task. The queue is also cascade-paused so the next pending task does not start on top.

Use Pause Queue when the in-flight task is fine but you want to do other work without Schegent picking up the next task immediately.

Use Pause when you want to stop the in-flight task.

## Editing a pending task

Right-click a pending task → **Edit**. The dialog lets you change:

- The description.
- The pipeline id.
- The per-phase overrides.

Edits affect the pending task only. They do not affect the in-flight task (its pipeline snapshot is frozen).

Audit event: `task-modified`.

## Reordering pending tasks

Two methods:

1. **Drag and drop** the task row in the sidebar.
2. Use **Move Queued Item Up** / **Move Queued Item Down** commands (or arrow keys when a row is selected).

Both methods emit `task-reordered` with a `source` discriminator (`drag` or `arrow`). The host validates the new position; an invalid position is rejected and the audit log records the rejection cause.

## Mid-pause workspace edits

When a run is paused, the workspace is yours. You can:

- Edit any file — `spec.md`, `plan.md`, `tasks.md`, the source code itself.
- Run commands — tests, linters, builds.
- Make commits — though typically you let the run produce its own commit and you commit when satisfied.

The host does not track your mid-pause edits in the audit log. The Claude CLI will see the edited state when you resume (it re-reads the workspace at the start of the next phase, or when a tool call needs it).

This is by design. The pause is a hand-off; what you do during the pause is yours. The audit log records the pause and resume bounds.

## Common intervention scenarios

### "The spec looks wrong; I want to fix it before plan starts"

1. The run is in-flight, on `speckit-clarify` (or any phase before `speckit-plan`).
2. Set a breakpoint on `speckit-plan`. The run will pause before plan starts.
3. When the breakpoint fires, open `specs/<NNN-name>/spec.md` and edit.
4. Click Resume. The plan phase reads your edited spec.

### "Implement is going down a bad path"

1. The run is in-flight, on `speckit-implement`.
2. Click Pause. The CLI dies.
3. Inspect the files implement has written so far. Decide:
   - If the path is salvageable, fix the files and click Resume. The model picks up with `--continue`.
   - If the path is unsalvageable, fix the inputs (`tasks.md`, the relevant code) and click Restart Active Phase. The model starts fresh.

### "I need to add a feature mid-flight"

You cannot. The in-flight run's pipeline snapshot is frozen. To add a new feature task:

1. Enqueue the new feature. It lands at the bottom of pending.
2. (Optional) Drag it up if it should run before the next pending task.
3. The drainer will pick it up after the in-flight run terminates.

### "The CLI is rate-limited and I do not want to wait"

1. Audit log shows `monitor-rate-limited` and `retry-scheduled`.
2. You decide to:
   - Wait (the timer fires automatically).
   - Cancel (release the lock; run the task another time).
   - Switch models — open the per-run override surface, change `speckit-implement.model` to something with a different rate-limit pool, then Resume.

Changing the model mid-pause is a per-run override; it affects the in-flight run only.

### "The host crashed; the lock looks stuck"

1. **Reload Window** — the host re-reads `WorkflowRun` state on activation and reconciles.
2. If the sidebar still looks inconsistent, run **Reset Workspace State**. This clears the queue, runs, pause state. It does *not* delete `.schegent/audit.log` or the session tree.
3. After reset, you re-enqueue what you wanted to run.

### "Two windows are open; one is read-only"

Only the **primary host** can mutate state. The other window's sidebar shows the same data but every button rejects with `not-primary-host`.

To switch primary host: close the current primary window, then reload the other window. The first window to activate against an unowned workspace becomes the primary.

## What to log when you intervene

For your own future reference (the audit log records the mechanical action; it does not record *why*), consider:

- Note the reason in a workspace `intervention-log.md` if you frequently revisit the workspace.
- Annotate the failed task's description before rerunning (e.g., "retry with Opus after rate-limit at 14:32").
- For team workflows, capture the audit log range for the intervention in your tracking system.

The audit log's purpose is *evidence*, not *narrative*. The narrative is yours to keep.

## What you cannot intervene on

- **Mid-tool-call.** The granularity is the phase; you cannot pause between two tool calls within a phase.
- **The pipeline snapshot.** Once a run starts, its pipeline is frozen. Re-enqueue to change it.
- **The audit log.** Append-only. You cannot edit or delete entries.
- **Other workspaces.** Schegent's lock is per workspace; intervening here does not affect a different workspace.

The next operations page is [Troubleshooting](troubleshooting.md).
