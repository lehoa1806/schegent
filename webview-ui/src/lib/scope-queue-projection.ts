// Feature 092 (T108, FR-053, FR-057) — one queue's `QueueProjection`.
//
// `snapshot.queue` is the *default* queue's projection, and every queue-surface
// pane reads that shape. The Queue Detail tier shows a queue the operator named,
// which may be any of them. Rather than thread a queue id through every pane,
// this rebuilds the same shape from the named queue's own rows
// (`QueueRuntime.tasks`, FR-057) and its own `QueueSummary`.
//
// A projection, not a store: nothing here mutates and nothing is cached, so the
// unscoped path — `queueId === undefined`, which keeps reading `snapshot.queue`
// verbatim — is byte-for-byte what it was before the tier existed.
//
// A queue the snapshot does not carry answers the empty projection rather than
// throwing or falling back to the default queue's rows. FR-062 wants the tier to
// land the operator somewhere with an explanation, and a silent substitution
// would show them another queue's work under the missing queue's name.

import type { QueueItem, QueueProjection, WorkflowSnapshot } from './snapshot-types';
import { findQueueRuntime } from './queue-runtime-view';

const EMPTY_ROWS: readonly QueueItem[] = Object.freeze([]);

type SnapshotLike = Pick<WorkflowSnapshot, 'queue' | 'queues'>;

export function scopeQueueProjection(snapshot: SnapshotLike, queueId: string): QueueProjection {
  const runtime = findQueueRuntime(snapshot, queueId);
  const summary = snapshot.queue.queues?.find((entry) => entry.id === queueId) ?? null;
  const rows = [...(runtime?.tasks ?? EMPTY_ROWS)].sort((a, b) => a.position - b.position);

  // The row the queue's Run is executing. Usually the `in-flight` row, but a
  // breakpoint- or operator-paused Run still holds the slot: its row reads
  // `paused` while the queue is anything but free, so the tier must not show the
  // slot as empty.
  const executingId = runtime?.inFlightRun?.feature?.id ?? null;
  const inFlight =
    rows.find((row) => row.status === 'in-flight') ??
    (executingId === null ? undefined : rows.find((row) => row.id === executingId)) ??
    null;

  const isHistory = (row: QueueItem): boolean =>
    row.status === 'completed' || row.status === 'failed' || row.status === 'canceled';

  return Object.freeze({
    inFlight,
    pending: Object.freeze(
      rows.filter((row) => row.id !== inFlight?.id && !isHistory(row))
    ),
    recent: Object.freeze(rows.filter(isHistory)),
    orderedItems: Object.freeze(rows),
    ...(snapshot.queue.queues !== undefined ? { queues: snapshot.queue.queues } : {}),
    paused: summary?.state === 'manually-paused',
    pausedReason: null,
    ...(runtime !== null ? { lifecycle: runtime.lifecycle } : {}),
    scheduledStartAt:
      summary?.schedule?.targetAt !== undefined ? Date.parse(summary.schedule.targetAt) : null,
    scheduledStartSource: null
  });
}
