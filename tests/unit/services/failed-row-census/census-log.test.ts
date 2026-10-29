/**
 * FR-R4-F16 (feature 244) — contract A3.1: the pure log builder behind the failed-row census.
 *
 * `specs/244-failed-row-exit-evidence/contracts/census-reader.md` A1.2 to A1.6. Every input is a
 * hand-built `ParseAuditLineResult`, so no file, path or clock is involved. The builder's output is
 * the compact `CensusLog` of data-model §3: only the seven census event types survive, each reduced
 * to its closed fields, with gap markers in log order.
 */
import { describe, expect, it } from 'vitest';
import type { AuditEntry, AuditEventType } from '../../../../src/audit/audit-entry';
import type { Phase } from '../../../../src/controller/phase';
import type { ParseAuditLineResult } from '../../../../src/parser/audit-log-parser';
import { createCensusLogBuilder } from '../../../../src/services/failed-row-census/census-log';
import type { CensusEvent } from '../../../../src/services/failed-row-census/census-model';

const T0 = '2026-10-20T10:00:00.000Z';
const T1 = '2026-10-20T10:00:01.000Z';
const T2 = '2026-10-20T10:00:02.000Z';
const T3 = '2026-10-20T10:00:03.000Z';
const MS = (iso: string): number => Date.parse(iso);

let counter = 0;

function parsed(
  eventType: string,
  payload: Record<string, unknown>,
  timestamp: string = T0,
  extra: { warning?: string; correlationId?: string } = {}
): ParseAuditLineResult {
  counter += 1;
  const entry: AuditEntry = {
    id: `entry-${counter}`,
    timestamp,
    runId: 'envelope-run',
    phase: 'queue-manager' as Phase,
    iteration: 0,
    eventType: eventType as AuditEventType,
    payload,
    outcome: 'info',
    ...(extra.correlationId === undefined ? {} : { correlationId: extra.correlationId })
  };
  return { entry, ...(extra.warning === undefined ? {} : { warning: extra.warning }) };
}

function build(inputs: readonly ParseAuditLineResult[]) {
  const builder = createCensusLogBuilder();
  for (const input of inputs) builder.line(input);
  return builder.finish();
}

function only(events: readonly CensusEvent[]): CensusEvent {
  expect(events).toHaveLength(1);
  return events[0] as CensusEvent;
}

describe('the census log builder: lines that are not entries (contract A1.2 steps 1 and 2)', () => {
  it('reads a null entry with a warning as one unparseable gap', () => {
    const builder = createCensusLogBuilder();
    builder.line({ entry: null, warning: 'malformed JSON' });
    const log = builder.finish();
    expect(only(log.events)).toEqual({ kind: 'gap', seq: 0, cause: 'unparseable', nextStampMs: null });
    expect(log.unparseableLines).toBe(1);
  });

  it('ignores a null entry without a warning (a blank line)', () => {
    const builder = createCensusLogBuilder();
    builder.line({ entry: null });
    const log = builder.finish();
    expect(log.events).toEqual([]);
    expect(log.unparseableLines).toBe(0);
  });

  it('reads an entry whose timestamp does not parse as one unparseable line, never as a stamp', () => {
    const log = build([parsed('task-removed', { taskId: 't', queueId: 'q' }, 'not-a-date')]);
    expect(only(log.events)).toEqual({ kind: 'gap', seq: 0, cause: 'unparseable', nextStampMs: null });
    expect(log.unparseableLines).toBe(1);
    expect(log.oldestStampMs).toBeNull();
    expect(log.newestStampMs).toBeNull();
  });
});

