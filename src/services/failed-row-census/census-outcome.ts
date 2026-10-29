// ---------------------------------------------------------------------------
// FR-R4-F16 (feature 244, contract E4; research R10) — pass 2 of the failed-row census, second half:
// the one outcome of each episode.
//
// Pure. Each episode gets exactly one `Disposition` or one `UnknownReason` (FR-009), by the first rule
// that applies:
//
//   1. No single queue: unknown (`queue-unresolved`).
//   2. A next event: the event decides, and nothing is repaired.
//   3. No next event and a gap passed: unknown (`history-gap`). The snapshot row's status is shown
//      beside it and never used.
//   4. No next event: the snapshot rows in the episode's queue decide, or say why they cannot.
//
// "Attested" is read from one place only: the ending removal's `provenance`, or the snapshot row's
// `attested` flag (FR-011). A status of `completed` is never enough, a start is never inferred from a
// row, and a removal that did not record provenance is an unknown, never an attestation.
// ---------------------------------------------------------------------------

import type { EpisodeDraft } from './census-episodes';
import type { Disposition, Episode, QueueSnapshot, SnapshotRow, UnknownReason } from './census-model';

type Outcome = Episode['outcome'];

export interface EpisodeOutcome {
  readonly outcome: Outcome;
  readonly snapshotStatus: Episode['snapshotStatus'];
}

/** The snapshot's rows by queue and task id. */
export interface SnapshotIndex {
  rowsIn(queueId: string, taskId: string): readonly SnapshotRow[];
}

export function indexSnapshot(snapshot: QueueSnapshot): SnapshotIndex {
  const byQueue = new Map<string, Map<string, SnapshotRow[]>>();
  for (const queue of snapshot.queues) {
    const byTask = new Map<string, SnapshotRow[]>();
    for (const row of queue.rows) {
      const rows = byTask.get(row.taskId);
      if (rows === undefined) byTask.set(row.taskId, [row]);
      else rows.push(row);
    }
    byQueue.set(queue.queueId, byTask);
  }
  return { rowsIn: (queueId, taskId) => byQueue.get(queueId)?.get(taskId) ?? [] };
}

const disposition = (value: Disposition): Outcome => ({ kind: 'disposition', disposition: value });
const unknown = (reason: UnknownReason): Outcome => ({ kind: 'unknown', reason });

/** Rule 2: what the first next event says. */
function outcomeOfEnd(end: NonNullable<EpisodeDraft['end']>): Outcome {
  switch (end.kind) {
    case 'started':
      return disposition(end.isResume ? 'resumed' : 'restarted-fresh');
    case 'removed':
      if (end.priorStatus === 'completed') {
        if (end.provenance === 'attested') return disposition('attested-removed');
        return unknown(end.provenance === 'null' ? 'completed-without-attestation' : 'provenance-not-recorded');
      }
      return disposition(end.priorStatus === 'failed' ? 'removed-failed' : 'removed-other');
    case 'queue-deleted':
      return disposition('queue-deleted');
    case 'queue-cleared':
    case 'queue-cleared-all':
      return disposition('queue-cleared');
  }
}

/** Rule 4: the snapshot rows in the episode's queue with its task id. */
function outcomeOfSnapshot(draft: EpisodeDraft, rows: readonly SnapshotRow[]): Outcome {
  if (rows.length !== 1) return unknown(rows.length === 0 ? 'row-absent' : 'snapshot-mismatch');
  const row = rows[0] as SnapshotRow;
  const ownRun = row.runId === draft.runId;
  if (ownRun && row.status === 'completed' && row.attested) return disposition('attested-kept');
  if (ownRun && row.status === 'failed') return disposition('still-failed');
  if ((ownRun || row.runId === null) && row.status === 'pending') return disposition('retry-requested');
  return unknown('snapshot-mismatch');
}

/** The one outcome of `draft`, and the snapshot status shown beside a `history-gap`. */
export function decideOutcome(draft: EpisodeDraft, snapshot: SnapshotIndex): EpisodeOutcome {
  if (draft.queueId === null) return { outcome: unknown('queue-unresolved'), snapshotStatus: null };
  if (draft.end !== null) return { outcome: outcomeOfEnd(draft.end), snapshotStatus: null };
  const rows = snapshot.rowsIn(draft.queueId, draft.taskId);
  if (draft.gapped) {
    return {
      outcome: unknown('history-gap'),
      snapshotStatus: rows.length === 1 ? (rows[0] as SnapshotRow).status : 'absent'
    };
  }
  return { outcome: outcomeOfSnapshot(draft, rows), snapshotStatus: null };
}
