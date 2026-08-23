# Single-task queue migration history

This runbook covers the historical v5 to v6 migration that combined multiple
queues into one queue. Current Schegent state is schema v13 and supports a live
multi-queue registry with one to 20 entries, including the reserved `default`
queue. The old collapse remains in the forward-migration ladder so older
workspaces can still open; it is not the current queue model.

<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/queue/queue-registry.ts -->
<!-- Source: src/state/workspace-state.ts -->

## What happens when an old workspace opens

Workspace initialization runs one ordered migration ladder. For the queue
history covered here, it first applies the v5 to v6 collapse, derives the v7
queue lifecycle, and later lifts the singular v9 queue record into the v10 map.
The same ladder then reshapes active Runs at v11, partitions history at v12, and
collapses persisted pause state at v13. Each step detects the record shape it
owns, so reopening an already-migrated workspace does not repeat the reshape.

<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/state/queue-state-migrator.ts -->
<!-- Source: src/state/run-state-migrator.ts -->
<!-- Source: src/state/history-state-migrator.ts -->
<!-- Source: tests/unit/state/forward-migration-ladder.test.ts -->

A state version newer than the runtime is refused rather than guessed at. The
error directs the operator to update the extension before opening that
workspace. Down-migration is unsupported.

<!-- Source: src/state/queue-state-migrator.ts -->
<!-- Source: src/contracts/state-schema.ts -->

## Exact v5 to v6 coalescing rule

The historical collapse performs these transformations:

1. It replaces the source registry with one `default` entry. That entry keeps
   the earliest source `createdAt`, clears its schedule, and receives the
   migration timestamp as `updatedAt`.
2. It keeps one in-flight task. If corrupted input contains more than one, the
   task from the earliest-created source queue remains in flight and the others
   become pending.
3. It appends pending tasks by source-queue `createdAt`, ascending, while
   preserving each source queue's order by task `position`.
4. It rewrites every task's `queueId` to `default` and densely numbers the
   in-flight and pending positions from zero.
5. If any persisted pause representation says a source queue was paused, the
   resulting queue is operator-paused. Otherwise it is not paused.

<!-- Source: src/state/queue-state-migrator.ts -->
<!-- Source: tests/unit/state/queue-state-migrator-v5-to-v6.test.ts -->

The migration deliberately did not retain enough origin data to recreate the
old lanes. When v10 restored plural queue execution state, it wrapped the
singular record in a map under `default` and fabricated no additional queues.
It preserved task order, positions, timestamps, the in-flight pointer, and the
pause fields while doing so. Operators can create and organize new queues in
the current model, but the pre-collapse lane assignment is not recoverable from
v9 state.

<!-- Source: src/state/queue-state-migrator.ts -->
<!-- Source: tests/unit/state/queue-state-migrator-v9-to-v10.test.ts -->
<!-- Source: src/queue/queue-registry.ts -->

## Resume preserved pending work

The v6 to v7 step leaves preserved pending work in `idle-pending`, with no
scheduled start time, and adds a one-time migration notice. In the queue detail
panel, use **Start queue** when you are ready. **Dismiss** only hides the notice;
it does not start the queue or change its scheduled-start fields.

<!-- Source: src/state/queue-state-migrator.ts -->
<!-- Source: webview-ui/src/components/drilldown/QueueIdlePendingPanel.svelte -->
<!-- Source: src/ui/sidebar/commands/cmd-dismiss-migration-notice.ts -->
<!-- Source: tests/unit/state/queue-state-migrator-v7.test.ts -->

## Verify the historical collapse

When a non-empty v5 workspace is coalesced, Schegent produces a best-effort
`state-migrated` audit entry with `fromVersion`, `toVersion`, source-queue,
pending-task and in-flight-task counts, whether a paused state was inherited,
and the `createdAt-ascending` coalescing rule. Audit append failure is logged but
does not block activation. A fresh workspace does not emit this migration
entry, and existing audit-log lines are not rewritten.

<!-- Source: src/state/migration-audit-forwarder.ts -->
<!-- Source: tests/integration/single-queue-migration.test.ts -->
