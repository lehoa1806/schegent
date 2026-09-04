# Manage Phases and Tasks

Phase controls act on the active Run of a named Queue. Task edits act on a named Task, and the host derives its Queue where necessary. In the sidebar wire contract, every live phase control carries `queueId`; the host refuses an ambiguous target instead of guessing which concurrent Run the operator meant. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/workflow-controller.ts -->

All commands in this runbook mutate workspace state. The sidebar router therefore requires the current window to hold workspace primacy; a secondary window receives a rejected acknowledgement and cannot perform the write. <!-- Source: src/contracts/sidebar-command-metadata.ts --> <!-- Source: src/ui/sidebar/commands/primacy-gate.ts -->

Every Phase-control operation below is decided by one shared, host-side classifier before anything is written — a Run, Task, override, audit event, or drain/resume trigger. The classifier is consulted first regardless of caller (sidebar command, a stale or replayed IPC message); UI narrowing is defense in depth, not the only guard. A refused request returns a structured reason drawn from a closed vocabulary (for example `run-terminal`, `phase-not-active`, `phase-already-started`, `phase-not-future`, `no-disabled-override`) rather than free text. <!-- Source: src/controller/phase-control-decision.ts -->

## Active phase controls

| Intent | Sidebar command and payload | Effect |
|---|---|---|
| Retry a pending retry now | `CMD_RETRY_PHASE_NOW { queueId }` | Cancels the pending retry delay and resumes that Queue's existing Run when the Run is eligible. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/manual-retry-override.ts --> |
| Pause the active phase | `CMD_PAUSE_PHASE { queueId }` | Persists an operator pause, cancels active work or a retry timer, and cascades paused state to the Queue. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/phase-control-service.ts --> |
| Resume the active phase | `CMD_RESUME_PHASE { queueId, prompt? }` | Clears manual and pending-retry pause fields, optionally records a prompt, and schedules continuation. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/phase-control-service.ts --> |
| Restart the active phase | `CMD_RESTART_PHASE { queueId, phaseId }` | Restarts the current phase, resets its iteration and delayed-retry state, and clears an override on that current phase. The wire contract requires `phaseId`, while the registered command routes the Queue to the active-phase operation. Refused with `run-terminal` when the Run has already reached `completed` or `canceled` — a Run record existing is not by itself permission. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/ui/sidebar/commands/cmd-restart-phase.ts --> <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/controller/phase-control-decision.ts --> |

Pause is accepted only for a running Run or a Run in a retry countdown, and a duplicate manual pause is refused. Resume requires a manual pause or pending retry. Restart requires a Run that is not `completed` or `canceled`, targeting the Run's current active phase (`failed` is not terminal for this purpose — retry and skip exist largely for failed Runs). Restarting a **canceled Task** through `CMD_RESTART_CANCELED_TASK` (below) is a distinct, Task-level fresh-Run operation and does not by itself make a terminal Run's active phase restartable. The command acknowledgement reports a rejection when these state preconditions are not met. <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/controller/phase-control-decision.ts --> <!-- Source: src/ui/sidebar/commands/handler-helpers.ts -->

That last sentence is worth reading twice, because until feature 193 (`FR-R3-154`) it was not true of Pause, Resume, Restart, or Retry-now. Those four routes — and Start Queue — dispatched the host command and then acknowledged `accepted` regardless of what it answered, so an operator following this runbook saw a success for a refusal the classifier had already decided. The refusal reason existed; nothing carried it back. Each route now acknowledges the host's own answer, and the acknowledgement distinguishes four outcomes: `accepted`, `refused` (a precondition said no), `no-op` (nothing to do, which is not an error), and `failed` (the mutation or its dispatch broke). A `failed` acknowledgement carries a code and never an error message, because the reason crosses to the webview and a message from that layer can carry a workspace path; the sanitized message goes to the extension log instead. An untrusted workspace is reported as `refused` with `workspace-not-trusted`, which is the case the old reading got most wrong — the trust gate warns and returns `undefined` without entering the handler at all, so `await exec(...)` resolved and the route acknowledged a mutation that was never attempted. A registered command answering a shape no reading covers is reported as `failed` with `command-result-unrecognized` rather than assumed successful: an unrecognized result is a wiring defect, and a false `failed` is recoverable where a false `accepted` is not. When troubleshooting a control that "did nothing", the acknowledgement is now the first place to look rather than the audit log. <!-- Source: src/ui/sidebar/commands/handler-helpers.ts --> <!-- Source: src/contracts/command-outcome.ts --> <!-- Source: tests/unit/ui/sidebar/mutation-ack-truth.test.ts -->

## Override one phase

