# Multiple queues and concurrency

A workspace starts with one queue, id `default`. You can create up to **20**, name them, schedule them, pause them and delete them independently. This page is the operator runbook for that.

If you are looking for the model rather than the procedure, read [The Queue, Tasks, and Runs](../concepts/queue-and-runs.md) first.

## What "concurrent" does and does not mean today

Be clear about the boundary before you plan around it:

**Independent per queue** — pending lists and ordering, the in-flight slot, pause and resume, scheduled starts, lifecycle state, history, output and audit projections, the drill-down UI, and — since feature 093 — **the run itself**. Pausing one queue leaves the others alone. A schedule armed on one queue fires without touching another.

**Genuinely parallel** — up to `schegent.queue.globalConcurrencyCap` runs execute at the same time, each with its own CLI process, its own phase progression, its own retry and backoff accounting, and its own record. A run that pauses, stalls, fails or is cancelled does not stall its siblings: they keep advancing through their phases. Each queue still runs **one** task at a time, so N concurrent runs means N different queues, never two runs on one queue.

So multiple queues now buy you **separate inboxes with separate schedules, separate controls, and real throughput**. Size `schegent.queue.globalConcurrencyCap` for how many Claude processes you actually want against this machine and this working tree — it is a ceiling on concurrent runs, not on eligible queues.

