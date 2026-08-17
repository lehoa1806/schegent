# Schedule Multiple Features

Schegent executes one workflow at a time. Multiple feature requests are handled by the queue — and, since multiple queues arrived, by as many as twenty independently scheduled queues that take turns at the run engine. This page covers enqueueing and draining; for creating, naming and scheduling queues see [Multiple queues and concurrency](multi-queue-concurrency.md).

## Enqueue

- **Dashboard**: open the Dashboard via the sidebar's **Open Dashboard** button or **Schegent: Open Dashboard**, type the description into the queue input, and submit.
- **Command Palette**: **Schegent: Enqueue Feature Request** (`schegent.schedule`).

The first enqueued item starts immediately if no run is in flight; subsequent items wait in `pending`.

## Auto-drain

After every terminal completion (`completed | failed | cancelled`), the queue manager checks for the next `pending` item and starts it — provided that queue is not paused.

There is no separate scheduler. The drain hook lives in `AutoDrainCoordinator.drainIfIdle(queueId)` ([src/services/auto-drain-coordinator.ts](../../src/services/auto-drain-coordinator.ts)) and fires inside the same `finally` block that releases the workspace lock; `drainAll()` sweeps every queue in the registry from a rotating cursor, so no queue starves behind a busier sibling. Earlier versions hosted this on the controller directly; the responsibility was extracted into the standalone coordinator during the Feature 056 Track 7 decomposition pass to break a type-only cycle between the controller and the coordinator. Audit log shows a `queue.auto-drain` entry on every transition.

## Queue Management UI

The primary place to manage a queue is the Schegent dashboard's **Queue Detail** tier — open the sidebar's dashboard link, pick a queue on **Queues**, then its card. Pause, resume, retry, and reorder are per-queue controls on that tier, not a single global panel; see [Multiple queues and concurrency](multi-queue-concurrency.md) for delete, move, and workspace-settings controls. The [Dashboard UI/UX Guide](dashboard-ui.md) this section used to point to describes feature 097's now-deleted single-page layout and is retained only for historical reference.

## Status taxonomy

The canonical statuses are `pending | in-flight | completed | failed | cancelled`. The literal `running` is **not** used anywhere in the queue status badges. If you see `running` in your code review, treat it as a bug.

## Failure handling

A failed item carries `lastError` populated with `SanitizedFailureMetadata`:

```json
{
  "code": "phase-failed",
  "message": "[redacted message]",
  "phase": "implement",
  "correlationId": "8d3f...e2a"
}
```

Use the `correlationId` to correlate against the audit log — see [debug-stuck-runs.md](debug-stuck-runs.md).

## Limits

- Queue capacity: limited by VS Code `workspaceState` size (~practical thousands).
- Render performance: 50-item queue projects in well under 50 ms — see [performance.md](performance.md) if you have a larger expected workload.

