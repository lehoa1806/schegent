# Phase And Task Management

Feature 017 extends the dashboard with phase controls, named queues, queue
scheduling, and pending-task editing. These controls are sidebar/dashboard IPC
operations; no new VS Code command palette commands are required for queue
CRUD, scheduling, task edit/move/reorder, or phase skip/disable/enable.

## Phase Controls

- **Pause Phase** requests a cooperative pause. The active Claude invocation
  finishes its current iteration, then the run persists
  `manualPauseCause = 'operator-paused'` and the matching task becomes paused
  with `pauseCause = 'phase-paused'`.
- **Resume Phase** clears operator pause state and also short-circuits a
  pending delayed retry when one exists.
- **Restart Phase** resets the current phase iteration to 1, clears the
  current phase override, and keeps diagnostics/audit history intact.
- **Skip / Disable / Enable** write per-run phase overrides only. The frozen
  pipeline snapshot is never mutated, so settings reloads affect future runs
  only.
- **Delete Phase** removes a phase from the selected task after confirmation.
  The host persists `PhaseOverride.action = 'removed'` on that run only,
  hides the phase from the progression snapshot, and skips it at future
  execution boundaries. Active phase deletion requests a safe abort/advance
  boundary rather than erasing already-written diagnostics.

Deleting a phase never deletes `.schegent/audit.log`, raw transcripts, or
verbose diagnostic files. A successful deletion emits `phase-removed` with the
task id, phase id, run id, and prior phase state when known. Stale task ids,
unknown phase ids, and already-removed phases are rejected and surfaced as
non-destructive dashboard feedback.

## Queues

The dashboard queue manager can create, rename, pause, resume, and delete
named queues. The default queue cannot be deleted. A queue with an in-flight
task cannot be deleted.

Queue lifecycle states (feature 065): `idle` (no pending tasks or
no-start-mode appends), `idle-pending` (first pending task has a
`scheduledStartAt` — countdown visible), `running` (a task is in-flight),
`paused` (operator pause), `manually-paused` (cascade pause from
feature 028). See the **Scheduling** section below for the
enqueue/start separation chooser and the audit events the System tab
filter chips surface.

When deleting a queue, the confirmation modal defaults to **Cancel tasks**.
Choosing **Move tasks** requires a target queue and moves pending tasks
atomically; if the target would exceed the pending-task cap, the operation is
rejected and no tasks move.

Queue settings live under:

- `schegent.queue.globalConcurrencyCap` — integer pinned to `1..1`
  (Feature 056 Track 4). v1 supports exactly one active workflow run.
- `schegent.queue.defaultQueueId` — id of an existing queue.

The host validates both settings transactionally. The webview helper
`save-queue-settings.ts` is the only webview call site for saving queue
settings.

## Tasks

Pending tasks can be edited, moved to another queue, or explicitly reordered.
All tasks, regardless of status, can be removed after confirmation. Confirmed
removal deletes the visible queue row for pending, in-flight, paused, failed,
canceled, and completed tasks; stale ids are rejected and no unrelated rows
are mutated. Pending positions are compacted after remove, move, or reorder so
reloads preserve the same visible order.

Removing an in-flight task routes through the workflow controller: the active
run is canceled, the workspace lock is released, and the next snapshot drops
the active row. Removing a terminal task is queue cleanup only. Every
successful removal emits `task-removed` with `taskId`, `queueId`,
`priorStatus`, and `runId` when available; it does not erase historical audit
or transcript files.

Task deletion confirmation copy is status-aware:

- Pending and paused copy explains the task will not run unless re-added.
- In-flight copy explains active work will be stopped at a safe boundary.
- Failed, canceled, and completed copy explains the visible row is removed
  while history/diagnostics remain.

Task pause labels are deliberately distinct:

- **Queue paused** means the task is blocked by its queue state.
- **Paused (operator)** means the active phase was paused by the operator
  (feature 028 — previously rendered as "Phase paused").
- **Paused (breakpoint)** means a future-phase breakpoint fired and the
  pipeline halted before invoking the marked phase (feature 028).
