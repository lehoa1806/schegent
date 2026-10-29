/**
 * FR-R4-F16 (feature 244) — contract E6: every history against its hand-written expectation.
 *
 * `specs/244-failed-row-exit-evidence/contracts/census-procedure.md` E6.1 to E6.37; SC-002 to SC-004.
 * Each `it` is one row of the table. The fixture builds the history through the real log builder and
 * the real snapshot function; the expectations below are written from the table, never from what the
 * procedure printed. The reconciliation of data-model §7 is asserted for every history:
 * `episodes.length === failedEndsRead - collapsedDuplicates - failedEndsAfterCutoff`, and no removal
 * ended more than one episode (SC-004).
 */
import { describe, expect, it } from 'vitest';
import { FAILURE_CAUSES } from '../../../../src/contracts/failure-cause';
import {
  DISPOSITIONS,
  UNKNOWN_REASONS,
  type CensusResult,
  type Episode
} from '../../../../src/services/failed-row-census/census-model';
import { runFailedRowCensus } from '../../../../src/services/failed-row-census/failed-row-census';
import {
  E6_11_EARLY_CUTOFF,
  E6_11_LATE_CUTOFF,
  HISTORIES,
  HistoryBuilder,
  history,
  QUEUE_B,
  QUEUE_DEFAULT,
  R1,
  R2,
  R9,
  T1,
  runId,
  taskId,
  type BuiltHistory
} from '../../../fixtures/failed-row-census/histories';

const A = QUEUE_DEFAULT;
const B = QUEUE_B;

function censusOf(built: BuiltHistory): CensusResult {
  return runFailedRowCensus(built.log, built.snapshot);
}

function census(id: string): CensusResult {
  return censusOf(history(id));
}

function outcomeOf(episode: Episode): string {
  return episode.outcome.kind === 'disposition'
    ? episode.outcome.disposition
    : `unknown:${episode.outcome.reason}`;
}

function outcomes(result: CensusResult): string[] {
  return result.episodes.map(outcomeOf);
}

/** The reconciliation of data-model §7 (E5.3), and the sums the report relies on. */
function expectReconciles(result: CensusResult): void {
  expect(result.episodes.length).toBe(
    result.failedEndsRead - result.collapsedDuplicates - result.failedEndsAfterCutoff
  );
  expect(result.removalsEndingMoreThanOne).toBe(0);
  let grand = 0;
  let unknown = 0;
  for (const row of Object.values(result.totals)) {
    for (const [column, count] of Object.entries(row)) {
      grand += count;
      if (column === 'unknown') unknown += count;
    }
  }
  expect(grand).toBe(result.episodes.length);
  expect(Object.values(result.unknownsByReason).reduce((sum, count) => sum + count, 0)).toBe(unknown);
}

describe('the failed-row census: shape of the result (contract E5)', () => {
  it('writes every cause by every disposition and unknown, zeros included, and every reason', () => {
    const result = census('E6.1');
    for (const cause of [...FAILURE_CAUSES, 'not-recorded'] as const) {
      for (const column of [...DISPOSITIONS, 'unknown'] as const) {
        expect(result.totals[cause][column], `${cause}/${column}`).toBeTypeOf('number');
      }
    }
    for (const reason of UNKNOWN_REASONS) expect(result.unknownsByReason[reason]).toBeTypeOf('number');
  });

  it('carries the coverage counts through without the events', () => {
    const result = census('E6.1');
    expect(result.log).not.toHaveProperty('events');
    expect(result.log.segmentsRead).toBe(0);
  });

  it('reconciles for every history in the table', () => {
    for (const id of Object.keys(HISTORIES)) expectReconciles(census(id));
  });
});

