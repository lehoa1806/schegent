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

import type { ActionCopyContext } from './action-copy';
import type { WorkflowSnapshot } from './snapshot-types';
import { defaultQueueRuntime } from './queue-runtime-view';

export type CleanAllContext = ActionCopyContext['queue.clean-all'];

// Pull every impact-inventory field for the Clean All confirmation
// modal directly off the projected snapshot. `pauseSource` for the
// default queue takes precedence over the legacy top-level `paused`
// flag — the queue summary carries the 'operator' vs 'cascade'
// distinction (Feature 028) that the body template renders.
export function deriveCleanAllContext(snapshot: WorkflowSnapshot): CleanAllContext {
  const queue = snapshot.queue;
  const completedCount = queue.recent.filter((r) => r.status === 'completed').length;
  const failedCount = queue.recent.filter((r) => r.status === 'failed').length;
  const canceledCount = queue.recent.filter((r) => r.status === 'canceled').length;
  const pendingCount = queue.pending.length;
  const inflightTitle = queue.inFlight?.label ?? null;
  const defaultQueue = queue.queues?.[0] ?? null;
  const pauseSource: CleanAllContext['pauseSource'] = defaultQueue
    ? defaultQueue.pauseSource
    : queue.paused
      ? 'operator'
      : null;
  // Feature 092 — the impact inventory is the default queue's, matching every
  // other count above it, which all read `snapshot.queue`.
  const hasActiveRun = (defaultQueueRuntime(snapshot)?.inFlightRun ?? null) !== null;
  return {
    pendingCount,
    completedCount,
    failedCount,
    canceledCount,
    inflightTitle,
    pauseSource,
    hasActiveRun
  };
}