- **Task paused** is reserved for task-level pause state.

Queue resume clears only queue-sourced `queue-paused-mid-run` run causes and
does not resume an operator-paused phase.

## Advanced phase pausing (feature 028)

Feature 028 adds two complementary pause behaviors on top of the per-run
phase controls.

### Active-phase pause cascades to the queue

When the operator pauses the active phase (FR-001), the host:

1. Persists `WorkflowRun.manualPauseCause = 'operator-paused'`.
2. Calls `QueueManager.cascadedPause()` on the run's queue, setting
   `QueueRegistryEntry.state = 'manually-paused'` and
   `pauseSource = 'cascade'`.
3. Emits the standard `phase-paused` event plus a `queue-paused` event with
   `source: 'cascade'`.

Resuming the phase calls `QueueManager.cascadedResume()`. The cascade-resume
is a strict no-op when the queue's `pauseSource` is `'operator'` — so an
operator-initiated queue pause survives a phase resume (FR-004).

This means: while the active phase is paused, no other task in the same
queue auto-starts.

### Future-phase breakpoints

Operators can right-click any **pending** phase tile and choose
**Pause when reached** to arm a one-shot breakpoint on that phase. The host:

1. Validates the request (phase exists, not active, not completed, has no
   skip/disable/remove override, no breakpoint already armed) — failures
   surface as non-destructive dashboard feedback.
2. Appends a `PhaseBreakpoint` entry to `WorkflowRun.phaseBreakpoints`.
3. Emits `phase-breakpoint-set`.

When the pipeline reaches the marked phase, the phase runner reads the
no-cache `PhaseBreakpointAccessor` and halts BEFORE spawning the CLI for
that phase. The host:

1. Emits `phase-breakpoint-fired { runId, pipelineId, phaseId, iterationN }`.
2. Filters the consumed entry and emits
   `phase-breakpoint-cleared { cause: 'consumed-by-fire' }`.
3. Sets `manualPauseCause = 'breakpoint-paused'` and
   `resumeTargetPhaseId = <phaseId>`.
4. Cascade-pauses the queue.
5. Releases the workspace lock.

The task-level pause badge renders "Paused (breakpoint)" and the phase tile
renders a distinct **breakpoint-fired** indicator. **Resume** invokes the
marked phase via the runner; subsequent phases proceed normally and the
queue cascade-resumes.

Operators can also cancel an armed breakpoint via **Cancel scheduled pause**
on the same phase tile — the host emits
`phase-breakpoint-cleared { cause: 'operator' }`.

Two other paths also clear breakpoints:

- Applying a `skipped` / `disabled` / `removed` override on a phase that has
  a breakpoint auto-clears it with cause `'override-applied'`.
- Run termination (`completed` / `failed` / `cancelled`) clears all
  remaining breakpoints with cause `'run-ended'`.

### Audit events to grep when reconstructing breakpoint history

All five are additive (no `AUDIT_SCHEMA_VERSION` bump) and route through
the existing single-sanitization point in `audit-log-writer.ts`:

- `phase-breakpoint-set` — `{ runId, pipelineId, phaseId, actor, timestamp }`
- `phase-breakpoint-cleared` — `{ runId, pipelineId, phaseId, cause, timestamp }`
  where `cause ∈ { 'operator', 'consumed-by-fire', 'override-applied', 'run-ended' }`
- `phase-breakpoint-fired` — `{ runId, pipelineId, phaseId, iterationN, timestamp }`
- `queue-paused` — now carries `source: 'operator' | 'cascade'`
- `queue-resumed` — now carries `source: 'operator' | 'cascade'`

See [specs/028-advanced-phase-pausing/quickstart.md](../../specs/028-advanced-phase-pausing/quickstart.md)
for the three end-to-end walkthroughs (US1 cascade pause, US2 future-phase
breakpoint, US3 visual distinction).

## Scheduling

Each queue supports one one-shot schedule. Accepted expressions:

- `in <N>m`
- `in <N>h`
- `at HH:MM`