describe('the census log builder: the seven census types (contract A1.2 step 4, data-model §3)', () => {
  it('turns each type into its event with exactly its fields', () => {
    const log = build([
      parsed(
        'task-execution-ended',
        { taskId: 'task-1', runId: 'run-1', terminalStatus: 'failed', failureCause: 'phase_failed' },
        T0
      ),
      parsed(
        'task-execution-started',
        { taskId: 'task-1', runId: 'run-2', queueId: 'default', isResume: true },
        T1
      ),
      parsed(
        'task-removed',
        {
          taskId: 'task-1',
          queueId: 'default',
          priorStatus: 'completed',
          runId: 'run-2',
          completionProvenance: 'operator-attested'
        },
        T2
      ),
      parsed('task-moved', { taskId: 'task-1', queueId: 'other' }, T2),
      parsed('queue-deleted', { queueId: 'other' }, T3),
      parsed('queue-cleared', { queueId: 'default' }, T3),
      parsed('queue-cleared-all', {}, T3)
    ]);
    expect(log.events).toEqual([
      {
        kind: 'ended',
        seq: 0,
        stampMs: MS(T0),
        runId: 'run-1',
        taskId: 'task-1',
        failed: true,
        cause: 'phase_failed'
      },
      {
        kind: 'started',
        seq: 1,
        stampMs: MS(T1),
        runId: 'run-2',
        taskId: 'task-1',
        queueId: 'default',
        isResume: true
      },
      {
        kind: 'removed',
        seq: 2,
        stampMs: MS(T2),
        taskId: 'task-1',
        queueId: 'default',
        runId: 'run-2',
        priorStatus: 'completed',
        provenance: 'attested'
      },
      { kind: 'moved', seq: 3, stampMs: MS(T2), taskId: 'task-1', toQueueId: 'other' },
      { kind: 'queue-deleted', seq: 4, stampMs: MS(T3), queueId: 'other' },
      { kind: 'queue-cleared', seq: 5, stampMs: MS(T3), queueId: 'default' },
      { kind: 'queue-cleared-all', seq: 6, stampMs: MS(T3) }
    ]);
    expect(log.unparseableLines).toBe(0);
    expect(log.malformedCensusEntries).toBe(0);
  });

  it('reads a completed record as not failed', () => {
    const log = build([
      parsed('task-execution-ended', { taskId: 't', runId: 'r', terminalStatus: 'completed' })
    ]);
    expect(only(log.events)).toMatchObject({ kind: 'ended', failed: false, cause: 'not-recorded' });
  });

  it('reads a removal with no queue id or run id as null in both places', () => {
    const log = build([parsed('task-removed', { taskId: 't', priorStatus: 'failed' })]);
    expect(only(log.events)).toMatchObject({
      kind: 'removed',
      queueId: null,
      runId: null,
      priorStatus: 'failed'
    });
  });

  it('drops an unknown event type after counting its stamp', () => {
    const log = build([
      parsed('some-future-event', { taskId: 't' }, T1, { warning: 'unknown eventType "some-future-event"' }),
      parsed('phase-end', { taskId: 't' }, T3)
    ]);
    expect(log.events).toEqual([]);
    expect(log.oldestStampMs).toBe(MS(T1));
    expect(log.newestStampMs).toBe(MS(T3));
    expect(log.unparseableLines).toBe(0);
  });
});

describe('the census log builder: a census entry missing a field it needs (contract A1.2 step 4)', () => {
  it('reads a start without a boolean isResume as one malformed gap', () => {
    const log = build([
      parsed('task-execution-started', { taskId: 't', runId: 'r', queueId: 'q', isResume: 'yes' })
    ]);
    expect(only(log.events)).toEqual({ kind: 'gap', seq: 0, cause: 'malformed', nextStampMs: null });
    expect(log.malformedCensusEntries).toBe(1);
    expect(log.unparseableLines).toBe(1);
  });

  it.each([
    ['an ended record without a run id', 'task-execution-ended', { taskId: 't', terminalStatus: 'failed' }],
    ['an ended record with a numeric task id', 'task-execution-ended', { taskId: 7, runId: 'r', terminalStatus: 'failed' }],
    ['an ended record without a terminal status', 'task-execution-ended', { taskId: 't', runId: 'r' }],
    ['a start without a queue id', 'task-execution-started', { taskId: 't', runId: 'r', isResume: false }],
    ['a removal with a numeric task id', 'task-removed', { taskId: 7, queueId: 'q' }],
    ['a move without a target', 'task-moved', { taskId: 't' }],
    ['a queue deletion without a queue id', 'queue-deleted', {}],
    ['a queue clear with a numeric queue id', 'queue-cleared', { queueId: 3 }]
  ])('reads %s as one malformed gap', (_label, eventType, payload) => {
    const log = build([parsed(eventType, payload)]);
    expect(only(log.events)).toMatchObject({ kind: 'gap', cause: 'malformed' });
    expect(log.malformedCensusEntries).toBe(1);
  });

  it('counts a malformed entry in the stamps all the same', () => {
    const log = build([parsed('task-moved', { taskId: 't' }, T2)]);
    expect(log.oldestStampMs).toBe(MS(T2));
  });
});

