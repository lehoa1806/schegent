// Feature 092 (T109, FR-047) — derive the Queue Detail tier's row list.
//
// FR-047: a connected run occupies ONE row, not one row per node. The collapse is
// derived here rather than published, because the host already carries what it
// needs: each `ConnectedNodeProjection` names the queue item its most recent
// attempt used (`latestQueueItemId`), so membership is a set of Task ids and the
// row is a fold over the Tasks the queue already holds.
//
// Deriving it means the wire gains nothing for the tier: no per-row `queueId`, no
// second membership list to keep in step with the aggregate. It also means a
// connected run whose nodes name Tasks this queue does not hold produces no row
// here — that run belongs to another queue, and the tier must not fabricate a row
// out of ids it cannot resolve.

import type { ConnectedRunProjection, QueueItem, QueueItemStatus } from './snapshot-types';

/**
 * One connected run as the Queue Detail tier lists it. Every field is a reading
 * of the run's member Tasks or of the projection itself, so a row can be
 * rendered without a second lookup.
 */
export interface ConnectedRunRow {
  readonly connectedRunId: string;
  readonly workflowId: string;
  /** Position of the earliest member Task, so a row sorts among standalone Tasks. */
  readonly position: number;
  /** Label of the earliest member Task — the row's stand-in name. */
  readonly label: string;
  /** The most advanced member status, by `STATUS_PRECEDENCE` below. */
  readonly status: QueueItemStatus;
  readonly memberTaskIds: readonly string[];
  /** Nodes in the aggregate, including those that have not run yet. */
  readonly nodeCount: number;
  /** Member Tasks that have completed — `n of nodeCount` in the UI. */
  readonly completedNodeCount: number;
  readonly hydrating: boolean;
}

export interface QueueRunRows {
  readonly rows: readonly ConnectedRunRow[];
  readonly standaloneTasks: readonly QueueItem[];
}

/**
 * Which member status the row reports when members disagree. A run with one
 * member still executing reads as `in-flight` however many have finished, because
 * that is what the operator needs to see at a glance; a terminal reading only
 * wins once nothing is live.
 *
 * `in-flight` is this family's vocabulary deliberately — `QueueItemStatus` has no
 * member spelled the way the pinned status projection spells its live value, and
 * this file does not widen that literal.
 */
const STATUS_PRECEDENCE: readonly QueueItemStatus[] = [
  'in-flight',
  'paused',
  'failed',
  'canceled',
  'pending',
  'completed'
];

function summariseStatus(members: readonly QueueItem[]): QueueItemStatus {
  for (const candidate of STATUS_PRECEDENCE) {
    if (members.some((member) => member.status === candidate)) return candidate;
  }
  return 'pending';
}

function memberIdsOf(run: ConnectedRunProjection): readonly string[] {
  // A node with no `latestQueueItemId` has not run yet. It is part of the
  // aggregate — hence `nodeCount` — but it is not a Task on any queue.
  return run.nodes
    .map((node) => node.latestQueueItemId)
    .filter((id): id is string => id !== undefined && id.length > 0);
}

export function buildQueueRunRows(
  tasks: readonly QueueItem[],
  connectedRuns: readonly ConnectedRunProjection[] | undefined
): QueueRunRows {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const claimed = new Set<string>();
  const rows: ConnectedRunRow[] = [];

  for (const run of connectedRuns ?? []) {
    // First claim wins. Two runs naming one Task is not a shape the host should
    // publish, and the tier must not list the same Task under two rows if it does.
    const members = memberIdsOf(run)
      .filter((id) => !claimed.has(id))
      .map((id) => byId.get(id))
      .filter((item): item is QueueItem => item !== undefined);
    if (members.length === 0) continue;

    for (const member of members) claimed.add(member.id);
    const ordered = members.slice().sort((a, b) => a.position - b.position);
    const first = ordered[0] as QueueItem;
    rows.push(
      Object.freeze({
        connectedRunId: run.connectedRunId,
        workflowId: run.workflowId,
        position: first.position,
        label: first.label,
        status: summariseStatus(ordered),
        memberTaskIds: Object.freeze(ordered.map((item) => item.id)),
        nodeCount: run.nodes.length,
        completedNodeCount: ordered.filter((item) => item.status === 'completed').length,
        hydrating: run.hydrating
      })
    );
  }

  return Object.freeze({
    rows: Object.freeze(rows.slice().sort((a, b) => a.position - b.position)),
    standaloneTasks: Object.freeze(tasks.filter((item) => !claimed.has(item.id)))
  });
}
