# Multiple queues and concurrency

A workspace starts with one queue, id `default`. You can create up to **20**, name them, schedule them, pause them and delete them independently. This page is the operator runbook for that.

If you are looking for the model rather than the procedure, read [The Queue, Tasks, and Runs](../concepts/queue-and-runs.md) first.

## What "concurrent" does and does not mean today

Be clear about the boundary before you plan around it:

**Independent per queue** — pending lists and ordering, the in-flight slot, pause and resume, scheduled starts, lifecycle state, history, output and audit projections, and the drill-down UI. Pausing one queue leaves the others alone. A schedule armed on one queue fires without touching another.

**Not yet parallel** — the runs themselves. The run engine drives one `WorkflowRun` at a time, so a queue that has cleared every other gate waits for the executing run to finish before its own task starts. The drainer rotates its starting position between sweeps, so queues take turns rather than one queue winning every time.

So multiple queues buy you **separate inboxes with separate schedules and separate controls**, not more throughput. If you were sizing `schegent.queue.globalConcurrencyCap` expecting three Claude processes at once, size it for how many queues you want eligible instead.

The queue model is built for N concurrent runs; the run record (`KEYS.run`) and the run driver are still singular, which is what holds it to one. Lifting that is a separate change with its own schema version.

## Create a queue

1. Open the Schegent dashboard, **Queues**. This is the top tier: every queue, with its lifecycle badge, active run and pending count.
2. **New queue**, give it a name.
3. Click the queue's card to open its **Queue Detail** tier, and enqueue from the composer there. The composer is scoped to the queue you are looking at — there is no queue picker, because the tier you opened already said which one.

Names are trimmed and must be unique case-insensitively; ids are generated, and it is the id (never your name) that appears in the audit log. Positions stay contiguous, so deleting the queue at position 2 renumbers what followed it.

You cannot create the twenty-first queue. The attempt is refused, not silently clamped.

## Rename and pause

- **Rename** — from **Queue configuration** on the Queue Detail tier. Safe at any time, including while the queue is running; only the display name changes.
- **Pause** — from the queue's own controls on the Queue Detail tier. Stops that queue promoting anything new. A task already in flight keeps going; the queue simply does not take another. Other queues are untouched.

Both are mutating actions, so they work only in the primary window. Travelling between tiers is not a mutation and stays available in a secondary window.

## What has no dashboard control yet

Delete, set schedule, clear schedule, save queue settings and move-task-between-queues are reinstated end to end on the host — each is a validated IPC command with a handler, primary-window gated and audited — but no tier renders a control for them in this release. Practical consequences:

- A queue you create stays until a later release adds the delete control. Pause it if you are done with it.
- Per-queue scheduled starts are enforced everywhere they are described below, and nothing arms one from the dashboard today. The behaviour is live; the affordance is not.
- Move a task between queues by removing it from one and re-enqueueing it in the other.

## Scheduled starts (behaviour, not yet an affordance)

A queue with a scheduled start sits in the `idle-pending` lifecycle: it holds its pending tasks and deliberately does not auto-promote until its trigger fires or you start it by hand. Each queue's timer is independent — up to twenty may be armed at once, and firing or cancelling one leaves the rest armed.

The lockstep is strict: a queue either has both a scheduled start and the `idle-pending` lifecycle, or neither. You will never see one without the other.

## The concurrency ceiling

`schegent.queue.globalConcurrencyCap` bounds how many queues may hold a run at once. Default `3`, range `1..20`. See [settings reference](../reference/settings.md).

- Set it to `1` for the pre-multi-queue behaviour without deleting any queue.
- A value outside the range is refused, not clamped.
- Reaching the ceiling makes a queue **wait**, which is not an error: nothing is written, nothing is signalled, and the queue promotes as soon as a slot frees.

Distinguish the two waits when you are reading the UI. "This queue is busy" means its own single in-flight slot is taken. "Blocked" means the workspace ceiling is reached. Different causes, different fixes.

## Concurrent runs share one working tree

This is the important operational caveat, and it applies as soon as runs from different queues touch the same files — including runs that merely follow each other closely, since neither the queue nor the lease model isolates the filesystem.

**Schegent does not isolate the working tree per queue.** Every queue runs against the same checkout, the same branch, and the same `.schegent/` directory. Two tasks that edit the same files will interleave their edits, and **resolving that is your responsibility, not Schegent's**.

Practical guidance:

- Partition by area. Give each queue work that touches a different part of the tree.
- Do not put two tasks that both run migrations, both regenerate lockfiles, or both rewrite the same generated artifact on different queues.
- Branch-per-task workflows are still yours to drive. Schegent does not create, switch or merge branches on your behalf.
- If two queues must touch the same area, sequence them on one queue instead. That is what queues are for.

Audit and output are attributed per queue and per run, so after the fact you can always tell which run wrote what. That is attribution, not isolation — it tells you who did it, and does not stop it happening.

## Multiple VS Code windows

Unchanged by any of this: exactly one window is primary and may mutate; the others are read-only regardless of how many queues exist. If a queue in the primary window never promotes while its siblings do, another window is holding that queue's execution lease — see [The Workspace Lock](../concepts/workspace-lock.md).

## Upgrading from a single-queue workspace

Nothing to do. On first open, the existing `default` queue is lifted into the multi-queue registry with every pending task preserved verbatim and its schedule state carried across. Queues that existed before the single-queue collapse are *not* reconstructed — that information is not present in the persisted state, and inventing it would be a guess. See [Single-task queue migration](single-task-queue-migration.md) for the earlier step in this history.
