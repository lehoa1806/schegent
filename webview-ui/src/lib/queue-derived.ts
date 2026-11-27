// Feature 063 (US3, T049) — derived context for the
// `useConfirm('queue.clean-all', { context })` call. Centralizing the
// derivation lets the unit test in
// `__tests__/clean-all-context.test.ts` cover every code path
// (empty queue, in-flight task, paused-by-cascade, active run) in
// isolation from Dashboard rendering.
//
// The return type intentionally mirrors `ActionCopyContext['queue.clean-all']`
// so the call site can pass the result straight through without
// reshaping.
//
// FR-R3-150 (T1622a/T1622b) — both derivations now take the addressed
// `queueId` and resolve every field from that queue's own projection —
// `findQueueRuntime` for tasks/run, `snapshot.queue.queues` for
// pause/schedule — never from `snapshot.queue`/`defaultQueueRuntime`, which
// answered only for the reserved queue regardless of which queue's
// confirmation was showing (FR-001).

import type { ActionCopyContext } from './action-copy';
import type { QueueItem, QueueItemStatus, WorkflowSnapshot } from './snapshot-types';
import { defaultQueueId, findQueueRuntime } from './queue-runtime-view';

export type CleanAllContext = ActionCopyContext['queue.clean-all'];
export type ClearDoneContext = ActionCopyContext['queue.clear-done'];

// Code-review finding (reuse) — the one fold both derivations below need:
// how many of a queue's own tasks are in a given status. Shared so the
// "completed" definition (and any other status the two confirmations grow
// to need) is written once, not once per confirmation.
function countByStatus(tasks: readonly QueueItem[], status: QueueItemStatus): number {
  return tasks.filter((t) => t.status === status).length;
}

// Pull every impact-inventory field for the Clean All confirmation modal
// directly off the addressed queue's own projection: `QueueRuntime.tasks`
// for the counts and in-flight title, `QueueSummary` (`snapshot.queue.queues`)
// for pause source — the one per-queue array that actually carries it, keyed
// by `id` rather than by array position.
//
// Code-review finding — `hasSchedule` does NOT read `QueueSummary.schedule`.
// That field is the registry-level schedule mechanism `queue-manager.ts`'s
// own header comment documents as dead in practice (Feature 097 removed its
// only non-null writer, so it is permanently `null`). The armed schedule
// `QueueManager.clearQueue` actually resets is `QueueState.scheduledStartAt`.
//
// Code-review finding (iteration 5) — and that value IS projected per queue.
// The two previous iterations of this comment asserted it was not, and built
// a lifecycle heuristic on that premise; both were wrong in tree.
// `QueueRuntime.scheduledStartAt` is a required, non-optional `number | null`
// (`snapshot-types.ts`, FR-R3-152), written for every queue by
// `queue-runtime-composer.ts` off that queue's own `QueueState`, and already
// read live one property access deep by `QueueIdlePendingPanel.svelte`. So
// the authoritative read is available here, and the heuristic it replaced was
// wrong in BOTH directions:
//
//   - it UNDER-reported the primary armed-schedule shape. `applyStartIntentPolicy`'s
//     `scheduled` branch arms `scheduledStartAt` and leaves the task it just
//     enqueued `pending`, so `pendingCount >= 1` and the confirmation omitted
//     the schedule cancellation `clearQueue` then performs — an undisclosed
//     destructive consequence in a destructive confirmation, which is the one
//     thing this context object exists to prevent.
//   - it OVER-reported. `cancel-schedule` clears the schedule but deliberately
//     holds `idle-pending`, and no refresher recomputes a held lifecycle, so a
//     queue with no schedule at all read `hasSchedule: true` indefinitely.
export function deriveCleanAllContext(snapshot: WorkflowSnapshot, queueId: string): CleanAllContext {
  const runtime = findQueueRuntime(snapshot, queueId);
  const summary = snapshot.queue.queues?.find((q) => q.id === queueId) ?? null;
  const tasks = runtime?.tasks ?? [];
  // Code-review finding (iteration 5) — BUG-006/FR-026: a `paused` row has to
  // be placed, because `clearQueue` destroys it either way. `queue-projector.ts`
  // is the rule this mirrors: the queue's ACTIVE row is the `in-flight` one, or
  // a `paused` one while `inFlightId` is preserved (the rate-limit/system pause
  // path keeps the pointer); a `paused` row that is NOT the active one is a
  // pending row, because the operator-pause path clears the pointer.
  //
  // Scanning only for `'in-flight'` put a system-paused task in NONE of the
  // five impact figures — not `inflightTitle`, and not `pendingCount`, which is
  // the host's `status === 'pending'` count and excludes `paused` by
  // construction. A rate-limit-paused queue therefore offered "0 pending, 0
  // completed, 0 failed, 0 canceled" for a queue still holding a task, and
  // never named the task Clean All was about to abort.
  const activeTaskId = runtime?.inFlightRun?.feature?.id ?? null;
  const activeTask =
    tasks.find((t) => t.status === 'in-flight') ??
    tasks.find((t) => t.status === 'paused' && t.id === activeTaskId) ??
    null;
  const inflightTitle = activeTask?.label ?? null;
  const pausedPendingCount = tasks.filter(
    (t) => t.status === 'paused' && t.id !== activeTask?.id
  ).length;
  // Code-review finding — `summary` is `null` whenever `queue.queues` hasn't
  // arrived yet (still optional on `QueueProjection`) or doesn't carry this
  // queue. For the reserved/default queue only, the legacy top-level
  // `queue.paused` boolean is a real (if source-less) signal predating
  // per-queue `pauseSource`; falling back to it here for that one queue
  // matches this function's pre-FR-R3-150 behavior instead of silently
  // under-reporting an active pause. A non-default queue has no legacy
  // single-queue field describing it, so it still reads `null`.
  //
  // Code-review finding (iteration 4) — this MUST branch on `summary` being
  // absent, not on `summary.pauseSource` being falsy. `summary?.pauseSource
  // ?? fallback` treats a present summary whose `pauseSource` is
  // authoritatively `null` (queue genuinely not paused) the same as a
  // missing summary, so a stale legacy `queue.paused: true` on an otherwise
  // correctly-reporting default queue would still surface a false-positive
  // "and clear the operator pause". The fallback is only for missing data.
  const pauseSource =
    summary !== null
      ? summary.pauseSource
      : queueId === defaultQueueId(snapshot) && snapshot.queue.paused
        ? 'operator'
        : null;
  return {
    queueId,
    queueName: runtime?.name ?? summary?.name ?? queueId,
    pendingCount: (runtime?.pendingCount ?? 0) + pausedPendingCount,
    completedCount: countByStatus(tasks, 'completed'),
    failedCount: countByStatus(tasks, 'failed'),
    canceledCount: countByStatus(tasks, 'canceled'),
    inflightTitle,
    pauseSource,
    hasActiveRun: (runtime?.inFlightRun ?? null) !== null,
    hasSchedule: (runtime?.scheduledStartAt ?? null) !== null
  };
}

// FR-R3-150 (T1622b) — the Clear Done analogue, replacing the inline
// `{ completedCount }` literal `QueueDetailTier.svelte` used to build
// (which never named a queue, so its confirmation was silently the
// component's own selected queue in wording only, not in a shape the
// template could name).
export function deriveClearDoneContext(snapshot: WorkflowSnapshot, queueId: string): ClearDoneContext {
  const runtime = findQueueRuntime(snapshot, queueId);
  return {
    queueId,
    queueName: runtime?.name ?? queueId,
    completedCount: countByStatus(runtime?.tasks ?? [], 'completed')
  };
}
