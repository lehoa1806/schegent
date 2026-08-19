// FR-R3-009 T398 — cumulative totals compose the rollup with the retained fold,
// deduplicated by run id.
//
// The two ranges overlap by design. A run that ended yesterday is in the rollup
// *and* still in the live audit log, so a naive sum counts it twice; a run that
// ended before this feature shipped is only in the fold, so dropping the fold
// loses it. Deduplication by run id is what lets both hold at once, and the
// rollup wins on overlap because it was written while the evidence was present.
//
// The coverage windows are part of the same contract: a figure whose range is
// unstated reads as an all-time figure whether or not it is one, so
// `buildMetricsCoverage` reports the rollup's range and the log's range
// separately.

import { describe, expect, it } from 'vitest';
import {
  buildMetricsCoverage,
  composeCumulativeTotals,
  EMPTY_CUMULATIVE_TOTALS,
  factsFromTaskRecord,
  METRICS_ROLLUP_SCHEMA_VERSION,
  parseMetricsRollupLine,
  serializeMetricsRollupRecord,
  type MetricsRollupRecord
} from '../../../src/metrics/metrics-rollup';
import type { TaskRecord } from '../../../src/contracts/sidebar-ipc';

function record(overrides: Partial<MetricsRollupRecord> = {}): MetricsRollupRecord {
  return {
    v: METRICS_ROLLUP_SCHEMA_VERSION,
    runId: 'run-1',
    terminalStatus: 'completed',
    startedAt: '2026-03-01T00:00:00.000Z',
    endedAt: '2026-03-01T00:05:00.000Z',
    durationMs: 300_000,
    phasesTotal: 7,
    phasesCompleted: 7,
    phasesSkipped: 0,
    backendInvocations: 10,
    costUsd: 1,
    ...overrides
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    runId: 'run-1',
    description: 'add feature X',
    startTime: '2026-03-01T00:00:00.000Z',
    endTime: '2026-03-01T00:05:00.000Z',
    durationMs: 300_000,
    status: 'completed',
    isRunning: false,
    phasesTotal: 7,
    phasesCompleted: 7,
    phasesSkipped: 0,
    totalCostUsd: 1,
    totalBackendInvocations: 10,
    phases: [],
    source: 'task-lifecycle',
    ...overrides
  };
}

describe('composeCumulativeTotals — overlap deduplication (FR-R3-009, T398)', () => {
  it('counts a run present in both ranges once', () => {
    const { totals, rollupRuns } = composeCumulativeTotals([record({ runId: 'run-1' })], [task({ runId: 'run-1' })]);

    expect(rollupRuns).toBe(1);
    expect(totals.runs).toBe(1);
    expect(totals.durationMs).toBe(300_000);
    expect(totals.costUsd).toBe(1);
    expect(totals.backendInvocations).toBe(10);
  });

  it('adds fold-only runs the rollup never recorded', () => {
    // A workspace that predates the rollup: its older runs exist only in the
    // audit corpus, and dropping them would make totals fall on first upgrade.
    const { totals, rollupRuns } = composeCumulativeTotals(
      [record({ runId: 'run-new' })],
      [task({ runId: 'run-new' }), task({ runId: 'run-old', durationMs: 100_000, totalCostUsd: 0.5, totalBackendInvocations: 4 })]
    );

    expect(rollupRuns).toBe(1);
    expect(totals.runs).toBe(2);
    expect(totals.durationMs).toBe(400_000);
    expect(totals.costUsd).toBe(1.5);
    expect(totals.backendInvocations).toBe(14);
  });

  it('prefers the rollup record over the fold on overlap', () => {
    // Same run, different numbers. The rollup was written at the terminal
    // transition with the evidence present; a fold over a partially pruned
    // corpus can only understate, so it must not win.
    const { totals } = composeCumulativeTotals(
      [record({ runId: 'run-1', durationMs: 300_000, backendInvocations: 10, costUsd: 1 })],
      [task({ runId: 'run-1', durationMs: 1, totalBackendInvocations: 1, totalCostUsd: 0.01 })]
    );

    expect(totals.durationMs).toBe(300_000);
    expect(totals.backendInvocations).toBe(10);
    expect(totals.costUsd).toBe(1);
  });

  it('counts a duplicate run id inside the rollup once', () => {
    // Two hosts can each append after reading the file and before seeing the
    // other's write. Both records describe the same run.
    const { totals, rollupRuns } = composeCumulativeTotals(
      [record({ runId: 'run-1' }), record({ runId: 'run-1' })],
      []
    );

    expect(rollupRuns).toBe(1);
    expect(totals.runs).toBe(1);
    expect(totals.durationMs).toBe(300_000);
  });

  it('separates terminal outcomes into their own counters', () => {
    const { totals } = composeCumulativeTotals(
      [
        record({ runId: 'a', terminalStatus: 'completed' }),
        record({ runId: 'b', terminalStatus: 'failed' }),
        record({ runId: 'c', terminalStatus: 'canceled' }),
        record({ runId: 'd', terminalStatus: 'failed' })
      ],
      []
    );

    expect(totals).toMatchObject({ runs: 4, completedRuns: 1, failedRuns: 2, canceledRuns: 1 });
  });

  it('returns zeroed totals for two empty ranges', () => {
    const { totals, rollupRuns } = composeCumulativeTotals([], []);
    expect(totals).toEqual(EMPTY_CUMULATIVE_TOTALS);
    expect(rollupRuns).toBe(0);
  });
});

