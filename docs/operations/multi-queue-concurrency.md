# Multi-queue concurrency

Schegent can keep 1–20 local Queues. The reserved `default` Queue must always exist; other Queue IDs are UUIDv4 values, names are case-insensitively unique, and positions are contiguous. Each Queue owns its own ordered Task list and at most one in-flight Task.

<!-- Source: src/queue/queue-registry.ts -->
<!-- Source: src/queue/queue-manager.ts -->

## Two independent caps

The per-Queue capacity is fixed at one. The workspace-wide `schegent.queue.globalConcurrencyCap` setting limits how many Queues can be active simultaneously; its default is `1` and its accepted range is `[1, 20]`. An out-of-range value is refused instead of clamped.

<!-- Source: src/queue/queue-manager.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: package.json -->

Raising the global cap enables simultaneous Runs in one checkout. It does not create separate worktrees, file locks, or merge isolation. Tasks in different Queues may edit the same files, so use a value above one only when the selected Pipelines can safely share the working tree.

<!-- Source: src/services/auto-drain-coordinator.ts -->
<!-- Source: src/state/execution-lease.ts -->

## Admission order

For each Queue, the drain coordinator checks that the Queue exists, is not paused, has no in-flight Task, the workspace remains under its global cap, a pending head exists, and this host can acquire that Queue's execution lease. It rechecks the lease at the point of effect before starting work. A round-robin cursor prevents the first Queue from always winning when the global cap is saturated.

<!-- Source: src/services/auto-drain-coordinator.ts -->

An execution lease is scoped to one Queue. Window primacy and execution leases solve different problems: primacy fences workspace mutations to an authoritative Extension Host, while a Queue lease prevents two local hosts from draining the same Queue. Leases heartbeat and become reclaimable after the shared stale interval.

<!-- Source: src/state/execution-lease.ts -->
<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/ui/sidebar/commands/primacy-gate.ts -->

## Operator guidance

1. Keep the global cap at `1` for Pipelines that may touch overlapping files or Git state.
2. Put independent work in separate Queues before raising the cap.
3. Pause a Queue to stop its pending head from being admitted; pausing does not rewrite another Queue.
4. If work appears stalled, confirm the Queue lifecycle, workspace-capacity count, and execution-lease ownership in the runtime evidence before retrying.

<!-- Source: src/queue/queue-manager.ts -->
<!-- Source: src/services/auto-drain-coordinator.ts -->
<!-- Source: src/state/execution-lease.ts -->
