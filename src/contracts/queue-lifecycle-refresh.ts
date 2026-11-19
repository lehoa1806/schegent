/**
 * FR-R7-07 — Relocated from `src/queue/queue-lifecycle-refresh.ts` into
 * `src/contracts/` so `src/state/` can recompute the unheld half of
 * `queueLifecycle` without value-importing `src/queue/`.
 * `src/queue/queue-lifecycle-refresh.ts` re-exports both functions unchanged.
 */

import type { QueueState } from '../queue/feature-request';
import type { QueueLifecycle } from './snapshot-vocabulary';

/**
 * Recompute the *unheld* half of `queueLifecycle` for a queue that has just
 * gained or lost in-flight/pending work. Held lifecycles (`operator-paused`,
 * `idle-pending`) are returned untouched so `AutoDrainCoordinator.drainIfIdle`
 * remains the single site deciding whether an `idle-pending` queue may start.
 */
export function refreshUnheldLifecycle(queue: QueueState): QueueLifecycle {
  if (queue.queueLifecycle !== 'running' && queue.queueLifecycle !== 'active-empty') {
    return queue.queueLifecycle;
  }
  const hasWork =
    queue.inFlightId !== null || queue.requests.some((r) => r.status === 'pending');
  return hasWork ? 'running' : 'active-empty';
}

export function withRefreshedLifecycle(queue: QueueState): QueueState {
  return { ...queue, queueLifecycle: refreshUnheldLifecycle(queue) };
}