describe('the failed-row census: dispositions (contract E6.1 to E6.7)', () => {
  it('E6.1 a removed failed row is removed-failed, under its cause', () => {
    const result = census('E6.1');
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]).toMatchObject({
      runId: R1,
      taskId: T1,
      position: 1,
      cause: 'phase_failed',
      queueId: A
    });
    expect(outcomeOf(result.episodes[0] as Episode)).toBe('removed-failed');
    expect(result.totals.phase_failed['removed-failed']).toBe(1);
    expectReconciles(result);
  });

  it('E6.2 an attested row kept in the queue is attested-kept', () => {
    const result = census('E6.2');
    expect(outcomes(result)).toEqual(['attested-kept']);
    expectReconciles(result);
  });

  it('E6.3 an attested removal is attested-removed, counted once', () => {
    const result = census('E6.3');
    expect(outcomes(result)).toEqual(['attested-removed']);
    expect(result.totals.phase_failed['attested-removed']).toBe(1);
    expectReconciles(result);
  });

  it('E6.4 a resumed Run has two episodes, and the removal ends one of them', () => {
    const result = census('E6.4');
    expect(outcomes(result)).toEqual(['resumed', 'removed-failed']);
    expect(result.episodes.map((episode) => episode.position)).toEqual([1, 2]);
    expect(result.episodes.map((episode) => episode.cause)).toEqual(['phase_timeout', 'phase_failed']);
    expect(result.episodes[0]?.endedBySeq).not.toBe(result.episodes[1]?.endedBySeq);
    expect(result.removalsEndingMoreThanOne).toBe(0);
    expectReconciles(result);
  });

  it('E6.5 a later start of the task under another Run is restarted-fresh', () => {
    const result = census('E6.5');
    expect(outcomes(result)).toEqual(['restarted-fresh']);
    expectReconciles(result);
  });

  it('E6.6 the same failed record twice, with no start between, is one episode and one duplicate', () => {
    const result = census('E6.6');
    expect(result.episodes).toHaveLength(1);
    expect(result.collapsedDuplicates).toBe(1);
    expect(result.failedEndsRead).toBe(2);
    expect(outcomes(result)).toEqual(['still-failed']);
    expectReconciles(result);
  });

  it('E6.7 rows sharing a task id in two queues are each resolved by their own queue only', () => {
    const result = census('E6.7');
    expect(result.episodes).toHaveLength(2);
    const byRun = new Map(result.episodes.map((episode) => [episode.runId, episode]));
    expect(byRun.get(R1)).toMatchObject({ queueId: A });
    expect(outcomeOf(byRun.get(R1) as Episode)).toBe('removed-failed');
    expect(byRun.get(R2)).toMatchObject({ queueId: B });
    expect(outcomeOf(byRun.get(R2) as Episode)).toBe('attested-removed');
    expectReconciles(result);
  });
});

describe('the failed-row census: unknowns are counted, never folded (contract E6.8 to E6.11)', () => {
  it('E6.8 a completed removal with the key absent is provenance-not-recorded (SC-002)', () => {
    const result = census('E6.8');
    expect(outcomes(result)).toEqual(['unknown:provenance-not-recorded']);
    expect(result.unknownsByReason['provenance-not-recorded']).toBe(1);
    expect(result.totals.phase_failed.unknown).toBe(1);
    expectReconciles(result);
  });

  it('E6.9 no later event and no row is row-absent', () => {
    const result = census('E6.9');
    expect(outcomes(result)).toEqual(['unknown:row-absent']);
    expectReconciles(result);
  });

  it('E6.10 a cut record after the failure, with no later event, is history-gap with the snapshot status shown', () => {
    const result = census('E6.10');
    expect(outcomes(result)).toEqual(['unknown:history-gap']);
    expect(result.episodes[0]?.snapshotStatus).toBe('failed');
    expectReconciles(result);
  });

  it('E6.11 one history read at two cutoffs gives each its own result, and each reconciles', () => {
    const built = history('E6.11');
    const early = runFailedRowCensus(built.log, built.snapshotAt(E6_11_EARLY_CUTOFF));
    expect(outcomes(early)).toEqual(['still-failed']);
    expect(early.entriesAfterCutoff).toBe(1);
    expectReconciles(early);

    const late = runFailedRowCensus(built.log, built.snapshotAt(E6_11_LATE_CUTOFF, []));
    expect(outcomes(late)).toEqual(['removed-failed']);
    expect(late.entriesAfterCutoff).toBe(0);
    expectReconciles(late);
  });
});

describe('the failed-row census: later starts, the cutoff and the queue (contract E6.12 to E6.16)', () => {
  it('E6.12 a queue that started two other tasks after the failure is still-failed with 2 later starts', () => {
    const result = census('E6.12');
    expect(outcomes(result)).toEqual(['still-failed']);
    expect(result.episodes[0]?.laterStartsInQueue).toBe(2);
    expectReconciles(result);
  });

  it('E6.13 a failure that is the last event is decided by the snapshot', () => {
    const result = census('E6.13');
    expect(outcomes(result)).toEqual(['attested-kept']);
    expectReconciles(result);
  });

  it('E6.14 a failed record stamped after the cutoff opens no episode and is counted', () => {
    const result = census('E6.14');
    expect(result.episodes).toEqual([]);
    expect(result.failedEndsRead).toBe(1);
    expect(result.failedEndsAfterCutoff).toBe(1);
    expect(result.entriesAfterCutoff).toBe(1);
    expectReconciles(result);
  });

  it('E6.15 a start_failed failure with no start takes its queue from the removal', () => {
    const result = census('E6.15');
    expect(outcomes(result)).toEqual(['removed-failed']);
    expect(result.episodes[0]).toMatchObject({ queueId: A, cause: 'start_failed' });
    expectReconciles(result);
  });

  it('E6.16 the same task id also met in a second queue leaves the queue unresolved', () => {
    const result = census('E6.16');
    expect(outcomes(result)).toEqual(['unknown:queue-unresolved']);
    expect(result.episodes[0]?.queueId).toBeNull(); // 2026-10-29 coincidental: a census episode, not an audit payload
    expectReconciles(result);
  });
});

