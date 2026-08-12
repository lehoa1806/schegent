# The Queue, Tasks, and Runs

Schegent processes work through a single queue. You add tasks; the queue drains them one at a time; each task that runs becomes a *run*. This page defines those terms precisely and explains the rules that govern scheduling.

## Three terms you will read everywhere

| Term | What it is | Where it lives |
|---|---|---|
| **Task** (a.k.a. **feature request**) | A line of work you want done. Carries a description, a pipeline reference, optional phase overrides, and a state (`pending`, `in-flight`, `paused`, `failed`, `completed`). | The queue, in `workspaceState`. |
| **Run** (a.k.a. **`WorkflowRun`**) | A single execution attempt of a task. Captures the frozen pipeline snapshot, current phase, phase outcomes, pause state, and audit cross-references. | One per task that ever became `in-flight`, attached to the task. |
| **Phase** | One invocation of the Claude CLI subprocess for one named phase of the pipeline. | A row of state inside the active run. |

A task that never makes it past `pending` has zero runs. A task that you cancel mid-run has one run with a terminal failure. A task you retry from scratch has multiple runs.

## Queues

A workspace starts with one queue, id `default`, and you can create up to **20**. Each queue is sequential — it runs at most one Task at a time — and queues are scheduled independently of each other, bounded by `schegent.queue.globalConcurrencyCap` (default `3`). Create, rename, delete and schedule are all available again; see [Multiple queues and concurrency](../operations/multi-queue-concurrency.md).

Two ceilings, two meanings. A Task that waits because its own queue is busy is **waiting its turn**. A queue that does not start because the workspace ceiling is reached is **blocked** — it will start as soon as a slot frees, without you doing anything.