The schedule watchdog runs on the primary VS Code host only. When a schedule
fires, the watchdog clears it, emits audit metadata, unpauses the queue, and
asks the controller to drain queued work. If the host fires more than 60
seconds after the target, it records delayed-trigger diagnostics.

### Enqueue/Start separation (feature 065)

Feature 065 introduces an explicit **start-mode chooser** on every enqueue
into an empty (`idle`) queue and adds a per-task `scheduledStartAt`. The
chooser offers three options:

- **Start now** — the queue transitions to `running` immediately. Audit
  emits the existing `task-enqueued` plus `phase-start`.
- **Start in… / Start at…** — the queue moves to `idle-pending` and the
  task is persisted with `scheduledStartAt`. An inline countdown ticks
  one-second cadence when expanded and one-minute cadence when collapsed.
  Cancel / change / convert-to-now affordances render alongside the
  countdown.
- **Just add (no start)** — the queue remains `idle` and the task is
  persisted with no schedule. The operator must press **Start** later.

While the queue is `running` or `paused`, the chooser does NOT appear:
new enqueues are silent appends to the pending queue (feature-030
sequential semantics). The `idle-pending` lifecycle is unique to feature
065 and only applies when the first-pending task has a `scheduledStartAt`.

When the scheduled fire time passes, the `ScheduledStartCoordinator`
flips the queue from `idle-pending` to `running`, transitions the head
pending task to in-flight, and the status-bar transient surfaces for
3–5 seconds on fire (per Q15 / FR-017a). If the host fires more than
60 seconds after target, the same delayed-trigger diagnostic from the
per-queue scheduler is emitted.

The v6 → v7 state migration adds `queueLifecycle`, `scheduledStartAt`,
`scheduledStartSource`, and the one-time `migrationNotice` banner flag
to every existing queue. Pending tasks are preserved byte-for-byte
(SC-005). The dashboard renders a dismissable migration notice on the
next activation; dismissal flows through the new (read-side)
`CMD_DISMISS_MIGRATION_NOTICE` IPC — intentionally **not** a member of
`MUTATING_COMMANDS`.

### Audit events to grep in the System tab

All eight are additive (no `AUDIT_SCHEMA_VERSION` bump) and route through
the existing single-sanitization point in `audit-log-writer.ts`. Each
carries the consistent core payload `{ queueId, eventType, occurredAt,
transitionReason }` per FR-023a:

- `scheduled-start-armed` — emitted when a task transitions queue to
  `idle-pending` with `scheduledStartAt`.
- `scheduled-start-fired` — emitted when the coordinator promotes
  `idle-pending` → `running` at fire time.
- `scheduled-start-cancelled` — emitted when the operator cancels the
  schedule (queue returns to `idle`, task may stay pending or be deleted
  depending on path).
- `scheduled-start-rescheduled` — emitted when the operator changes the
  scheduled time on an `idle-pending` queue.
- `idle-pending-enqueued` — emitted when a task is appended to a queue
  already in `idle-pending` (operator chose append vs. promote).
- `idle-pending-promoted` — emitted when an `idle-pending` queue
  transitions to `running` via operator action (convert-to-now or
  explicit Start).
- `automation-enqueue-no-start-mode` — emitted when a programmatic /
  wake-up enqueue path supplies no `startIntent`; feature-030 sequential
  semantics apply and the task lands in `pending` without a schedule.
- `migration-default-applied` — emitted once per queue on the v6 → v7
  upgrade boundary, attributing the lifecycle default with
  `scheduledStartSource: 'migration-default'`.

The chooser, countdown, indicator, and System tab filter chips are
operator-visible surfaces and do not require feature flags. The chooser
respects `schegent.queue.globalConcurrencyCap = 1`: a second
`Start now` while another queue is running surfaces a non-modal
"queue state changed elsewhere" notice and falls back to silent append.

## Phase Messages

A phase may write a flat `key=value` sidecar named `phase-message.env` to the
host-provided diagnostic path and list that path in the existing audit
`files_created` or `files_modified` fields. The next phase receives only the
immediately preceding sanitized message. Missing sidecars are normal; oversized
or invalid sidecars produce metadata-only audit events and do not expose values
in the UI.