Two things are still shared, and they are why the cap exists at all: **one working tree** and **one window**. Read [Concurrent runs share one working tree](#concurrent-runs-share-one-working-tree) and [Recovery checkpoints are declined while runs are concurrent](#recovery-checkpoints-are-declined-while-runs-are-concurrent) before you raise the cap.

Earlier releases refused the second start outright — the run record held exactly one run, so a second one would have clobbered it. Feature 093 replaced that record with one entry per queue (state schema v11) and removed the refusal. If you are upgrading, nothing to do; see [Upgrading from a single-queue workspace](#upgrading-from-a-single-queue-workspace).

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

## Delete, move, and the workspace settings

Feature 092 reinstated delete, set schedule, clear schedule, save queue settings and move-task-between-queues end to end on the host, but shipped no control for any of them. Feature 095 added the controls. Feature 097 removed the schedule ones again — set schedule and clear schedule are fully deregistered, not merely hidden — leaving:

| Action | Control | Tier |
|---|---|---|
| Delete a queue | **Delete Queue** | Queue Detail |
| Move a pending task to another queue | **Move to…**, beside the task row | Queue Detail |
| Concurrency cap and default queue | **Queue Settings** | Queues |

Three things to know before you use them:

- **Delete confirms first, and the default queue is exempt.** On the default queue the control stays visible and disabled with the reason attached — deleting the queue every unrouted task lands on has no coherent outcome. Make another queue the default from **Queue Settings**, and the control enables.
- **Only a pending task moves.** A task that has started is executing against its queue's lease and a finished task is a record, so **Move to…** appears on pending rows only.
- **The two workspace settings are not on Queue Detail, deliberately.** The concurrency cap and the default queue belong to the workspace, not to whichever queue you happen to be looking at, so they sit behind **Queue Settings** on the Queues tier. Both save in one write. The cap's range is the host's rule, not the field's: a value outside `1..20` travels, is refused, and the refusal is shown — it is never silently clamped as you type.

All of these are mutating actions, so they work only in the primary window.

## Scheduled starts

One mechanism starts a queue at a time you choose: **lifecycle scheduled start**. Choose a start mode when you start a queue, and the queue moves into the `idle-pending` lifecycle: it holds its pending tasks and deliberately does not auto-promote until its trigger fires or you start it by hand. This is the one the lifecycle badge reports, and the one the rest of this page means by `idle-pending`.

The lockstep is strict, and it is per queue: a queue either has both a scheduled start and the `idle-pending` lifecycle, or neither. You will never see one without the other, and one queue's armed start says nothing about another's lifecycle.

Each queue's timer is its own — up to twenty queues may be armed at once, and firing or clearing one leaves the rest armed.

Feature 097 removed the second, independent **queue schedule** mechanism (the registry-stored expression armed from a schedule field on Queue Detail, with its own Arm/Re-arm/Disarm controls). It did not share the `idle-pending` lockstep above and could sit alongside it unrelated; that surface is gone, and lifecycle scheduled start is now the only way to arm a future start.

## The concurrency ceiling

`schegent.queue.globalConcurrencyCap` bounds how many runs may **execute at once** across the workspace. Default `3`, range `1..20`. See [settings reference](../reference/settings.md).

- Set it to `1` for single-run behaviour without deleting any queue. At `1` the whole lifecycle — start, streaming, pause, resume, retry, breakpoint, cancel — is indistinguishable from the pre-093 behaviour.
- A value outside the range is refused, not clamped.
- Reaching the ceiling makes a queue **wait**, which is not an error: nothing is written, nothing is signalled, and the queue promotes as soon as a slot frees.
- **Lowering the cap below the number of runs already executing terminates nothing.** The cap gates starts only; it never revokes. The excess drains as those runs finish.
- **A paused run keeps its slot.** Pausing does not free capacity for a fourth queue, and resuming a paused run is never refused for want of a slot — the slot was never given up. If you want the capacity back, cancel the run rather than pausing it.

Distinguish the two waits when you are reading the UI. "This queue is busy" means its own single in-flight slot is taken — that queue's own task is running. "Blocked" means the workspace ceiling is reached and some *other* queue holds the slot. Different causes, different fixes.

Sizing guidance: each concurrent run is a CLI process with its own token spend and its own share of the machine, and all of them write into one working tree. Three is the default because it is a useful amount of parallelism at a manageable rate of file contention; going much higher is a decision about your rate limits and your tolerance for the caveat below, not about how many queues you have.

## The status bar with several runs

The window has one status bar and, now, several runs, so the bar summarizes instead of showing whichever run reported last:

- **One run (or none)** — exactly what it always showed: `schegent: <phase> [3/12]`, `schegent: paused (next poll 14:05)`, `schegent: queue 4`, and so on. Nothing about the single-run case changed.
- **Several runs in the same state** — a count: `schegent: 2 runs`, `schegent: 3 stalled`, `schegent: 2 paused`.
- **Several runs in different states** — the most urgent one leads. `running` outranks `stalled`, which outranks `paused`, and the count is of the runs sharing the leading state.
- **The tooltip** carries one line per live run, each with its phase and iteration. Hover it when the headline count is not enough.

The bar never names a queue. It is a summary surface and deliberately carries no operator-authored names; the sidebar is where you identify which queue is which.

## Recovery checkpoints are declined while runs are concurrent

A recovery checkpoint is a `git diff HEAD` of the one working tree. With two runs in flight that diff necessarily contains the sibling's in-progress edits, so applying it later would revert work that had nothing to do with the run being restored. Rather than write a snapshot that is unsafe to use, Schegent **declines** it:

- No `.patch` is written, so there is nothing to restore by mistake.
- A `<timestamp>-<phase>.declined.json` marker is written next to where the snapshot would have gone, recording `runId`, `phaseId`, `declinedAt`, `inFlightRuns`, `restorable: false`, and the reason `concurrent-runs-share-one-worktree`.
- The runtime log gets a matching warning.
- The run is **not** blocked. A declined checkpoint is not a failed one; the Git-capable phase proceeds. (A genuinely failed snapshot still blocks its phase — that behaviour is unchanged.)

So: checkpoints are available when one run is executing, and are recorded-but-declined whenever a second run is live. If you are about to do something you expect to want to revert, run it at cap `1`, or on a workspace where it is the only live run. See [Recovery checkpoints](recovery-checkpoints.md).

## Concurrent runs share one working tree

This is the important operational caveat, and feature 093 sharpened it. Before, two runs could only interleave *between* phases because only one executed at a time; now they interleave *within* a phase, while both are editing. It applies to any two runs that touch the same files, since neither the queue nor the lease model isolates the filesystem.

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

Feature 093 adds a second forward-only step (state schema v10 → v11) on the same terms, this time to the run record. Also nothing to do:

- A run that was in flight when you last closed the window is re-keyed under the queue its task belongs to, and continues to be addressable exactly as before.
- A workspace that had no run gets no run invented for it.
- A run whose task is no longer in any queue is **reassigned** to `default` rather than dropped, and the reassignment is recorded in the audit log (`run-reassigned-to-default-queue`).
- Queue state is untouched by this step, and re-opening the workspace migrates nothing a second time.

The upgrade is one write, and it is not reversible: an older Schegent will not read a v11 workspace.
