// Feature 092 (T096, FR-049, FR-054) — the webview's read seam for the
// per-queue runtimes the v4 snapshot publishes.
//
// v3 put one Run at the root and every surface read it as *the* Run. v4 deletes
// those singulars (FR-049), so each surface must now name the queue whose Run it
// means. These helpers are that naming step, spelled once. Nothing here rebuilds
// a workspace-wide singular: a caller that wants "the current run" still has to
// say which queue's, and a queue that owns no Run answers `null` rather than
// borrowing the neighbour's (FR-053).

import type { QueueRuntime, WorkflowSnapshot } from './snapshot-types';

/**
 * The id the registry gives its always-present first queue. Used only when the
 * host has not projected `queueSettings` yet — its `defaultQueueId` is
 * authoritative whenever it has arrived.
 *
 * FR-R3-145 (T1572) re-pointed the consumer below and left this comment naming
 * `generalSettings` and an "operator-settable `queue.defaultQueueId`". Neither
 * survives: the configuration key is gone, and the projection that governs this
 * fallback is `queueSettings`, which is optional on the webview mirror under the
 * usual legacy tolerance — so a host bundle predating this feature is exactly the
 * case that lands here.
 */
export const FALLBACK_QUEUE_ID = 'default';

type SnapshotLike = Pick<WorkflowSnapshot, 'queues' | 'queueSettings'> | null | undefined;

export function findQueueRuntime(
  snapshot: Pick<WorkflowSnapshot, 'queues'> | null | undefined,
  queueId: string
): QueueRuntime | null {
  return snapshot?.queues?.find((runtime) => runtime.queueId === queueId) ?? null;
}

/**
 * The queue a surface reads when the operator has made no explicit selection.
 *
 * FR-R3-145 (T1572) — from `queueSettings`, the memento projection, not from
 * `generalSettings`. Every surface that resolves a default queue now resolves it
 * from the same store the queue modal writes to (FR-011).
 */
export function defaultQueueId(snapshot: SnapshotLike): string {
  return snapshot?.queueSettings?.defaultQueueId ?? FALLBACK_QUEUE_ID;
}

/**
 * The default queue's runtime, or `null` when that queue owns no Run — which is
 * also what an idle snapshot (`queues: []`) answers. Slice E gives the operator a
 * real per-tier selection; until then this reproduces v3's reading exactly for a
 * workspace that has only the default queue.
 */
export function defaultQueueRuntime(snapshot: SnapshotLike): QueueRuntime | null {
  return findQueueRuntime(snapshot, defaultQueueId(snapshot));
}

/**
 * The runtime a task-scoped surface reads: the queue whose in-flight Run is for
 * `taskId` when one is, else the queue the task itself sits on, else the default
 * queue. The first branch matters because a task can be selected while its Run
 * executes on a queue the caller did not name; the last reproduces v3's reading
 * for a workspace that has only the default queue. A queue owning no Run still
 * answers with its own runtime — the empty projection lives inside it (FR-053).
 */
export function runtimeForTask(
  snapshot: SnapshotLike,
  taskId: string | null,
  taskQueueId: string | null | undefined
): QueueRuntime | null {
  const executing =
    taskId === null
      ? undefined
      : snapshot?.queues?.find((runtime) => runtime.inFlightRun?.feature?.id === taskId);
  return executing ?? findQueueRuntime(snapshot, taskQueueId ?? defaultQueueId(snapshot));
}