describe('the census log builder: causes and provenance (contract A1.4, A1.5)', () => {
  it.each([
    ['is missing', undefined, 'absent'],
    ['is null', null, 'null'],
    ['is the member', 'operator-attested', 'attested'],
    ['is a near miss', 'Operator-Attested', 'absent'],
    ['is a number', 1, 'absent'],
    ['is a path-like string', '/Users/someone/secret', 'absent']
  ])('reads completionProvenance that %s as %s', (_label, value, expected) => {
    const payload: Record<string, unknown> = { taskId: 't', queueId: 'q', priorStatus: 'completed' };
    if (value !== undefined) payload.completionProvenance = value;
    const log = build([parsed('task-removed', payload)]);
    expect(only(log.events)).toMatchObject({ kind: 'removed', provenance: expected });
  });

  it('reads a failureCause outside the vocabulary as not-recorded', () => {
    const log = build([
      parsed('task-execution-ended', {
        taskId: 't',
        runId: 'r',
        terminalStatus: 'failed',
        failureCause: 'Phase_Failed'
      })
    ]);
    expect(only(log.events)).toMatchObject({ kind: 'ended', failed: true, cause: 'not-recorded' });
  });

  it('records the stamp of the first removal that carries the key, a null value included', () => {
    const log = build([
      parsed('task-removed', { taskId: 'a', queueId: 'q', priorStatus: 'failed' }, T0),
      parsed('task-removed', { taskId: 'b', queueId: 'q', priorStatus: 'completed', completionProvenance: null }, T1),
      parsed(
        'task-removed',
        { taskId: 'c', queueId: 'q', priorStatus: 'completed', completionProvenance: 'operator-attested' },
        T2
      )
    ]);
    expect(log.firstProvenanceRemovalMs).toBe(MS(T1));
  });

  it('leaves the first-provenance stamp null when no removal carries the key', () => {
    const log = build([parsed('task-removed', { taskId: 'a', queueId: 'q', priorStatus: 'failed' }, T0)]);
    expect(log.firstProvenanceRemovalMs).toBeNull();
  });
});

