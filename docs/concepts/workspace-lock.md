# The Workspace Lock

The workspace lock is the smallest, most important piece of state in Schegent. Most of the time you do not need to think about it; this page explains it so you know what to do when something looks stuck.

Since multiple queues arrived, there are **two** leases, not one. They answer different questions and they are independent of each other:

| | Window-primacy lease | Execution lease |
|---|---|---|
| Question it answers | Which VS Code window may mutate this workspace? | Which window is draining *this queue*? |
| Scope | One per workspace | One per queue |
| Concurrent holders | Exactly one | One per queue, several across queues |
| What you see when you lose it | The sidebar goes read-only | Nothing; that queue is drained elsewhere |
| Heartbeat / staleness | 5 s / 15 s | 5 s / 15 s |

Losing primacy does not release an execution lease, and holding an execution lease does not make a window primary. That separation is the whole point: draining a queue must never be a route to becoming the window that owns the workspace.

## What the leases protect

The **window-primacy lease** guards the workspace as a single, shared resource. While a window holds it, that window is the only one that may:

- Spawn the Claude CLI subprocess.
- Write to `.schegent/audit.log`.
- Write to the per-run session tree under `.schegent/sessions/<runId>/`.
- Mutate `WorkflowRun` state, the queue registry, or settings.

The **execution lease** guards one queue's turn. A queue with a live lease held by another window is not drained here — the drainer treats it as "someone else has this one" and moves on to the next queue.

