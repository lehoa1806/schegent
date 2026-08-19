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

A workspace starts with one queue, id `default`, and you can create up to **20**. Each queue is sequential — it runs at most one Task at a time — and queues are scheduled independently of each other, bounded by `schegent.queue.globalConcurrencyCap` (default `1` — raise it to run queues concurrently). Create, rename, delete and schedule are all available again; see [Multiple queues and concurrency](../operations/multi-queue-concurrency.md).

Two ceilings, two meanings. A Task that waits because its own queue is busy is **waiting its turn**. A queue that does not start because the workspace ceiling is reached is **blocked** — it will start as soon as a slot frees, without you doing anything.

**Runs execute in parallel, up to the cap.** Since feature 093 the run engine holds one `WorkflowRun` per queue rather than one per workspace, so `cap` queues run `cap` Claude processes at once, each with its own phase progression, retry accounting and record. One run pausing, stalling or failing does not stall the others. What is still shared is the working tree and the window — see [Multiple queues and concurrency](../operations/multi-queue-concurrency.md#what-concurrent-does-and-does-not-mean-today).

(Versions between feature 030 and feature 092 supported exactly one queue. If you are reading older notes that say the create/rename/delete/schedule commands are "intentionally gone", they described that period.)

Each queue contains:

- **`pending`** — tasks waiting their turn, in order.
- **`inFlight`** — at most one task at a time, per queue (see [The Workspace Lock](workspace-lock.md)).
- **`paused`** — tasks the operator paused. Paused tasks do not consume the in-flight slot, so the queue can continue draining other pending work past them.
- **`history`** — terminal-state tasks (completed or failed) kept for review. Each queue keeps its own history, capped separately; see [History and its evidence](#history-and-its-evidence).

You can reorder pending tasks by drag-and-drop or via the up/down arrows in the sidebar. You cannot reorder the in-flight task — it holds its queue's execution lease.

### The drainer

Every state transition triggers the **drainer**, a host-side routine that asks, for one queue: "Is there a pending task we should move into in-flight right now?" The answer is yes if:

- the queue is not waiting on a scheduled start (`idle-pending`),
- the queue is not manually paused,
- no other task on *this* queue is already in-flight,
- the workspace is under its concurrency ceiling,
- the queue's execution lease is free,
- the Claude CLI is available.

When the drainer accepts a task, it:

1. Removes it from `pending`.
2. Constructs a `WorkflowRun` with a snapshot of the active pipeline.
3. Takes that queue's execution lease.
4. Spawns the first phase.

Across queues, the drainer walks the registry from a rotating cursor, so a queue that keeps producing work cannot starve the others.

The drainer is idempotent. Multiple state changes that all imply "drain now" will not produce two runs on the same queue — the per-queue lease guarantees that. A queue that clears every gate but one simply waits; the next sweep picks it up, and because the cursor rotates, it is not the same queue that wins every time.

There used to be one more gate: the run engine drove one run at a time, so a queue that had cleared everything else still waited for whichever run was already going. Feature 093 removed it. The ceiling above is now the only limit on how many runs execute at once, and it bounds runs that genuinely run in parallel rather than queue slots that mostly waited.

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
- **`liveness`** — when the run last produced output, plus how many stdout and stderr lines this phase has produced. See [Is it working, or is it hung?](#is-it-working-or-is-it-hung).
- **`plannedTotal`** — how many phases the run set out to do, frozen when the run was created. See [How far along is it?](#how-far-along-is-it).
- **`envelope`** — for a run you composed in the Run Launcher, the request exactly as you submitted it: the same frozen pipeline, plus the inputs you bound, the supplemental context you attached, the output targets you declared, and any instructions you typed. Present only on composed runs. See [What the backend receives](#what-the-backend-receives).

Each of these has strict pairing invariants: `manualPauseAt` and `manualPauseCause` are either both null or both non-null. The host rejects state writes that violate the pairing.

## Is it working, or is it hung?

A long phase and a dead phase look the same from the outside: the status says `in-flight`, and it has said so for hours. `liveness` is what tells them apart, and the reason it exists as its own field is that the run's status timestamp cannot answer the question — that timestamp moves when the *status* changes, so a phase that has been streaming output for three hours and a phase that died three hours ago both show the same "last changed" time.

What you can read from it:

- **`lastActivityAt`** — the last time the CLI produced a line. Recent means the run is doing something; hours old on an `in-flight` run means it probably is not.
- **`stdoutLines` / `stderrLines`** — how much this phase has produced. These reset at the start of each phase, so they are a reading about the current phase, not the whole run.

Three properties are worth knowing because they explain what you will see:

- **It survives a window reload.** The live activity indicator in the sidebar is computed in memory, so closing and reopening VS Code loses it — a reloaded window shows an in-flight run as freshly live whether or not it is. `liveness` is stored with the run, so it still answers after a reload.
- **It is written on a timer, not per line.** The stamp is updated at most once every 15 seconds per run, however much output arrives. So it can trail the true last line by up to that much, and a run that produced a burst of ten thousand lines writes one update, not ten thousand. Exact end-of-phase counts are in the `monitor-invocation-summary` audit event.
- **It holds a time and two counts, and nothing else.** No line content, no file paths. The field is a liveness reading, not a log.

If the field is missing entirely, the display says **unknown** — not "0 seconds ago". That happens for a run created before this feature existed, and for a phase that has genuinely not produced any output yet. Neither is the same as "silent for a long time", so neither is shown that way.

## How far along is it?

`plannedTotal` is the denominator: how many phases this run set out to do, and the per-phase loop ceiling it is running with. Progress is that total against the phases the run has settled.

- **The total is frozen when the run is created.** `schegent.loop.maxIterations` is a live setting, so if it were read on demand, lowering it from 5 to 2 would make every already-running run's progress jump. Each run carries the bound it started with, and you can see that bound in the run detail view — which is how you tell what an in-flight run is actually running with after you have changed the setting.
- **Skipping or disabling a phase adjusts the total.** It is recorded in the same write that records the override, so the two never disagree. Skipping a phase the run has not reached yet raises the percentage — you removed work. Progress does not go backwards and does not exceed 100%.
- **`maxPhaseInvocations` is a ceiling, not a forecast.** It counts positions in the pipeline, weighting each looping phase by the frozen loop bound. A loop that converges on its first pass uses far fewer.

As with liveness, an absent total displays as **unknown** rather than as 0%.

## What the backend receives

Every phase of a run sends one prompt to the Claude CLI. That prompt always contains Schegent's own output contract — the completion token, the audit-log block format — followed by the phase's instruction and the task description.

For a run you composed in the Run Launcher, it also contains the request itself, in four sections, always in this order:

1. **`REQUEST INPUTS:`** — each input port you bound, with its type and the value you gave it.
2. **`SUPPLEMENTAL CONTEXT:`** — each extra file, URL, literal note, or prior run output you attached. A prior output also names the run and output it came from.
3. **`DECLARED OUTPUT TARGETS:`** — each output port and the workspace-relative path you told Schegent to expect it at.
4. **`OPERATOR INSTRUCTIONS:`** — your free-text instructions, verbatim.

Three things follow from how those sections are built, and they are worth knowing because they explain behaviour you will see:

- **A section you left empty does not appear.** Bind no supplemental context and there is no `SUPPLEMENTAL CONTEXT:` heading for the model to read past.
- **Order is the order you composed in.** Within a section, entries appear in the order you added them — not alphabetized, not regrouped — and that order is fixed when you submit. It is the same on every phase of the run and after a window reload.
- **Your words stay yours.** Instructions and input values are placed after Schegent's output contract, under headings that say they came from you. They are never mixed into the contract text itself, which is why an instruction like "ignore the audit log" reads to the model as a request rather than as a Schegent rule.

**Declared outputs are stated before they are checked.** The targets in section 3 are the same targets Schegent looks for when the run completes. If a declared target exists afterwards, the run records it as resolved, with a workspace-relative reference; if not, it records it as unresolved. Schegent records the *location* — never a copy of the file — and it never goes looking for files you did not declare.

**Editing things mid-run changes nothing about the run.** The request is frozen when you submit it. Editing the pipeline, changing a phase's instruction, or altering the queued task afterwards does not retarget a run that is already going: it finishes on what you approved. That is also true of the last phase, not just the first.

**Reloading the window changes nothing either.** The request is stored with the run, so a run you pause, reload VS Code, and resume sends the same four sections it was sending before — same entries, same order. The one exception is a run that was already in flight when you upgraded to a version that has this feature: it was created before the request was stored on the run, so Schegent re-attaches it from the queued task on resume.

**None of this reaches the audit log.** `.schegent/audit.log` keeps recording bounded identifiers and counts — pipeline id, phase id, runner, timings. Your input values, attached paths, output targets, and instructions are sent to the backend and are not written into that durable record.

Tasks started any other way — the ordinary "add a task and let it drain" path — send exactly the prompt they always did. None of the four sections appear, and nothing about those runs changed.

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

## History and its evidence

When a run reaches a terminal state, the host writes one **history entry** for it. Each queue keeps its own history list, capped at **50 entries per queue** — so a workspace with four queues can hold 200. The cap is per queue on purpose: with one shared list, a busy queue's completions quietly pushed a quiet queue's records out, and nothing in the sidebar told you it had happened. When the 51st entry lands on a queue, the oldest entry *on that queue* is evicted and no other queue is touched.

An entry is deliberately small: a run id, a feature id, an 80-character preview of the description, the terminal status, start and end timestamps, a duration, an optional error summary, and a pointer to the audit evidence. The **full description** is not in the entry — it lives on disk at `.schegent/history/<runId>.txt`, so that recording a completion does not cost a rewrite of every description in the workspace. It is removed when its entry is evicted. If that file is missing or unreadable, the entry still shows and a rerun reports the description as unavailable; a history record is worth more than the replay convenience attached to it.

### The Audit button, and the four answers it can give

Each history row has an **Audit** action that resolves the entry's pointer against the audit log. There are four outcomes and the difference between them is the point:

| What you see | What it means | What to do |
|---|---|---|
| The run's records open | The evidence is present and addressable. | Read it. |
| "The audit log covering this run has been rotated away" | The audit log has pruned past this run. The history entry outlived its evidence. | Check archived logs, if you keep them. |
| "This run recorded no audit entries" | The audit log *does* cover this run's window and holds nothing for it — for example a run canceled before its first phase wrote anything. | Nothing to find; this is the whole record. |
| "This run predates audit pointers" | The entry was written by an older build, before the pointer format was pinned. | Nothing to find automatically; search the log by hand if you need to. |

Only a genuine failure to read the log ("Could not read the audit log") is shown as an error. The other three are ordinary answers, and treating them as failures would train you to ignore the one signal that tells you evidence is gone.

### Two retention windows, on purpose

History entries and audit evidence are pruned by **different rules**, and neither waits for the other:

| | Kept until | Governed by |
|---|---|---|
| **History entries** | the 51st entry lands on the same queue | `HISTORY_CAP_PER_QUEUE` |
| **Audit evidence** | the 11th archive rotates, or the 91st day | audit log rotation and retention |

A history entry outliving its evidence is therefore **expected**, not a fault — it is exactly the "rotated away" row in the table above. The reverse also happens: evidence for a run whose history entry has been evicted is still in the log, it just no longer has a row pointing at it. If you need a durable record of what a run cost independent of both windows, that is what the cumulative metrics rollup is for; see [Metrics](../operations/metrics.md).

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
