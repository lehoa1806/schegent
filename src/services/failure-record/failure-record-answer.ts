// ---------------------------------------------------------------------------
// FR-R4-F15 (feature 243, contract Q3) — what the read request answers, as one pure decision.
//
// The service gathers the facts (the row, the records on disk, history, the retention setting, the
// clock) and this function decides, so the nine rows of the table are testable without a filesystem or
// a clock and cannot be reordered by a refactor of the gathering code.
//
// WHAT THE ROW STANDS FOR. A queue keeps only its latest Run, so a failed row's Run may no longer be
// stored, and `WorkflowRun` has no end time. The answer reads the ROW instead: `status: 'failed'`
// stands for "the Run's status is failed", and the `completedAt` the queue sets in the same write
// stands for its end time (research R11, clarifications Q2 and Q4). A row that has been resumed is no
// longer `failed`, so it is never `expired`; it is `unavailable` while history still holds the Run's
// failed entry (history keeps 50 per queue), and `none` once that entry is gone and no record remains.
// ---------------------------------------------------------------------------

import type { ReadFailureRecordResponse } from '../../contracts/sidebar-ipc';
import type { ReadNewestOutcome } from './failure-record-store';

/** The three row fields the decision reads. A `FeatureRequest` satisfies this. */
export interface AnswerRow {
  readonly runId: string | null;
  readonly status: string;
  readonly completedAt: number | null;
}

export interface FailureRecordAnswerFacts {
  /** What the request named, echoed in the answer. */
  readonly queueId: string;
  readonly taskId: string;
  /** The row in the requesting window's queue state, or `null` when it holds none for the pair. */
  readonly row: AnswerRow | null;
  /** The Run's newest record, read. `none` when the facts were not needed, as for a row with no Run. */
  readonly newest: ReadNewestOutcome;
  /** History holds an entry for the row's Run whose terminal status is `failed`. */
  readonly historyHasFailedEntry: boolean;
  readonly maxAgeMs: number;
  readonly nowMs: number;
}

/**
 * Q3 — the nine rows, in order. The first that holds decides.
 *
 * Rows 4 and 5 do not look at the row's status, so a Run that failed, was resumed, and is now in flight,
 * completed or failed again answers with its newest record. They also come before row 6, so a record
 * still on disk is never called `expired`, even after a setting change that the next sweep will act on.
 */
export function decideFailureRecordAnswer(facts: FailureRecordAnswerFacts): ReadFailureRecordResponse {
  const { queueId, taskId, row, newest } = facts;
  const address = { queueId, taskId };
  if (row === null) return { outcome: 'failure', reason: 'unknown-row' };
  if (row.runId === null) return { outcome: 'none', ...address };
  if (newest.outcome === 'unreadable') return { outcome: 'unavailable', ...address };
  if (newest.outcome === 'read') {
    return { outcome: 'available', ...address, record: newest.record, recordCount: newest.recordCount };
  }
  if (newest.outcome === 'malformed') return { outcome: 'malformed', ...address, recordCount: newest.recordCount };
  if (row.status === 'failed') {
    const expired = row.completedAt !== null && facts.nowMs - row.completedAt > facts.maxAgeMs;
    return { outcome: expired ? 'expired' : 'unavailable', ...address };
  }
  if (facts.historyHasFailedEntry) return { outcome: 'unavailable', ...address };
  return { outcome: 'none', ...address };
}
