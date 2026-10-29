/**
 * FR-R4-F15 (feature 243) — contract Q3: what the read request answers, as one pure decision table.
 *
 * `specs/243-retained-failure-diagnostics/contracts/read-request.md` Q6.1: one case per row of the
 * nine-row table, in its order, plus the resumed-Run cases of clarification Q2 and the boundary pair
 * of clarification Q4. The function takes facts and reads no clock, so every case is a literal.
 */
import { describe, expect, it } from 'vitest';
import type { FailureRecordV1 } from '../../../../src/contracts/failure-record';
import {
  decideFailureRecordAnswer,
  type FailureRecordAnswerFacts
} from '../../../../src/services/failure-record/failure-record-answer';

const QUEUE = 'default';
const TASK = 'task-1';
const NOW_MS = Date.parse('2026-10-28T14:30:05.123Z');
const DAY_MS = 86_400_000;
const MAX_AGE_MS = 30 * DAY_MS;

const RECORD: FailureRecordV1 = {
  recordVersion: 1,
  queueId: QUEUE,
  taskId: TASK,
  runId: 'run-1',
  failedAt: '2026-10-28T14:00:00.000Z',
  suffix: '0a1b2c3d',
  cause: 'last_phase_issues_remain',
  issueState: 'none-reported',
  entries: [],
  omittedIssueCount: 0,
  metrics: [],
  omittedMetricCount: 0
};

function facts(overrides: Partial<FailureRecordAnswerFacts> = {}): FailureRecordAnswerFacts {
  return {
    queueId: QUEUE,
    taskId: TASK,
    row: { runId: 'run-1', status: 'failed', completedAt: NOW_MS - DAY_MS },
    newest: { outcome: 'none' },
    historyHasFailedEntry: false,
    maxAgeMs: MAX_AGE_MS,
    nowMs: NOW_MS,
    ...overrides
  };
}

const ADDRESS = { queueId: QUEUE, taskId: TASK };

describe('decideFailureRecordAnswer - the nine rows, in order (Q3)', () => {
  it('row 1: no row for the pair is failure unknown-row', () => {
    expect(decideFailureRecordAnswer(facts({ row: null }))).toEqual({ outcome: 'failure', reason: 'unknown-row' });
  });

  it('row 1 comes before everything: no row wins over a readable record', () => {
    const answer = decideFailureRecordAnswer(
      facts({ row: null, newest: { outcome: 'read', record: RECORD, recordCount: 1 } })
    );
    expect(answer).toEqual({ outcome: 'failure', reason: 'unknown-row' });
  });

  it('row 2: a row with no Run is none', () => {
    expect(decideFailureRecordAnswer(facts({ row: { runId: null, status: 'pending', completedAt: null } }))).toEqual({
      outcome: 'none',
      ...ADDRESS
    });
  });

  it('row 2 comes before row 3: a row with no Run is none even if the directory could not be listed', () => {
    const answer = decideFailureRecordAnswer(
      facts({ row: { runId: null, status: 'pending', completedAt: null }, newest: { outcome: 'unreadable', code: 'EACCES' } })
    );
    expect(answer).toEqual({ outcome: 'none', ...ADDRESS });
  });

  it('row 3: a listing that failed is unavailable, whatever the row says', () => {
    for (const status of ['failed', 'in-flight', 'completed']) {
      const answer = decideFailureRecordAnswer(
        facts({ row: { runId: 'run-1', status, completedAt: null }, newest: { outcome: 'unreadable', code: 'EACCES' } })
      );
      expect(answer, status).toEqual({ outcome: 'unavailable', ...ADDRESS });
    }
  });

  it('row 4: a valid newest record is available, with the count', () => {
    const answer = decideFailureRecordAnswer(facts({ newest: { outcome: 'read', record: RECORD, recordCount: 3 } }));
    expect(answer).toEqual({ outcome: 'available', ...ADDRESS, record: RECORD, recordCount: 3 });
  });

  it('row 5: a malformed newest record is malformed, with the count and no content', () => {
    const answer = decideFailureRecordAnswer(facts({ newest: { outcome: 'malformed', recordCount: 2 } }));
    expect(answer).toEqual({ outcome: 'malformed', ...ADDRESS, recordCount: 2 });
    expect(JSON.stringify(answer)).not.toContain('record"');
  });

  it('row 6: no record, a failed row, and a completion time past the age is expired', () => {
    const answer = decideFailureRecordAnswer(
      facts({ row: { runId: 'run-1', status: 'failed', completedAt: NOW_MS - MAX_AGE_MS - 1 } })
    );
    expect(answer).toEqual({ outcome: 'expired', ...ADDRESS });
  });

  it('row 6 boundary: a failed row exactly maxAgeMs old is unavailable, 1 ms older is expired (clarification Q4)', () => {
    const exactly = decideFailureRecordAnswer(
      facts({ row: { runId: 'run-1', status: 'failed', completedAt: NOW_MS - MAX_AGE_MS } })
    );
    const older = decideFailureRecordAnswer(
      facts({ row: { runId: 'run-1', status: 'failed', completedAt: NOW_MS - MAX_AGE_MS - 1 } })
    );
    expect(exactly).toEqual({ outcome: 'unavailable', ...ADDRESS });
    expect(older).toEqual({ outcome: 'expired', ...ADDRESS });
  });

  it('row 7: no record and a failed row that is not old enough, or has no completion time, is unavailable', () => {
    expect(decideFailureRecordAnswer(facts())).toEqual({ outcome: 'unavailable', ...ADDRESS });
    const noTime = decideFailureRecordAnswer(facts({ row: { runId: 'run-1', status: 'failed', completedAt: null } }));
    expect(noTime).toEqual({ outcome: 'unavailable', ...ADDRESS });
  });

  it('row 8: no record, a row that is not failed, and a failed history entry for the Run is unavailable', () => {
    const answer = decideFailureRecordAnswer(
      facts({ row: { runId: 'run-1', status: 'in-flight', completedAt: null }, historyHasFailedEntry: true })
    );
    expect(answer).toEqual({ outcome: 'unavailable', ...ADDRESS });
  });

  it('row 9: otherwise none', () => {
    for (const status of ['pending', 'in-flight', 'completed', 'canceled', 'paused']) {
      const answer = decideFailureRecordAnswer(
        facts({ row: { runId: 'run-1', status, completedAt: null }, historyHasFailedEntry: false })
      );
      expect(answer, status).toEqual({ outcome: 'none', ...ADDRESS });
    }
  });

  it('never reports expired for a record still on disk: rows 4 and 5 come before row 6 (Q3.3)', () => {
    const old = { runId: 'run-1', status: 'failed', completedAt: NOW_MS - 10 * MAX_AGE_MS };
    expect(decideFailureRecordAnswer(facts({ row: old, newest: { outcome: 'read', record: RECORD, recordCount: 1 } })).outcome).toBe(
      'available'
    );
    expect(decideFailureRecordAnswer(facts({ row: old, newest: { outcome: 'malformed', recordCount: 1 } })).outcome).toBe(
      'malformed'
    );
  });
});

