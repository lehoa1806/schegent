# Multi-queue concurrency

Schegent can keep 1–20 local Queues. The reserved `default` Queue must always exist; other Queue IDs are UUIDv4 values, names are case-insensitively unique, and positions are contiguous. Each Queue owns its own ordered Task list and at most one in-flight Task.

<!-- Source: src/queue/queue-registry.ts -->
<!-- Source: src/queue/queue-manager.ts -->

## Two independent caps

The per-Queue capacity is fixed at one. The workspace-wide cap limits how many Queues can be active simultaneously; its default is `1` and its accepted range is `[1, 20]`. An out-of-range value is refused instead of clamped.

Set it in the **Queue configuration** surface, not in `settings.json`. The cap is workspace state, held under `schegent.queue.globalConcurrencyCap` in the workspace memento and written by the `CMD_SAVE_QUEUE_SETTINGS` save; that memento is the store both drain predicates read, so the number the surface shows is the number admission gates on. It is per workspace, so raising it in one workspace does not raise it in another.

<!-- Source: src/queue/queue-manager.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/contracts/sidebar-ipc/queue.ts -->

Raising the global cap enables simultaneous Runs in one checkout. It does not create separate worktrees, file locks, or merge isolation. Tasks in different Queues may edit the same files, so use a value above one only when the selected Pipelines can safely share the working tree.

**Recommended value: `2`, and the reason is measured rather than cautious** (`FR-R3-124`, 2026-08-27; [concurrent-run isolation measurement](concurrent-run-isolation-measurement.md)). Disjoint concurrent work is fully attributable at every level tested — at 8 Runs every Run still receives a patch containing only its own work. But a **single** path written by two Runs costs *every* Run that declared it its recovery checkpoint, with no partial result: at 8 Runs sharing one file, the measurement recorded 8 declines and 0 patches. Nothing degrades between 2 and 8; what grows is the number of Run pairs that could contest a path — 1 at a cap of 2, 6 at 4, 28 at 8 — and being wrong about any one of them is total for its participants. Two Runs is what an operator can actually verify in advance.

The permitted maximum stays 20 and the default stays 1. Per-Run working-tree isolation would retire this recommendation rather than raise it; its shape is decided and its implementation is gated in [the run-isolation decision record](../architecture/run-isolation-decision.md).

<!-- Source: src/services/auto-drain-coordinator.ts -->
<!-- Source: src/state/execution-lease.ts -->
<!-- Source: docs/operations/concurrent-run-isolation-measurement.md -->
<!-- Source: docs/architecture/run-isolation-decision.md -->

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


## What concurrency costs, measured

The aggregate resource question that comes with raising `globalConcurrencyCap` is answered by
measurement rather than by arithmetic, in
[Concurrent-run resource measurement](concurrent-run-resource-measurement.md): resident heap and file
descriptors at the maximum cap, the method, and the tree the figures were taken on. It also records
why no admission-control mechanism was built, which is the kind of decision that is only defensible
with the numbers beside it.