describe('composeCumulativeTotals — cost partiality (FR-R3-009, T398)', () => {
  it('marks the cost total partial when a counted run reported no cost', () => {
    const { totals } = composeCumulativeTotals(
      [record({ runId: 'a', costUsd: 2 }), record({ runId: 'b', costUsd: undefined })],
      []
    );

    expect(totals.costUsd).toBe(2);
    expect(totals.costUsdIsPartial).toBe(true);
  });

  it('leaves the cost total exact when every counted run reported one', () => {
    const { totals } = composeCumulativeTotals(
      [record({ runId: 'a', costUsd: 2 }), record({ runId: 'b', costUsd: 0 })],
      []
    );

    expect(totals.costUsd).toBe(2);
    // A reported zero is not a missing cost: the total is exact.
    expect(totals.costUsdIsPartial).toBe(false);
  });
});

describe('factsFromTaskRecord — which fold rows are countable (FR-R3-009, T398)', () => {
  it('excludes a running task', () => {
    expect(factsFromTaskRecord(task({ isRunning: true }))).toBeNull();
  });

  it('excludes a task with no terminal status or no end time', () => {
    expect(factsFromTaskRecord(task({ status: undefined }))).toBeNull();
    expect(factsFromTaskRecord(task({ endTime: undefined }))).toBeNull();
  });

  it('does not let an in-flight run inflate the totals', () => {
    const { totals } = composeCumulativeTotals([], [task({ runId: 'live', isRunning: true })]);
    expect(totals.runs).toBe(0);
  });
});