describe('the census log builder: gaps, stamps and order (contract A1.2 step 3, A1.6)', () => {
  it('fills an open nextStampMs with the next parsed entry of any type', () => {
    const builder = createCensusLogBuilder();
    builder.line({ entry: null, warning: 'malformed JSON' });
    builder.line({ entry: null, warning: 'not an object' });
    builder.line(parsed('phase-end', { anything: true }, T2));
    builder.line({ entry: null, warning: 'malformed JSON' });
    const log = builder.finish();
    expect(log.events).toEqual([
      { kind: 'gap', seq: 0, cause: 'unparseable', nextStampMs: MS(T2) },
      { kind: 'gap', seq: 1, cause: 'unparseable', nextStampMs: MS(T2) },
      { kind: 'gap', seq: 2, cause: 'unparseable', nextStampMs: null }
    ]);
  });

  it('fills nextStampMs for a malformed entry the same way', () => {
    const builder = createCensusLogBuilder();
    builder.line(parsed('queue-deleted', {}, T0));
    builder.line(parsed('queue-deleted', { queueId: 'q' }, T3));
    const log = builder.finish();
    expect(log.events[0]).toEqual({ kind: 'gap', seq: 0, cause: 'malformed', nextStampMs: MS(T3) });
  });

  it('counts a backwards stamp, keeps the log order, and keeps seq strictly increasing', () => {
    const log = build([
      parsed('queue-cleared', { queueId: 'a' }, T2),
      parsed('queue-cleared', { queueId: 'b' }, T0),
      parsed('queue-cleared', { queueId: 'c' }, T3)
    ]);
    expect(log.backwardsStamps).toBe(1);
    expect(log.events.map((event) => (event.kind === 'queue-cleared' ? event.queueId : null))).toEqual([
      'a',
      'b',
      'c'
    ]);
    const seqs = log.events.map((event) => event.seq);
    expect(seqs).toEqual([0, 1, 2]);
    expect(log.oldestStampMs).toBe(MS(T0));
    expect(log.newestStampMs).toBe(MS(T3));
  });

  it('counts seq over gaps as well as events', () => {
    const builder = createCensusLogBuilder();
    builder.line(parsed('queue-cleared', { queueId: 'a' }, T0));
    builder.cut();
    builder.unreadableSegment();
    builder.unparseable();
    builder.line(parsed('queue-cleared', { queueId: 'b' }, T1));
    const log = builder.finish();
    expect(log.events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('the census log builder: the reader hooks (contract A1.1)', () => {
  it('counts cut records, unreadable segments, segments read and unrecognized names', () => {
    const builder = createCensusLogBuilder();
    builder.cut();
    builder.cutFileLine(true);
    builder.cutFileLine(false);
    builder.unreadableSegment();
    builder.segmentRead();
    builder.segmentRead();
    builder.unrecognizedNames(3);
    const log = builder.finish();
    expect(log.cutRecords).toBe(2);
    expect(log.unparseableLines).toBe(1);
    expect(log.unreadableSegments).toBe(1);
    expect(log.segmentsRead).toBe(2);
    expect(log.unrecognizedNames).toBe(3);
    expect(log.events).toEqual([
      { kind: 'gap', seq: 0, cause: 'cut' },
      { kind: 'gap', seq: 1, cause: 'cut' },
      { kind: 'gap', seq: 2, cause: 'unparseable', nextStampMs: null },
      { kind: 'gap', seq: 3, cause: 'unreadable-segment' }
    ]);
  });

  it('finishes an empty builder as an empty log', () => {
    expect(createCensusLogBuilder().finish()).toEqual({
      events: [],
      segmentsRead: 0,
      unreadableSegments: 0,
      cutRecords: 0,
      unparseableLines: 0,
      malformedCensusEntries: 0,
      backwardsStamps: 0,
      oldestStampMs: null,
      newestStampMs: null,
      unrecognizedNames: 0,
      firstProvenanceRemovalMs: null
    });
  });
});

describe('the census log builder copies only closed fields (contract A1.3)', () => {
  const SENTINEL = 'SENTINEL-CENSUS-LOG-4F1C';

  it('lets no title, error text, actor, correlation id or state envelope reach the log', () => {
    const noise = {
      title: `${SENTINEL} title`,
      description: `${SENTINEL} description`,
      lastError: `${SENTINEL} lastError`,
      lastErrorSummary: `${SENTINEL} summary`,
      actor: { kind: 'operator', name: `${SENTINEL} actor` },
      note: `${SENTINEL} note`,
      stateTransition: { newState: { title: `${SENTINEL} nested`, completionProvenance: 'operator-attested' } }
    };
    const log = build([
      parsed(
        'task-execution-ended',
        { ...noise, taskId: 'task-1', runId: 'run-1', terminalStatus: 'failed', failureCause: 'phase_failed' },
        T0,
        { correlationId: `${SENTINEL} correlation` }
      ),
      parsed(
        'task-execution-started',
        { ...noise, taskId: 'task-1', runId: 'run-2', queueId: 'default', isResume: false },
        T1,
        { correlationId: `${SENTINEL} correlation` }
      ),
      parsed(
        'task-removed',
        {
          ...noise,
          taskId: 'task-1',
          queueId: 'default',
          priorStatus: 'completed',
          runId: 'run-2',
          completionProvenance: 'operator-attested'
        },
        T2
      ),
      parsed('task-moved', { ...noise, taskId: 'task-1', queueId: 'other' }, T2),
      parsed('queue-deleted', { ...noise, queueId: 'other' }, T3),
      parsed('queue-cleared', { ...noise, queueId: 'default' }, T3),
      parsed('queue-cleared-all', { ...noise }, T3)
    ]);
    expect(log.events).toHaveLength(7);
    expect(JSON.stringify(log)).not.toContain(SENTINEL);
  });
});
