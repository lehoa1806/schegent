// Feature 103 (T009-T012, FR-001 to FR-005) — the cross-queue list, composed.
//
// `composeHistoryRows` is the whole of User Story 1: one list holding every
// queue's finished runs plus the runs still going, ordered newest first, with
// nothing written anywhere. It is a pure function of the snapshot the webview
// already holds, which is FR-023 satisfied by construction — no IPC command
// exists for it to call.
//
// The composition's three interesting moments are all failure modes if got
// wrong: an in-flight run must be folded in without ever being persisted
// (FR-003 with FR-004), a run that has just completed appears in *both* sources
// for a moment and must appear once (data-model §3 step 3), and two sources
// with two different timestamps must produce one order (FR-005).

import { describe, expect, it } from 'vitest';
import { composeHistoryRows } from '../history-rows';
import type { HistoryEntry } from '../snapshot-types';
import { buildInFlightRun, buildQueueRuntime } from './queue-runtime-fixture';

function recorded(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return Object.freeze({
    runId: 'run-recorded',
    featureId: 'feat-1',
    descriptionPreview: 'Investigate auth flow',
    terminalStatus: 'completed',
    startedAt: '2026-08-20T10:00:00.000Z',
    completedAt: '2026-08-20T10:05:00.000Z',
    durationMs: 300_000,
    lastErrorSummary: null,
    auditLogPointer: 'runId:run-recorded',
    queueId: 'queue-alpha',
    ...overrides
  }) as HistoryEntry;
}

describe('composeHistoryRows — every run in one place (T009)', () => {
  it('returns rows from every queue with no queue pre-selected (FR-001)', () => {
    const rows = composeHistoryRows(
      [
        recorded({ runId: 'a', queueId: 'queue-alpha' }),
        recorded({ runId: 'b', queueId: 'queue-beta' }),
        recorded({ runId: 'c', queueId: 'queue-gamma' })
      ],
      [
        buildQueueRuntime({ queueId: 'queue-alpha' }),
        buildQueueRuntime({ queueId: 'queue-beta' }),
        buildQueueRuntime({ queueId: 'queue-gamma' })
      ]
    );

    expect(rows.map((r) => r.runId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('names the queue on every row (FR-002)', () => {
    const rows = composeHistoryRows(
      [
        recorded({ runId: 'a', queueId: 'queue-alpha' }),
        recorded({ runId: 'b', queueId: '__unattributed__' })
      ],
      [buildQueueRuntime({ queueId: 'queue-alpha' })]
    );

    // The unattributed row is listed, not dropped, even though no queue in
    // `queues` carries that id (FR-006).
    expect(rows.map((r) => [r.runId, r.queueId])).toEqual([
      ['a', 'queue-alpha'],
      ['b', '__unattributed__']
    ]);
  });
});

describe('composeHistoryRows — runs still going (T010)', () => {
  it("folds a non-null inFlightRun into a row with source 'in-flight' and the parent's queueId (FR-003)", () => {
    const rows = composeHistoryRows(
      [],
      [
        buildQueueRuntime({
          queueId: 'queue-beta',
          inFlightRun: buildInFlightRun({
            runId: 'run-live',
            status: 'running',
            feature: {
              id: 'feat-live',
              label: 'Add caching',
              startedAt: '2026-08-20T11:00:00.000Z'
            }
          })
        })
      ]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: 'run-live',
      queueId: 'queue-beta',
      source: 'in-flight',
      status: 'running',
      startedAt: '2026-08-20T11:00:00.000Z',
      completedAt: null,
      durationMs: null
    });
  });

  it('carries the non-terminal status through as the row status (FR-054)', () => {
    const rows = composeHistoryRows(
      [],
      [
        buildQueueRuntime({
          queueId: 'q1',
          inFlightRun: buildInFlightRun({ runId: 'r1', status: 'paused' })
        }),
        buildQueueRuntime({
          queueId: 'q2',
          inFlightRun: buildInFlightRun({ runId: 'r2', status: 'idle' })
        })
      ]
    );

    expect(rows.map((r) => r.status).sort()).toEqual(['idle', 'paused']);
  });

  it('produces no row for a queue that owns no run', () => {
    const rows = composeHistoryRows([], [buildQueueRuntime({ queueId: 'q1' })]);

    expect(rows).toEqual([]);
  });
});

describe('composeHistoryRows — a run present in both sources (T011)', () => {
  it('appears exactly once, as the recorded row (data-model §3 step 3)', () => {
    const rows = composeHistoryRows(
      [recorded({ runId: 'run-x', queueId: 'queue-alpha' })],
      [
        buildQueueRuntime({
          queueId: 'queue-alpha',
          inFlightRun: buildInFlightRun({ runId: 'run-x', status: 'running' })
        })
      ]
    );

    expect(rows).toHaveLength(1);
    // Recorded wins: it is the row carrying provenance and evidence, and the
    // in-flight projection is about to disappear on the next snapshot.
    expect(rows[0].source).toBe('recorded');
    expect(rows[0].status).toBe('completed');
  });
});

describe('composeHistoryRows — one order over two timestamps (T012)', () => {
  it('orders newest first using completedAt for recorded and startedAt for in-flight (FR-005)', () => {
    const rows = composeHistoryRows(
      [
        recorded({ runId: 'old', completedAt: '2026-08-20T09:00:00.000Z' }),
        recorded({ runId: 'newest', completedAt: '2026-08-20T13:00:00.000Z' })
      ],
      [
        buildQueueRuntime({
          queueId: 'q1',
          inFlightRun: buildInFlightRun({
            runId: 'middle',
            feature: {
              id: 'f',
              label: 'live',
              startedAt: '2026-08-20T11:00:00.000Z'
            }
          })
        })
      ]
    );

    expect(rows.map((r) => r.runId)).toEqual(['newest', 'middle', 'old']);
  });

  it('sorts a row with no ordering key last, deterministically (FR-005)', () => {
    const rows = composeHistoryRows(
      [
        recorded({ runId: 'keyless-a', completedAt: '' }),
        recorded({ runId: 'dated', completedAt: '2026-08-20T09:00:00.000Z' }),
        recorded({ runId: 'keyless-b', completedAt: '' })
      ],
      []
    );

    expect(rows.map((r) => r.runId)).toEqual(['dated', 'keyless-a', 'keyless-b']);
    // Stable across renders of the same set: no read-time clock is stamped in,
    // so composing twice cannot reorder the keyless pair.
    const again = composeHistoryRows(
      [
        recorded({ runId: 'keyless-a', completedAt: '' }),
        recorded({ runId: 'dated', completedAt: '2026-08-20T09:00:00.000Z' }),
        recorded({ runId: 'keyless-b', completedAt: '' })
      ],
      []
    );
    expect(again.map((r) => r.runId)).toEqual(rows.map((r) => r.runId));
  });

  it('leaves catalogVersion and origin null until User Story 2 fills them', () => {
    const rows = composeHistoryRows([recorded()], []);

    expect(rows[0].catalogVersion).toBeNull();
    expect(rows[0].origin).toBeNull();
  });
});
