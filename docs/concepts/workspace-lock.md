# The Workspace Lock

The workspace lock is the smallest, most important piece of state in Schegent. It guarantees that **at most one run is executing in a workspace at any moment**, even if multiple VS Code windows are open or the extension is reloading. Most of the time you do not need to think about it; this page explains it so you know what to do when something looks stuck.

## What the lock protects

The lock guards the workspace as a single, shared resource. While the lock is held, the workspace is "owned" by exactly one logical session of Schegent. The owner can:

- Spawn the Claude CLI subprocess.
- Write to `.schegent/audit.log`.
- Write to the per-run session tree under `.schegent/sessions/<runId>/`.
- Mutate `WorkflowRun` state.

While the lock is held, **a second run cannot start in the same workspace**. The queue drainer sees the lock as held and waits.

## When the lock is acquired and released

The lock is acquired exactly once per run, at the moment a task transitions from `pending` to `in-flight`. It is released:

- when the run terminates successfully (reaches `done` and emits `feature-request-completed`), or
- when the run terminates with failure (a fatal signature, a watchdog timeout, an unrecoverable error), or
- when the operator cancels the run.

A `finally`-guarded wrapper around every entry point ensures the release runs even when an exception unwinds the stack. This is the most defensively-coded surface in the extension.

## What happens when you pause a run

Pausing is the interesting case. A paused run is *not running* — no subprocess is alive — but it *intends to resume*. If the lock released on every pause, a second task could slip in and start a competing run; when the operator clicks Resume on the paused task, it would race the second task for the lock.

To prevent that, paused runs **retain** the lock. The implementation looks like this conceptually:

1. The operator clicks Pause.
2. The host writes the pause state to `WorkflowRun` (`manualPauseAt`, `manualPauseCause`).
3. The host kills the active subprocess.
4. The host *calls `session.retain()`* — explicit intent to hold the lock past the current scope.
5. The lock-wrapper's `finally` block sees the retain and **does not release**.

When the operator clicks Resume, the new dispatch claims ownership of the already-held lock (idempotent for the same owner). When the resumed run finally terminates, the lock is released normally.

This is why **a paused task is not a free queue slot**. The queue can drain *other* pending tasks past a paused one only when the lock is genuinely free — which it is for tasks paused via the queue-paused projection, but not for tasks paused via `manually-paused-task` or `breakpoint-paused`.

## What happens during a crash or reload

If VS Code crashes, the extension host dies, or you reload the window while a run is mid-flight, the in-memory lock state vanishes. On the next activation the extension:

1. Re-reads the persisted `WorkflowRun` state from `workspaceState`.
2. If a run is recorded as `in-flight` but has no live subprocess (which is always the case after a reload), the run is recovered into a paused or failed terminal state, depending on its last-known phase outcome.
3. The lock is conceptually free; the drainer can pick up the next pending task or surface the recovered task for operator decision.

You do not have to clear anything by hand after a reload. The recovery path is deterministic.

## What happens with multiple VS Code windows

Schegent's lock is *per workspace*, not per host. If you open the same workspace folder in two VS Code windows:

- Only the **primary host** can mutate state. The other window is read-only for all mutating IPC commands.
- The lock is owned by the primary host. The secondary host's drainer is a no-op.
- You can switch primary host by reloading the windows in order — the first window to activate against an unowned workspace becomes the primary.

Trying to enqueue a task or click Resume in a secondary window surfaces a "not primary host" rejection in the audit log. The UI reflects the read-only state.

## When the lock looks stuck

There are three failure modes that look like a stuck lock from the outside:

### 1. A run is paused and you forgot

The most common cause. The lock is genuinely held — by a run that is *intentionally* not progressing. The sidebar shows the paused state; the audit log shows the pause cause. Resume the run or cancel it to release the lock.

### 2. The audit log shows a run that the sidebar does not

This means the persisted `WorkflowRun` is out of sync with the runtime projection. Almost always caused by a partial activation (extension reloaded mid-startup). Run **Reload Window** in VS Code; on reactivation the recovery path will reconcile the state.

### 3. The reset command

In the worst case — for example, after a hard crash that left state in a genuinely inconsistent shape — the **Reset Workspace State** command (`schegent.reset`) clears the persisted runtime state for the workspace. This is a destructive operation:

- It does *not* delete `.schegent/audit.log` or the per-run session tree.
- It *does* clear the queue, all `WorkflowRun` records, all pause/breakpoint state, and any pending-retry schedule.
- It re-runs the v2 → v6 migration sequence against the cleared state.

Use it only when reload-window has not helped. The audit log preserves every event up to the reset; you can always reconstruct what was in the queue if you need to.

## The retain-vs-release matrix

For internal reference and to set your expectations, here is the matrix of when the lock retains versus releases:

| Run terminal event | Lock behavior |
|---|---|
| Run reaches `done` cleanly | release |
| Run fails (fatal signature, watchdog, unrecoverable error) | release |
| Operator cancels the run | release |
| Operator pauses the task (`manually-paused-task`) | retain |
| Phase boundary pause (`phase-paused`) | retain |
| Breakpoint fires (`breakpoint-paused`) | retain |
| Queue paused while task is in-flight (`queue-paused-mid-run`) | retain |
| Rate-limit delayed retry scheduled | retain |
| Extension deactivation while run is in-flight | release (with crash-recovery on next activation) |

If you ever see a release where this matrix predicts a retain, the run will lose its claim to the lock and another task might run before the operator clicks Resume. Report it — that is a bug.

The next page, [Sessions, Logs, and Audit Evidence](sessions-and-logs.md), explains the on-disk records that survive across runs and across the lock lifecycle.
