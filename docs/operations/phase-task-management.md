# Manage Phases and Tasks

Phase controls act on the active Run of a named Queue. Task edits act on a named Task, and the host derives its Queue where necessary. In the sidebar wire contract, every live phase control carries `queueId`; the host refuses an ambiguous target instead of guessing which concurrent Run the operator meant. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/workflow-controller.ts -->

All commands in this runbook mutate workspace state. The sidebar router therefore requires the current window to hold workspace primacy; a secondary window receives a rejected acknowledgement and cannot perform the write. <!-- Source: src/contracts/sidebar-command-metadata.ts --> <!-- Source: src/ui/sidebar/commands/primacy-gate.ts -->

## Active phase controls

| Intent | Sidebar command and payload | Effect |
|---|---|---|
| Retry a pending retry now | `CMD_RETRY_PHASE_NOW { queueId }` | Cancels the pending retry delay and resumes that Queue's existing Run when the Run is eligible. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/manual-retry-override.ts --> |
| Pause the active phase | `CMD_PAUSE_PHASE { queueId }` | Persists an operator pause, cancels active work or a retry timer, and cascades paused state to the Queue. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/phase-control-service.ts --> |
| Resume the active phase | `CMD_RESUME_PHASE { queueId, prompt? }` | Clears manual and pending-retry pause fields, optionally records a prompt, and schedules continuation. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/phase-control-service.ts --> |
| Restart the active phase | `CMD_RESTART_PHASE { queueId, phaseId }` | Restarts the current phase, resets its iteration and delayed-retry state, and clears an override on that current phase. The wire contract requires `phaseId`, while the registered command routes the Queue to the active-phase operation. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/ui/sidebar/commands/cmd-restart-phase.ts --> <!-- Source: src/controller/phase-control-service.ts --> |

Pause is accepted only for a running Run or a Run in a retry countdown, and a duplicate manual pause is refused. Resume requires a manual pause or pending retry. Restart requires a Run in flight. The command acknowledgement reports a rejection when these state preconditions are not met. <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/ui/sidebar/commands/handler-helpers.ts -->

## Override one phase

| Intent | Sidebar command and payload | Effect |
|---|---|---|
| Skip | `CMD_SKIP_PHASE { queueId, phaseId }` | Stores a `skipped` override. If the phase is active, Schegent aborts or resumes as appropriate so execution can move past it. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/phase-control-service.ts --> |
| Disable | `CMD_DISABLE_PHASE { queueId, phaseId }` | Stores a `disabled` override for this Run. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/phase-control-service.ts --> |
| Enable | `CMD_ENABLE_PHASE { queueId, phaseId }` | Clears an existing override; it is refused when the phase has no override. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/phase-control-service.ts --> |
| Remove from a Task's Run | `CMD_REMOVE_TASK_PHASE { taskId, phaseId, confirmed: true }` | Stores a `removed` override. Removing an active running phase cancels its active invocation. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/controller/phase-control-service.ts --> |

Skip, disable, enable, and remove validate the phase against the immutable Pipeline snapshot stored on the Run. Applying skip or disable also clears a breakpoint on the same phase. Phase overrides update the recorded planned total in the same state write so progress continues to use the effective plan. <!-- Source: src/controller/phase-control-service.ts -->

These operations change only the active Run snapshot. They do not edit or publish the Phase or Pipeline definition in the catalog. <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/state/workflow-run.ts -->

## Edit queued Tasks

| Intent | Sidebar command and payload | Preconditions and result |
|---|---|---|
| Change description | `CMD_MODIFY_TASK { taskId, description }` | Updates the matching Task and emits `task-modified` after success. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/ui/sidebar/commands/cmd-modify-task.ts --> |
| Reorder | `CMD_REORDER_TASK { taskId, newPosition }` | Moves the Task within the unified queue order and emits a canonical `task-reordered` decision. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/ui/sidebar/commands/cmd-reorder-task.ts --> |
| Restart a canceled Task | `CMD_RESTART_CANCELED_TASK { taskId }` | Changes a matching canceled Task back to pending; other states are refused. <!-- Source: src/contracts/sidebar-ipc/run-controls.ts --> <!-- Source: src/ui/sidebar/commands/cmd-restart-canceled-task.ts --> |

Use the Queue and Run identifiers from the latest sidebar snapshot. A stale `taskId`, a Queue without an active Run, or a phase absent from that Run's snapshot is rejected without redirecting the mutation to another Queue. <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/queue/queue-manager.ts -->

## Audit the result

Successful phase controls append phase-control events such as `phase-paused`, `phase-resumed`, `phase-restarted`, `phase-skipped`, `phase-disabled`, `phase-enabled`, or `phase-removed`. Successful task description and reorder operations append their queue audit events. Treat the command acknowledgement as the immediate result and the audit record as the durable operator-attributed evidence. <!-- Source: src/controller/phase-control-service.ts --> <!-- Source: src/ui/sidebar/commands/cmd-remove-task-phase.ts --> <!-- Source: src/ui/sidebar/commands/cmd-modify-task.ts --> <!-- Source: src/ui/sidebar/commands/cmd-reorder-task.ts -->
