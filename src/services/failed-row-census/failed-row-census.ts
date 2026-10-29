// ---------------------------------------------------------------------------
// FR-R4-F16 (feature 244, contract E5) — the failed-row census: how each failed row was resolved.
//
// `runFailedRowCensus(log, snapshot)` forms the episodes (`census-episodes.ts`), gives each exactly one
// outcome (`census-outcome.ts`) and counts them. Pure: no I/O, no clock, no `vscode`. The totals write
// every cause by every disposition and by `unknown`, zeros included, so two reports line up; unknowns
// are also counted by reason and are never folded into a disposition (FR-009).
//
// The reconciliation of data-model §7 is a property of the result, not a promise of the procedure: the
// report prints both sides whether or not they agree, and the tests assert them for every history.
// ---------------------------------------------------------------------------

import { FAILURE_CAUSES } from '../../contracts/failure-cause';
import { collectEpisodes } from './census-episodes';
import {
  DISPOSITIONS,
  UNKNOWN_REASONS,
  type CensusCause,
  type CensusLog,
  type CensusResult,
  type Disposition,
  type Episode,
  type QueueSnapshot,
  type UnknownReason
} from './census-model';
import { decideOutcome, indexSnapshot } from './census-outcome';

type Column = Disposition | 'unknown';

const CENSUS_CAUSES: readonly CensusCause[] = [...FAILURE_CAUSES, 'not-recorded'];

function emptyTotals(): Record<CensusCause, Record<Column, number>> {
  const totals = {} as Record<CensusCause, Record<Column, number>>;
  for (const cause of CENSUS_CAUSES) {
    const row = {} as Record<Column, number>;
    for (const disposition of DISPOSITIONS) row[disposition] = 0;
    row.unknown = 0;
    totals[cause] = row;
  }
  return totals;
}

function emptyUnknowns(): Record<UnknownReason, number> {
  const counts = {} as Record<UnknownReason, number>;
  for (const reason of UNKNOWN_REASONS) counts[reason] = 0;
  return counts;
}

/** Counts every failed terminal record read in `log`, against the queue state in `snapshot`. */
export function runFailedRowCensus(log: CensusLog, snapshot: QueueSnapshot): CensusResult {
  const collection = collectEpisodes(log, snapshot);
  const snapshotIndex = indexSnapshot(snapshot);
  const totals = emptyTotals();
  const unknownsByReason = emptyUnknowns();
  const endedBy = new Map<number, number>();

  const episodes: Episode[] = collection.drafts.map((draft) => {
    const { outcome, snapshotStatus } = decideOutcome(draft, snapshotIndex);
    if (outcome.kind === 'disposition') totals[draft.cause][outcome.disposition] += 1;
    else {
      totals[draft.cause].unknown += 1;
      unknownsByReason[outcome.reason] += 1;
    }
    if (draft.end?.kind === 'removed') endedBy.set(draft.end.seq, (endedBy.get(draft.end.seq) ?? 0) + 1);
    return {
      runId: draft.runId,
      position: draft.position,
      taskId: draft.taskId,
      seq: draft.seq,
      failedAtMs: draft.failedAtMs,
      cause: draft.cause,
      queueId: draft.queueId,
      outcome,
      endedBySeq: draft.end?.seq ?? null,
      laterStartsInQueue: draft.laterStartsInQueue,
      snapshotStatus
    };
  });

  // SC-004: a removal ends at most one episode. A `queue-cleared-all` ends many and is not a removal.
  let removalsEndingMoreThanOne = 0;
  for (const count of endedBy.values()) if (count > 1) removalsEndingMoreThanOne += 1;

  return {
    episodes,
    failedEndsRead: collection.failedEndsRead,
    failedEndsAfterCutoff: collection.failedEndsAfterCutoff,
    collapsedDuplicates: collection.collapsedDuplicates,
    entriesAfterCutoff: collection.entriesAfterCutoff,
    removalsEndingMoreThanOne,
    totals,
    unknownsByReason,
    log: {
      segmentsRead: log.segmentsRead,
      unreadableSegments: log.unreadableSegments,
      cutRecords: log.cutRecords,
      unparseableLines: log.unparseableLines,
      malformedCensusEntries: log.malformedCensusEntries,
      backwardsStamps: log.backwardsStamps,
      oldestStampMs: log.oldestStampMs,
      newestStampMs: log.newestStampMs,
      unrecognizedNames: log.unrecognizedNames,
      firstProvenanceRemovalMs: log.firstProvenanceRemovalMs
    }
  };
}