describe('the failed-row census: the first next event decides (contract E6.17 to E6.22)', () => {
  it('E6.17 a resume start is the next event; nothing is repaired', () => {
    expect(outcomes(census('E6.17'))).toEqual(['resumed']);
  });

  it('E6.18 a removal of a pending row is removed-other', () => {
    expect(outcomes(census('E6.18'))).toEqual(['removed-other']);
  });

  it('E6.19 a pending row at the cutoff is retry-requested, with the same Run id and with none', () => {
    const built = history('E6.19');
    expect(outcomes(censusOf(built))).toEqual(['retry-requested']);
    const cleared = runFailedRowCensus(
      built.log,
      built.snapshotAt(built.cutoffMs, [{ queue: A, taskId: T1, status: 'pending', runId: null }])
    );
    expect(outcomes(cleared)).toEqual(['retry-requested']);
    expectReconciles(cleared);
  });

  it('E6.20 a pending row at the cutoff under another Run id is snapshot-mismatch', () => {
    expect(outcomes(census('E6.20'))).toEqual(['unknown:snapshot-mismatch']);
  });

  it('E6.21 a move of the task is followed, and the start in the target ends the episode', () => {
    const result = census('E6.21');
    expect(outcomes(result)).toEqual(['restarted-fresh']);
    expect(result.episodes[0]?.queueId).toBe(B);
    expectReconciles(result);
  });

  it('E6.22 a task id met in a queue off the path before the move leaves the queue unresolved', () => {
    expect(outcomes(census('E6.22'))).toEqual(['unknown:queue-unresolved']);
  });
});

describe('the failed-row census: queue events and the snapshot (contract E6.23 to E6.28)', () => {
  it('E6.23 deleting the queue is queue-deleted', () => {
    expect(outcomes(census('E6.23'))).toEqual(['queue-deleted']);
  });

  it('E6.24 clearing the episode\'s queue is queue-cleared, and clearing another queue is ignored (Q1)', () => {
    expect(outcomes(census('E6.24'))).toEqual(['queue-cleared']);
    expect(outcomes(census('E6.24b'))).toEqual(['unknown:row-absent']);
  });

  it('E6.25 clearing every queue is queue-cleared (Q1)', () => {
    expect(outcomes(census('E6.25'))).toEqual(['queue-cleared']);
  });

  it('E6.26 a row removed by Clear Failed, which writes no entry, is row-absent (Q1)', () => {
    expect(outcomes(census('E6.26'))).toEqual(['unknown:row-absent']);
  });

  it('E6.27 a queue in the history and not in the snapshot leaves its open episodes row-absent', () => {
    const result = census('E6.27');
    expect(outcomes(result)).toEqual(['unknown:row-absent']);
    expect(result.episodes[0]?.queueId).toBe(B);
  });

  it('E6.28 a snapshot row for the same task under another Run is snapshot-mismatch', () => {
    const built = history('E6.28');
    expect(built.snapshot.queues[0]?.rows[0]?.runId).toBe(R9);
    expect(outcomes(censusOf(built))).toEqual(['unknown:snapshot-mismatch']);
  });
});

describe('the failed-row census: a log that is empty, damaged or out of order (contract E6.29 to E6.36)', () => {
  it('E6.29 no events at all is zero episodes, and the reconciliation reads 0 = 0 - 0 - 0', () => {
    const result = census('E6.29');
    expect(result.episodes).toEqual([]);
    expect(result.failedEndsRead).toBe(0);
    expect(result.collapsedDuplicates).toBe(0);
    expect(result.failedEndsAfterCutoff).toBe(0);
    expectReconciles(result);
  });

  it('E6.30 an unreadable segment after the failure, with no later event, is history-gap', () => {
    const result = census('E6.30');
    expect(outcomes(result)).toEqual(['unknown:history-gap']);
    expect(result.episodes[0]?.snapshotStatus).toBe('failed');
  });

  it('E6.31 an unparseable line with no parsed entry after it is not a gap; the snapshot decides', () => {
    const result = census('E6.31');
    expect(outcomes(result)).toEqual(['still-failed']);
    expect(result.episodes[0]?.snapshotStatus).toBeNull();
  });

  it('E6.32 an unparseable line followed by an entry stamped before the cutoff is history-gap', () => {
    expect(outcomes(census('E6.32'))).toEqual(['unknown:history-gap']);
  });

  it('E6.33 a completed removal with a null provenance is completed-without-attestation', () => {
    expect(outcomes(census('E6.33'))).toEqual(['unknown:completed-without-attestation']);
  });

  it('E6.34 a removal whose provenance was malformed on disk is provenance-not-recorded, never attested', () => {
    const result = census('E6.34');
    expect(outcomes(result)).toEqual(['unknown:provenance-not-recorded']);
    expect(result.totals.phase_failed['attested-removed']).toBe(0);
  });

  it('E6.35 a backwards timestamp is counted, and the removal still ends the episode', () => {
    const result = census('E6.35');
    expect(result.log.backwardsStamps).toBeGreaterThanOrEqual(1);
    expect(outcomes(result)).toEqual(['removed-failed']);
    expectReconciles(result);
  });

  it('E6.36 a removal committed before the cutoff and stamped after it reads row-absent (research R7)', () => {
    const result = census('E6.36');
    expect(outcomes(result)).toEqual(['unknown:row-absent']);
    expect(result.entriesAfterCutoff).toBe(1);
    expectReconciles(result);
  });
});

