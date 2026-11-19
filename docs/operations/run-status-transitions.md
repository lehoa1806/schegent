# Run Status Transitions and Atomic Admission

Every `WorkflowRun` status transition is governed by one exhaustive static transition table and pure decision function (`decideRunTransition`), enforced at both `WorkspaceStateStore.setRun` and `WorkspaceStateStore.updateRun`. This mirrors the Task lifecycle classifier (`decideTaskTransition`) documented in [Manage Phases and Tasks](phase-task-management.md#which-cancellations-are-legal). <!-- Source: src/state/run-transition-decision.ts --> <!-- Source: src/state/workspace-state.ts -->

## Actor classes

Every Run write carries an actor class drawn from a closed four-member union (`RunTransitionActor`):

| Actor | Role | Production entry points |
|---|---|---|
| `driver` | Active execution loop, retry handler, start-failure handler, and runtime bookkeeping | `driver-transition`, `liveness`, `retry-decision`, `spawn-identity`, default for direct `setRun` |
| `operator` | Explicit operator controls and queue-pause cascades | `cancel`, `pause`, `resume`, `restart`, `skip`, `disable`, `enable`, `set-breakpoint`, `clear-breakpoint`, `remove-phase`, `manual-retry-override`, `queue-pause`, `queue-resume`, `resume-prompt`, operator `resume-admission` |
| `watchdog` | Autonomous monitors and unattended wakeups | `credit-window`, `spend-pause`, unattended `resume-admission` |
| `recovery` | Crash replay and load-time orphan reconciliation | `TerminalTransitionCoordinator.projectInterrupted` (`setRun(..., 'recovery')`), `orphaned-run-reconciler` |

<!-- Source: src/state/run-transition-decision.ts --> <!-- Source: src/state/run-update.ts -->

## Transition matrix

All five `WorkflowRunStatus` values (`running`, `paused`, `failed`, `completed`, `canceled`) appear as both rows (`from`) and columns (`to`). Same-status cells (`from === to`) are explicitly modelled because most `updateRun` calls patch metadata without changing status.

| `from` \ `to` | `running` | `paused` | `failed` | `completed` | `canceled` |
|---|---|---|---|---|---|
| **`running`** | `driver`, `operator`, `watchdog` | `driver`, `operator` | `driver`, `recovery` | `driver`, `recovery` | `driver`, `operator`, `recovery` |
| **`paused`** | `driver`, `operator`, `watchdog` | `driver`, `operator`, `watchdog` | `driver`, `recovery` | `driver`, `recovery` | `driver`, `operator`, `recovery` |
| **`failed`** | `operator` | *(refused)* | `driver`, `operator`, `recovery` | *(refused)* | `operator`, `recovery` |
| **`completed`** | *(refused)* | *(refused)* | *(refused)* | `driver`, `recovery` | *(refused)* |
| **`canceled`** | *(refused)* | *(refused)* | *(refused)* | *(refused)* | `driver`, `recovery` |

Key invariants held by the table:

- **`completed` and `canceled` are permanently immutable**: no actor may move a `completed` or `canceled` Run to any other status (`terminal-status-immutable`). Only `driver` post-exit cleanup (removing `spawnIdentity`) and `recovery` idempotent replay may perform same-status writes on them.
- **Unattended actors cannot resurrect `failed` Runs**: `failed → running` is permitted solely for `operator` (Retry, Resume, Restart). Neither `watchdog` nor `driver` may transition out of `failed`.
- **Compile-time exhaustiveness**: `RUN_STATUS_TRANSITIONS` is typed over `Record<WorkflowRunStatus, Record<WorkflowRunStatus, readonly RunTransitionActor[]>>`, so adding a new Run status fails `npm run typecheck` until every row and column is specified.

<!-- Source: src/state/run-transition-decision.ts --> <!-- Source: tests/unit/state/run-transition-decision.test.ts -->

## Typed error hierarchy

Illegal transitions and field-combination invariant violations throw subclasses of `RunInvariantError` (preserving the existing `WorkflowRun invariant violation: ...` message prefix):

- **`RunTransitionError`**: exposes readonly `from`, `to`, `actor`, and `reasonCode` (`'terminal-status-immutable' | 'illegal-transition' | 'actor-not-permitted'`).
- **`RunFieldInvariantError`**: exposes readonly `code` naming the specific field-combination invariant (`failure-cause-requires-failed`, `one-sided-manual-pause`, `one-sided-pending-retry`, `pending-retry-requires-paused`, `invalid-credit-pause-shape`, etc.).

Callers branch on `instanceof RunTransitionError` / `instanceof RunFieldInvariantError` and inspect structured fields instead of parsing error text. Concurrent-race refusals (`stale-run-id`, `run-status-precondition`) remain `QueueMutationRejected` so `isRunRaceRefusal` distinguishes expected races from structural invariant defects. <!-- Source: src/state/run-invariant-error.ts --> <!-- Source: src/state/workspace-state.ts -->

## Atomic Run admission

New-Run admission (`SchegentWorkflowController.admitNew` → `QueueManager.admitRun` → `WorkspaceStateStore.admitRunAtomically`) persists the new `WorkflowRun` (`KEYS.run` plus relational `runs` row) and marks the target Task `in-flight` (`KEYS.queue`) inside a single serialized multi-key critical section (`serializeAcrossKeys([KEYS.run, KEYS.queue], ...)`) and a single SQLite `BEGIN IMMEDIATE ... COMMIT` transaction (`SqliteOperationalBacking.updateBatch`), gated by the queue's execution fence claim and `decideTaskTransition('mark-in-flight')`.

A host crash at any boundary of admission therefore leaves the Run and Task in agreement on restart — either neither committed (no Run, Task still `pending`) or both committed together (Run `running`, Task `in-flight` pointing at that Run). Two lint census gates (`tests/lint/run-write-census.test.ts` and `tests/lint/run-allowed-statuses-census.test.ts`) prevent the split two-call admission or unlisted `allowedStatuses` sites from returning. <!-- Source: src/state/sqlite-operational-backing.ts --> <!-- Source: src/state/workspace-state.ts --> <!-- Source: src/queue/queue-manager.ts --> <!-- Source: src/controller/workflow-controller.ts --> <!-- Source: tests/integration/atomic-run-admission-crash.test.ts -->
