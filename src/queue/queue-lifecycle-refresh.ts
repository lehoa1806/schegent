// The `queueLifecycle` writer for transitions that move work in or out of a
// queue without deciding anything about whether the queue may run.
//
// Extracted rather than left inline in `QueueManager` because two modules need
// it — the manager's own `markInFlight`/`finish`/`pause`/`cancel`/`retry`, and
// `commands/restart-canceled-task.ts`, which writes its `pending` transition
// through `store.updateQueue` directly. One definition is what keeps the
// held/unheld distinction below from being re-derived slightly differently in
// the second place.

import type { QueueState } from './feature-request';
import type { QueueLifecycle } from '../contracts/snapshot-vocabulary';

/**
 * Recompute the *unheld* half of `queueLifecycle` for a queue that has just
 * gained or lost in-flight/pending work. Takes the already-updated queue and
 * returns the lifecycle it should carry.
 *
 * `running` and `active-empty` are the two **unheld** lifecycles: both mean
 * "this queue drains automatically", and nothing in the product branches on the
 * difference — it is the operator-facing badge plus one audit classification in
 * `ScheduledStartCoordinator.classifySuperseder`. Until this function existed no
 * writer ran on the promotion or the Run-termination path at all, so
 * `markInFlight` and `finish` moved work in and out of a queue whose lifecycle
 * never moved with it: a queue that finished its last Task kept badging
 * "Running" with nothing in flight, and the staleness survived reloads because
 * the v6 to v7 migration is idempotent.
 *
 * `operator-paused` and `idle-pending` are **held** lifecycles, entered only by
 * an explicit hold decision (an operator pause, a resume that must not
 * auto-start, an armed scheduled start) and left only by an explicit release —
 * `setQueuePausedState`, `GuardedRunService.applyStartQueueIntent`, and the
 * scheduled-start coordinator own those transitions. Both are returned
 * untouched, which is what keeps this function out of the `idle-pending` gate:
 * it neither promotes a held queue nor holds an unheld one, so
 * `AutoDrainCoordinator.drainIfIdle` remains the single site that decides
 * whether an `idle-pending` queue may start.
 *
 * It must never *derive* `idle-pending`. `run-driver` calls
 * `scheduleAutoDrain()` after the terminal `finish()`, and `drainQueueOnce`
 * step 1 refuses an `idle-pending` queue — deriving it here would refuse every
 * queue's own continuation and stop each one dead after its first Task. Staying
 * inside the unheld pair also preserves the `scheduledStartAt` implies
 * `idle-pending` lockstep for free, since an armed schedule only ever sits on a
 * held queue and a held queue is returned unchanged.
 *
 * Admission is deliberately not a caller. `QueueManager.enqueue` writes no
 * lifecycle because `GuardedRunService.applyStartIntentPolicy` decides whether
 * newly admitted work runs or is held behind the FR-018 chooser, and its
 * `append-tail-no-chooser` branch preserves the lifecycle on purpose. Calling
 * this from `enqueue` would overrule that policy from underneath it.
 */
export function refreshUnheldLifecycle(queue: QueueState): QueueLifecycle {
  if (queue.queueLifecycle !== 'running' && queue.queueLifecycle !== 'active-empty') {
    return queue.queueLifecycle;
  }
  const hasWork =
    queue.inFlightId !== null || queue.requests.some((r) => r.status === 'pending');
  return hasWork ? 'running' : 'active-empty';
}

/**
 * The same thing as an `updateQueue` mapper writes it: the already-updated queue
 * carrying its refreshed lifecycle. Every call site is a mapper returning
 * `{ queue, result }`, and wrapping the queue it was already building keeps the
 * refresh from costing each one a restructure into a statement body.
 */
export function withRefreshedLifecycle(queue: QueueState): QueueState {
  return { ...queue, queueLifecycle: refreshUnheldLifecycle(queue) };
}