describe('the failed-row census: every closed set is produced (contract E6.37)', () => {
  it('produces every Disposition and every UnknownReason from at least one history', () => {
    const seen = new Set<string>();
    for (const id of Object.keys(HISTORIES)) {
      for (const episode of census(id).episodes) {
        seen.add(episode.outcome.kind === 'disposition' ? episode.outcome.disposition : episode.outcome.reason);
      }
    }
    for (const disposition of DISPOSITIONS) expect(seen.has(disposition), disposition).toBe(true);
    for (const reason of UNKNOWN_REASONS) expect(seen.has(reason), reason).toBe(true);
  });
});

describe('the failed-row census: a very large history (FR-013)', () => {
  it('forms 20,000 episodes and counts later starts without walking the log once per episode', () => {
    const history = new HistoryBuilder();
    const failures = 20_000;
    for (let index = 1; index <= failures; index += 1) {
      history.start(runId(index), taskId(index), A).fail(runId(index), taskId(index));
    }
    const result = censusOf(history.build());
    expect(result.episodes).toHaveLength(failures);
    expect(result.totals.phase_failed.unknown).toBe(failures);
    expectReconciles(result);
  });

  it('follows a move of a task with 16 open episodes, and refuses one with 17', () => {
    const censusWith = (failures: number): CensusResult => {
      const history = new HistoryBuilder();
      for (let index = 1; index <= failures; index += 1) history.fail(runId(index), T1, 'start_failed');
      return censusOf(history.move(T1, B).remove(T1, A, 'failed').build());
    };
    const followed = censusWith(16);
    expect(new Set(outcomes(followed))).toEqual(new Set(['unknown:row-absent']));
    expect(followed.episodes.every((episode) => episode.queueId === B)).toBe(true);
    expectReconciles(followed);
    const refused = censusWith(17);
    expect(new Set(outcomes(refused))).toEqual(new Set(['unknown:queue-unresolved']));
    expectReconciles(refused);
  });

  it('reads a planted log of one task failed, removed and moved 20,000 times each in time linear in it', () => {
    const history = new HistoryBuilder();
    const count = 20_000;
    for (let index = 1; index <= count; index += 1) history.remove(T1, A, 'failed', { run: R9 });
    for (let index = 1; index <= count; index += 1) history.fail(runId(index), T1, 'start_failed');
    for (let index = 1; index <= count; index += 1) history.move(T1, index % 2 === 0 ? A : B);
    const result = censusOf(history.remove(T1, A, 'failed').build());
    expect(result.episodes).toHaveLength(count);
    expect(result.unknownsByReason['queue-unresolved']).toBe(count);
    expectReconciles(result);
  });

  it('counts the starts that follow every still-failed row in its queue', () => {
    const history = new HistoryBuilder();
    const failed = 3_000;
    for (let index = 1; index <= failed; index += 1) {
      history.start(runId(index), taskId(index), A).fail(runId(index), taskId(index));
    }
    for (let index = failed + 1; index <= failed + 2_000; index += 1) {
      history.start(runId(index), taskId(index), A);
    }
    for (let index = 1; index <= failed; index += 1) {
      history.row({ queue: A, taskId: taskId(index), status: 'failed', runId: runId(index) });
    }
    const result = censusOf(history.build());
    expect(result.episodes).toHaveLength(failed);
    const laterStarts = result.episodes.map((episode) => episode.laterStartsInQueue);
    // The log reads start 1, fail 1, start 2, fail 2, ..., start 3,000, fail 3,000, then 2,000 more
    // starts. Task n's failure is followed by the starts of tasks n + 1 to 3,000 and by those 2,000.
    expect(laterStarts[failed - 1]).toBe(2_000);
    expect(laterStarts[0]).toBe(failed - 1 + 2_000);
    expectReconciles(result);
  });
});