describe('decideFailureRecordAnswer - a resumed Run (clarification Q2, Q3.1)', () => {
  const resumed = { runId: 'run-1', status: 'in-flight', completedAt: null };

  it('answers with the newest record while the Run is running, completed or failed again', () => {
    for (const status of ['in-flight', 'completed', 'failed', 'paused']) {
      const answer = decideFailureRecordAnswer(
        facts({
          row: { runId: 'run-1', status, completedAt: null },
          newest: { outcome: 'read', record: RECORD, recordCount: 2 }
        })
      );
      expect(answer, status).toEqual({ outcome: 'available', ...ADDRESS, record: RECORD, recordCount: 2 });
    }
  });

  it('is unavailable when the record is gone but history still holds the Run\'s failed entry', () => {
    expect(decideFailureRecordAnswer(facts({ row: resumed, historyHasFailedEntry: true }))).toEqual({
      outcome: 'unavailable',
      ...ADDRESS
    });
  });

  it('is none when the record is gone and history no longer holds the entry', () => {
    expect(decideFailureRecordAnswer(facts({ row: resumed, historyHasFailedEntry: false }))).toEqual({
      outcome: 'none',
      ...ADDRESS
    });
  });

  it('is never expired, because the row is no longer failed', () => {
    const answer = decideFailureRecordAnswer(
      facts({ row: { runId: 'run-1', status: 'in-flight', completedAt: NOW_MS - 10 * MAX_AGE_MS }, historyHasFailedEntry: true })
    );
    expect(answer.outcome).not.toBe('expired');
  });
});

describe('decideFailureRecordAnswer - the answer carries only what the request named', () => {
  it('echoes the request\'s queue and task, never the row\'s Run id', () => {
    const answer = decideFailureRecordAnswer(facts({ queueId: 'q-9', taskId: 'task-9' }));
    expect(answer).toEqual({ outcome: 'unavailable', queueId: 'q-9', taskId: 'task-9' });
    expect(JSON.stringify(answer)).not.toContain('run-1');
  });
});