describe('buildMetricsCoverage — two windows stated separately (FR-R3-009, T394)', () => {
  it('reports the rollup range and the log range independently', () => {
    const coverage = buildMetricsCoverage({
      rollupAvailable: true,
      rollupRuns: 40,
      rollupEarliest: '2026-01-01T00:00:00.000Z',
      rollupLatest: '2026-08-01T00:00:00.000Z',
      logEarliest: '2026-07-01T00:00:00.000Z',
      logLatest: '2026-08-01T00:00:00.000Z',
      includesArchives: true
    });

    expect(coverage.totals).toEqual({
      available: true,
      earliest: '2026-01-01T00:00:00.000Z',
      latest: '2026-08-01T00:00:00.000Z',
      runs: 40
    });
    expect(coverage.detail).toEqual({
      earliest: '2026-07-01T00:00:00.000Z',
      latest: '2026-08-01T00:00:00.000Z',
      includesArchives: true
    });
  });

  it('omits absent bounds rather than inventing them', () => {
    const coverage = buildMetricsCoverage({
      rollupAvailable: false,
      rollupRuns: 0,
      includesArchives: false
    });

    expect(coverage.totals).toEqual({ available: false, runs: 0 });
    expect(coverage.detail).toEqual({ includesArchives: false });
  });

  it('derives the rollup range from the records it composed', () => {
    const composed = composeCumulativeTotals(
      [
        record({ runId: 'mid', endedAt: '2026-04-01T00:00:00.000Z' }),
        record({ runId: 'first', endedAt: '2026-01-01T00:00:00.000Z' }),
        record({ runId: 'last', endedAt: '2026-08-01T00:00:00.000Z' })
      ],
      []
    );

    const coverage = buildMetricsCoverage({
      rollupAvailable: true,
      rollupRuns: composed.rollupRuns,
      rollupEarliest: composed.rollupEarliest,
      rollupLatest: composed.rollupLatest,
      includesArchives: false
    });

    expect(coverage.totals.earliest).toBe('2026-01-01T00:00:00.000Z');
    expect(coverage.totals.latest).toBe('2026-08-01T00:00:00.000Z');
    expect(coverage.totals.runs).toBe(3);
  });
});

describe('parseMetricsRollupLine — what a reader accepts (FR-R3-009, T389)', () => {
  it('round-trips a serialized record', () => {
    const original = record({ runId: 'run-rt' });
    const { record: parsed, warning } = parseMetricsRollupLine(serializeMetricsRollupRecord(original));
    expect(warning).toBeUndefined();
    expect(parsed).toEqual(original);
  });

  it('ignores a blank line without counting it unreadable', () => {
    expect(parseMetricsRollupLine('   ')).toEqual({ record: null });
  });

  it('reads a record written by a newer schema version', () => {
    // Rollup fields are additive by policy, so a newer writer's record still
    // carries every field this build knows. Refusing it would make a total drop
    // for an operator who downgraded — the exact defect the rollup removes.
    const line = JSON.stringify({
      ...record({ runId: 'run-future' }),
      v: METRICS_ROLLUP_SCHEMA_VERSION + 5,
      somethingNew: 'ignored'
    });
    const { record: parsed, warning } = parseMetricsRollupLine(line);

    expect(warning).toBeUndefined();
    expect(parsed).toMatchObject({ runId: 'run-future', v: METRICS_ROLLUP_SCHEMA_VERSION + 5 });
  });

  it.each([
    ['not-json', 'nope'],
    ['not-an-object', '[1,2,3]'],
    ['unsupported-version', JSON.stringify({ ...record(), v: 0 })],
    ['invalid-runId', JSON.stringify({ ...record(), runId: '' })],
    ['invalid-terminalStatus', JSON.stringify({ ...record(), terminalStatus: 'paused' })],
    ['invalid-timestamp', JSON.stringify({ ...record(), endedAt: 'not a date' })],
    ['invalid-counter', JSON.stringify({ ...record(), durationMs: -1 })],
    ['invalid-costUsd', JSON.stringify({ ...record(), costUsd: 'free' })]
  ])('refuses a malformed record as %s rather than guessing', (warning, line) => {
    expect(parseMetricsRollupLine(line)).toEqual({ record: null, warning });
  });

  it('refuses a record with no version marker', () => {
    const { v: _dropped, ...withoutVersion } = record();
    expect(parseMetricsRollupLine(JSON.stringify(withoutVersion))).toEqual({
      record: null,
      warning: 'unsupported-version'
    });
  });

  it('does not let a refused record contribute to totals', () => {
    const parsed = parseMetricsRollupLine(JSON.stringify({ ...record(), durationMs: -1 }));
    const records = parsed.record === null ? [] : [parsed.record];
    expect(composeCumulativeTotals(records, []).totals).toEqual(EMPTY_CUMULATIVE_TOTALS);
  });
});
