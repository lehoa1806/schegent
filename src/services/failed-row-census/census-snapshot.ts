// ---------------------------------------------------------------------------
// FR-R4-F16 (feature 244, contract E1; data-model §4) — the queue state the census compares the log
// against, reduced to the fields it needs.
//
// Pure. `toQueueSnapshot` copies, per persisted queue, its stored failure policy and, per row, the
// task id, the status, the Run id and whether the row carries a recognized completion provenance.
// A title, `lastError`, a timestamp or any other row field is never copied, so no row text can reach
// the census or its report. The stored policy is read as the host reads it
// (`effectiveQueueFailurePolicy`): a value outside the vocabulary is absent, never carried.
// ---------------------------------------------------------------------------

import { isCompletionProvenance } from '../../contracts/completion-provenance';
import { QUEUE_FAILURE_POLICIES, type QueueFailurePolicy } from '../../contracts/queue-failure-policy';
import type { QueueStateMap } from '../../state/queue-state-migrator';
import type { QueueSnapshot, SnapshotQueue } from './census-model';

function storedPolicyOf(value: unknown): QueueFailurePolicy | null {
  return typeof value === 'string' && (QUEUE_FAILURE_POLICIES as readonly string[]).includes(value)
    ? (value as QueueFailurePolicy)
    : null;
}

/** The snapshot of `states` at `cutoffMs`, queues in sorted id order. */
export function toQueueSnapshot(
  states: QueueStateMap,
  workspaceDefaultPolicy: QueueFailurePolicy,
  cutoffMs: number
): QueueSnapshot {
  const queues: SnapshotQueue[] = Object.entries(states)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([queueId, state]) => ({
      queueId,
      storedPolicy: storedPolicyOf(state.failurePolicy),
      rows: state.requests.map((row) => ({
        taskId: row.id,
        status: row.status,
        runId: row.runId ?? null,
        attested: isCompletionProvenance(row.completionProvenance)
      }))
    }));
  return { cutoffMs, queues, workspaceDefaultPolicy };
}