**Runs still execute one at a time.** Queues are independent for everything except the subprocess itself: the run engine holds one active `WorkflowRun`, so a queue whose turn has come waits until the executing run finishes. You get independent inboxes, schedules, pause switches and history — not parallel Claude processes. See [Multiple queues and concurrency](../operations/multi-queue-concurrency.md#what-concurrent-does-and-does-not-mean-today).

(Versions between feature 030 and feature 092 supported exactly one queue. If you are reading older notes that say the create/rename/delete/schedule commands are "intentionally gone", they described that period.)

Each queue contains:

- **`pending`** — tasks waiting their turn, in order.
- **`inFlight`** — at most one task at a time, per queue (see [The Workspace Lock](workspace-lock.md)).
- **`paused`** — tasks the operator paused. Paused tasks do not consume the in-flight slot, so the queue can continue draining other pending work past them.
- **`history`** — terminal-state tasks (completed or failed) kept for review.

You can reorder pending tasks by drag-and-drop or via the up/down arrows in the sidebar. You cannot reorder the in-flight task — it holds its queue's execution lease.

### The drainer

Every state transition triggers the **drainer**, a host-side routine that asks, for one queue: "Is there a pending task we should move into in-flight right now?" The answer is yes if:

- the queue is not waiting on a scheduled start (`idle-pending`),
- the queue is not manually paused,
- no other task on *this* queue is already in-flight,
- the workspace is under its concurrency ceiling,
- the run engine is not already driving a run,
- the queue's execution lease is free,
- the Claude CLI is available.

When the drainer accepts a task, it:

1. Removes it from `pending`.
2. Constructs a `WorkflowRun` with a snapshot of the active pipeline.
3. Takes that queue's execution lease.
4. Spawns the first phase.

Across queues, the drainer walks the registry from a rotating cursor, so a queue that keeps producing work cannot starve the others.

The drainer is idempotent. Multiple state changes that all imply "drain now" will not produce two runs on the same queue — the per-queue lease guarantees that. A queue that clears every gate except the engine one simply waits; the next sweep picks it up, and because the cursor rotates, it is not the same queue that wins every time.

## A run, anatomy of

When a task enters `inFlight`, the host creates a `WorkflowRun` object that travels with the task until the run terminates. The fields that matter to you as an operator:

- **`runId`** — a UUID. Audit events, the raw transcript filename, the verbose diagnostic directory, and the sidebar all use this id.
- **`pipeline`** — the frozen snapshot. This is what the run executes; later settings changes do not retarget it.
- **`activePhaseId`** — which phase is currently executing.
- **`phaseOutcomes`** — completed phase results so far.
- **`manualPauseAt` / `manualPauseCause`** — when and why the operator paused.
- **`phaseBreakpoints`** — phase ids the operator armed to pause-before.
- **`pendingRetryAt` / `pendingRetryCause`** — scheduled retry information (rate limit recovery, etc.).
- **`resumeTargetPhaseId`** — the phase id to resume into, used after a breakpoint pause.

Each of these has strict pairing invariants: `manualPauseAt` and `manualPauseCause` are either both null or both non-null. The host rejects state writes that violate the pairing.

## Task states the operator sees

The sidebar surfaces the task state in plain English; here is the underlying enum:

- **`pending`** — the task is in the queue, waiting. You can reorder it, edit it, or delete it.
- **`in-flight`** — the task is actively running. You can pause it, set a breakpoint on an upcoming phase, or cancel it.
- **`manually-paused-task`** — the operator paused the task. Resume picks up where it left off.
- **`phase-paused`** — a phase boundary pause (typically a breakpoint or a fatal signature hit) suspended the task. Resume re-enters at the configured resume target.
- **`queue-paused`** — derived state, not stored on the task. The queue itself is paused; tasks that *would have been* draining show this. Once you unpause the queue, this state disappears.
- **`completed`** — terminal success.
- **`failed`** — terminal failure. The audit log explains why.

Note that `queue-paused` is a *projection*, not a persisted task state. You will see it in the UI, but the underlying task is just plain `pending`. The dashboard derives it from the queue registry entry's state.

## Pause causes the operator sees

When a task is paused, the cause tells you who or what paused it:

- `manually-paused-task` — the operator paused this specific task.
- `phase-paused` — a phase-boundary pause; the run is suspended between phases.
- `breakpoint-paused` — the operator armed a breakpoint and the run hit it.
- `queue-paused-mid-run` — the queue was paused while this task was in-flight. Resuming the queue clears this cause only.

Pause causes are mutually exclusive. The state model enforces that at write time.

## The lifecycle in pictures

A clean, happy-path run looks like this:

```text
[pending] --drainer--> [in-flight: specify]
                           ↓ phase-end
                       [in-flight: clarify]
                           ↓ phase-end
                       [in-flight: plan]
                           ↓ ...
                       [in-flight: finalize]
                           ↓ phase-end (success)
                       [completed]
```

A run with a breakpoint:

```text
[in-flight: implement] --phase-end--> [phase-paused] (breakpoint on `finalize`)
       ↑                                  ↓ operator clicks Resume
       └─── operator resumes ─────────────┘
                                          ↓
                                      [in-flight: finalize]
                                          ↓
                                      [completed]
```

A rate-limited run:

```text
[in-flight: plan] --rate-limit error in stdout-->
       [in-flight: plan + pendingRetryAt set]
                          ↓ wait for the reset
       [in-flight: plan retry, with --continue]
                          ↓
       [in-flight: tasks]
```

A run that hits a fatal signature mid-implement:

```text
[in-flight: implement] --fatal-signature-matched-->
       [failed]
                          (audit log explains why)
```

## Reordering rules

Pending tasks can be reordered. There are three mechanisms — drag-and-drop, up arrow, and down arrow — but they all flow through the same audit event (`task-reordered`). The audit event carries the from-position, to-position, source mechanism, and outcome (success or rejected). This is intentional: a future audit query can find every reorder regardless of how it was performed.

You cannot:

- reorder the in-flight task,
- reorder a task into the in-flight position (only the drainer does that),
- reorder around a paused task in a way that would change its relative position with respect to the in-flight one.

If a reorder is rejected, the audit event carries the cause (`secondary-host`, `task-not-pending`, `invalid-position`, `no-op`) so you can see why.

## Multiple VS Code windows

If you open the same workspace in two VS Code windows, only one of them is the **primary host**. The primary host is the only one that can:

- mutate queue state (enqueue, reorder, delete),
- save settings,
- pause or resume tasks.

Secondary windows can read the queue and the runs, but their mutating commands are rejected with `reason: 'not-primary-host'`. The primary-only gate is the only thing preventing two windows from corrupting the queue state.

The next page, [The Workspace Lock](workspace-lock.md), explains the two leases that arbitrate primacy and execution, and what to do when one looks stuck.