Two runs *do* execute at once, and neither lease is what bounds how many. The execution lease decides **which window** drives a given queue, not how many queues one window may drive; the ceiling on simultaneous runs is `schegent.queue.globalConcurrencyCap`, checked by the drainer before it claims a lease. Feature 093 removed the engine-level refusal that used to hold the workspace to one run regardless of the cap. See [Multiple queues and concurrency](../operations/multi-queue-concurrency.md#what-concurrent-does-and-does-not-mean-today).

## When the leases are acquired and released

The **execution lease** for a queue is claimed by the drainer at the moment that queue promotes a task to in-flight, and released when that task's run reaches a terminal state — `completed`, `failed`, or `canceled`. A *paused* run keeps its queue's lease, because it intends to resume on the same queue. Window shutdown and the 15-second staleness reclaim are still there, but as backstops for a window that died, not as the ordinary way a lease ends.

The **window-primacy lease** is claimed once, on activation, and released once, at disposal. Nothing a run does opens or closes it. A window is primary for as long as it is open.

That second tenure is worth stating plainly because it used to be otherwise: primacy was re-claimed and released around each run, which was indistinguishable from the truth while a window could only ever have one run. With several runs in one window it was not — the first run to finish released primacy for all of them, and the window went read-only while it was still working, with another window free to claim the workspace underneath it. Feature 092 removed the run-scoped wrapper that did the releasing; feature 093 removed the last few releases the wrapper had left behind.

## What happens when you pause a run

Pausing is the interesting case. A paused run is *not running* — no subprocess is alive — but it *intends to resume*.

Primacy is not affected: it belongs to the window, and the window is still open. What a paused run holds is its **queue**. The execution lease is released at a terminal transition, and `paused` is not one — deliberately, and not by accident of how the check is written. "Terminal" is spelled out as `completed`, `failed`, or `canceled` rather than derived from "not running", because the second phrasing also catches `paused` and would hand the queue away from a run that means to come back to it.

So a paused run keeps three things until it resumes or is canceled: its queue's execution lease, its slot under the concurrency cap, and its session. Its *subprocess* is gone the moment you pause — that is the resource pausing frees. Other queues are unaffected either way.

When the operator clicks Resume, the run continues on the lease it never gave up. When it finally terminates, all three are released together.

## What happens during a crash or reload

If VS Code crashes, the extension host dies, or you reload the window while a run is mid-flight, the in-memory lease state vanishes. On the next activation the extension:

1. Re-reads the persisted `WorkflowRun` state from `workspaceState`.
2. Primacy is reclaimed by the activating window. Any execution lease the dead window left behind goes stale 15 seconds after its last heartbeat and is reclaimable from then on, so a crash cannot strand a queue permanently.
3. **Every run still recorded as executing is resumed, not failed.** Once primacy is acquired, the activating window walks the per-queue run record and re-drives each such run from its last-known phase. A window that crashed mid-concurrency persisted several runs, and each is re-armed on the queue that owns it. Separately, a run holding a pending delayed-retry deadline has its watchdog re-armed — or resumes immediately if the deadline already elapsed.

If primacy is *not* acquired — another window holds it — nothing is resumed here. The runs stay as persisted and the primary window owns them.

You do not have to clear anything by hand after a reload. The recovery path is deterministic. What it is not is a stop: reloading the window does not pause your work, and a run that was executing before the reload will be executing again shortly after it. Use Pause if that is what you want.

## What happens with multiple VS Code windows

Primacy is *per workspace*, not per host. If you open the same workspace folder in two VS Code windows:

- Only the **primary host** can mutate state. The other window is read-only for all mutating IPC commands, no matter how many queues or runs exist.
- The primacy lease is owned by the primary host. The secondary host's drainer is a no-op.
- You can switch primary host by reloading the windows in order — the first window to activate against an unowned workspace becomes the primary.

Trying to enqueue a task or click Resume in a secondary window surfaces a "not primary host" rejection in the audit log. The UI reflects the read-only state.

One caveat worth knowing if you habitually keep two windows open on the same workspace: primacy goes to whichever window activates first against an unowned workspace, and it keeps it until it closes. Runs finishing do not open a gap for the second window to slip into — that used to be exactly what happened, and it was a bug, not a handover mechanism. If the wrong window is primary, close it and **reload** the one you want: primacy is claimed at activation and nowhere else, so a window that started out secondary stays secondary until it activates again.

## Multi-root workspaces

Schegent treats the **first folder** in the active `.code-workspace` file as the **canonical workspace folder**. Concretely:

- The lock, the `.schegent/` directory, the audit log, and the per-run session tree all live under the first folder.
- Other folders in the workspace are ordinary VS Code roots — Claude can still read and edit files in them like any other open folder — but Schegent itself does not create state in them.
- The queue, run history, pause/breakpoint state, and watchdog are scoped to the canonical folder. Reordering folders mid-session does **not** migrate state and does **not** re-trigger the canonical selection — the chosen folder stays the canonical one for the lifetime of the window.

When you activate Schegent against a multi-root workspace, you will see a one-shot informational toast naming the canonical folder. This is intentional — it ensures the chosen folder is explicit rather than implicit.

### Suppressing the multi-root warning

If you regularly work in multi-root workspaces and already know which folder Schegent activates against, set:

```jsonc
// .code-workspace, in the "settings" object
{
  "settings": {
    "schegent.multiRoot.suppressWarning": true
  }
}
```

The setting is window-scope, so the choice only applies to that specific workspace file.

When the warning is suppressed, Schegent also stops emitting the corresponding `multi-root.warning-shown` audit event — the event represents an actually-shown warning, not a hypothetical one. The canonical-folder selection itself is unaffected; it is purely cosmetic.

### v1 limitations

- There is no operator-chosen canonical folder. The first folder in the `.code-workspace` wins.
- There are no per-folder queues, run histories, or pause states — those are scoped to the canonical folder.
- Adding or reordering folders mid-session does not re-fire the warning or change the canonical selection; close and reopen the window to surface a fresh activation.

Per-folder state (independent queues, independent canonical folders, operator-selectable canonical roots) is tracked for a future release.

## When the lock looks stuck

There are three failure modes that look like a stuck lock from the outside:

### 1. A run is paused and you forgot

The most common cause. The queue is genuinely held — by a run that is *intentionally* not progressing, and which is also still occupying a slot under the concurrency cap. The sidebar shows the paused state; the audit log shows the pause cause. Resume the run or cancel it to free both.

### 2. The audit log shows a run that the sidebar does not

This means the persisted `WorkflowRun` is out of sync with the runtime projection. Almost always caused by a partial activation (extension reloaded mid-startup). Run **Reload Window** in VS Code; on reactivation the recovery path will reconcile the state.

### 3. The reset command

In the worst case — for example, after a hard crash that left state in a genuinely inconsistent shape — the **Reset Workspace State** command (`schegent.reset`) clears the persisted runtime state for the workspace. This is a destructive operation:

- It does *not* delete `.schegent/audit.log` or the per-run session tree.
- It *does* clear the queue, all `WorkflowRun` records, all pause/breakpoint state, and any pending-retry schedule.
- It re-runs the forward-only migration sequence (currently up to v11) against the cleared state.

Use it only when reload-window has not helped. The audit log preserves every event up to the reset; you can always reconstruct what was in the queue if you need to.

## The retain-vs-release matrix

For internal reference and to set your expectations, here is the matrix of when a run's **execution lease** — its claim on its queue — is kept versus given back. The primacy lease is not in this table, and that is the point: no row of it would ever say anything but "retain", because primacy is the window's for as long as the window is open.

| Run event | Execution-lease behavior |
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
| The run's task row was deleted underneath it | release nothing — see below |

The last row is the one exception, and it is a deliberate refusal rather than an oversight. The lease is released by looking up which queue the run's task belongs to. If that task row is gone, there is no answer, and every run in one window shares the same owner identity — so a guessed queue would pass the ownership check and release some *other* run's live lease. The window holds the orphaned lease until it closes, or 15 seconds after it dies.

If you ever see a release where this matrix predicts a retain, a queue has been handed away from a run that still intends to use it. Report it — that is a bug. The reverse — a retain where the matrix predicts a release — is the one that used to happen: the lease outlived its run entirely, and only the 15-second staleness reclaim ever ended it.

## When the lock looks stuck: which one is it?

The two leases fail differently, so the symptom tells you which one to look at:

- **The sidebar is read-only and says another window is primary.** That is the primacy lease. Close the other window, or reload this one after the other releases.
- **One queue never promotes while other queues do.** That is that queue's execution lease, held by another window. It clears when that window's run on it finishes, when that window closes, or 15 seconds after it dies.
- **Every remaining queue waits while `cap` runs are executing.** That is neither lease — that is `schegent.queue.globalConcurrencyCap`, working as configured. Raise it, or wait for a slot. Remember a paused run still holds its slot.

The next page, [Sessions, Logs, and Audit Evidence](sessions-and-logs.md), explains the on-disk records that survive across runs and across the lock lifecycle.