| Intent | Sidebar command and payload | Effect |
|---|---|---|
| Skip | `CMD_SKIP_PHASE { queueId, phaseId }` | Stores a `skipped` override for the Run's current active phase, then aborts or resumes as appropriate so execution can move past it. Refused with `phase-not-active` when `phaseId` does not name the Run's current phase. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/controller/phase-control-decision.ts --> |
| Disable | `CMD_DISABLE_PHASE { queueId, phaseId }` | Stores a `disabled` override for a Phase that has not yet started. Refused with `phase-already-started` when the target is the current phase or already appears in the Run's completed-phase ledger. In the sidebar, this targets whichever Phase tile the operator selected, independent of the current active phase. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/controller/phase-control-decision.ts --> |
| Enable | `CMD_ENABLE_PHASE { queueId, phaseId }` | Clears an existing `disabled` override. Refused with `no-disabled-override` when the phase carries no override, or a non-`disabled` one, and with `phase-not-future` when the phase already started despite a stale `disabled` entry — carrying *an* override is no longer sufficient by itself. Also targets the operator's selected tile in the sidebar. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/controller/phase-control-decision.ts --> |
| Remove from a Task's Run | `CMD_REMOVE_TASK_PHASE { taskId, phaseId, confirmed: true }` | Stores a `removed` override. Removing an active running phase cancels its active invocation. Unlike Disable/Enable this remains available for any visible Phase state — completed, active, skipped, failed, disabled, or future — and, in the sidebar, always targets the operator's selected tile (Feature 022 FR-008–FR-013). <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/phase-control-service.ts --> |

Skip, disable, enable, and remove validate the phase against the immutable Pipeline snapshot stored on the Run — that snapshot is never retargeted to a newer catalog definition as a side effect of any of these operations. Applying skip or disable also clears a breakpoint on the same phase. Phase overrides update the recorded planned total in the same state write so progress continues to use the effective plan. <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/controller/phase-control-decision.ts -->

These operations change only the active Run snapshot. They do not edit or publish the Phase or Pipeline definition in the catalog. <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/state/workflow-run.ts -->

## Edit queued Tasks

| Intent | Sidebar command and payload | Preconditions and result |
|---|---|---|
| Change description | `CMD_MODIFY_TASK { taskId, description }` | Updates the matching Task and emits `task-modified` after success. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/ui/sidebar/commands/cmd-modify-task.ts --> |
| Reorder | `CMD_REORDER_TASK { taskId, newPosition }` | Moves the Task within the unified queue order and emits a canonical `task-reordered` decision. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/ui/sidebar/commands/cmd-reorder-task.ts --> |
| Restart a canceled Task | `CMD_RESTART_CANCELED_TASK { taskId }` | Changes a matching canceled Task back to pending; other states are refused. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/ui/sidebar/commands/cmd-restart-canceled-task.ts --> |
| Cancel a Task | `CMD_CANCEL { taskId }` | Ends the addressed Task as `canceled`. Legal from `pending` and from `in-flight`, refused from every other status — see the matrix below. An in-flight Task whose Queue holds a matching running Run also has that Run canceled and its lease released; a pending Task, or an in-flight one with no matching Run, only finalizes the queue row. Emits `task-canceled`. Omitting `taskId` cancels the window's active Run instead of a named Task. <!-- Source: src/contracts/sidebar-ipc.ts --> <!-- Source: src/commands/cancel.ts --> |

### Which cancellations are legal

One table decides this, for every route: the Task transition classifier's `finish → canceled` column. The operator's command consults it rather than carrying its own copy, so what the sidebar refuses and what the queue refuses cannot drift apart. <!-- Source: src/queue/task-transition-decision.ts --> <!-- Source: src/commands/cancel.ts -->

| Task status | Cancel | Result |
|---|:---:|---|
| `pending` | yes | finalized without starting; no Run is involved |
| `in-flight` | yes | a matching running Run is canceled first, then the row is finalized |
| `paused` | no | refused; resume or leave it, a paused Task is not cancellable in place |
| `completed` | no | refused; already terminal |
| `canceled` | no | refused; already terminal |
| `failed` | no | refused; already terminal |

A refused cancellation reports `illegal-state` to the caller and is **otherwise silent** — no notification and no audit entry. An unknown `taskId` is different: it reports `not-found` and does notify. <!-- Source: src/commands/cancel.ts -->

Use the Queue and Run identifiers from the latest sidebar snapshot. A stale `taskId`, a Queue without an active Run, or a phase absent from that Run's snapshot is rejected without redirecting the mutation to another Queue. <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/queue/queue-manager.ts -->

## Audit the result

Successful phase controls append phase-control events such as `phase-paused`, `phase-resumed`, `phase-restarted`, `phase-skipped`, `phase-disabled`, `phase-enabled`, or `phase-removed`. Successful task description and reorder operations append their queue audit events. Treat the command acknowledgement as the immediate result and the audit record as the durable operator-attributed evidence. <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/ui/sidebar/commands/cmd-remove-task-phase.ts --> <!-- Source: src/ui/sidebar/commands/cmd-modify-task.ts --> <!-- Source: src/ui/sidebar/commands/cmd-reorder-task.ts -->
