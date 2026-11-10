// FR-R6-F11 T013 — the run-derived view builders (FR-007, FR-008; research R3, R12).
//
// WHAT THIS PINS, against a fixture with a retry, a wait between attempts, unknown durations
// and a group with no attempts:
//   - root rows and their four sorts, each ending with the root identity;
//   - attempt rows in root-created order, then step and attempt number;
//   - group keys: fixed dimensions first, then the chosen ones, ordered by code point or by
//     roots then key;
//   - counts, outcomes and nearest-rank distributions over known durations only, with an empty
//     population unavailable;
//   - failure-cause admits only failed, aborted and cancelled roots;
//   - time-series keys by local day in the query's zone;
//   - coverage, and cancellation through the slicer.

import { describe, expect, it } from 'vitest';
import type { ReportQuery } from '../../../src/contracts/reporting/report-query';
import type { Distribution, GroupRow, ReportRow } from '../../../src/contracts/reporting/report-rows';
import { buildRunRows, type RunRows } from '../../../src/services/reporting/report-aggregates';
import { validateReportQuery } from '../../../src/services/reporting/report-query-validator';
import { toUtcIso } from '../../../src/services/reporting/report-time';
import type { CapturedRuns, SnapshotAttempt, SnapshotRoot } from '../../../src/services/reporting/snapshot-capture';
import { createWorkSlicer } from '../../../src/services/reporting/work-slicer';

const DAY = 86_400_000;
const NOW = 10 * DAY;

function root(fields: Partial<SnapshotRoot> & Pick<SnapshotRoot, 'rootId' | 'createdAtMs'>): SnapshotRoot {
  return {
    workflowId: 'wf-a',
    frozenDefinitionId: 'fz-1',
    status: 'succeeded',
    startedAtMs: null,
    completedAtMs: null,
    failureCause: 'not-recorded',
    ...fields
  };
}

function attempt(
  fields: Partial<SnapshotAttempt> & Pick<SnapshotAttempt, 'attemptId' | 'rootId' | 'startedAtMs'>
): SnapshotAttempt {
  return {
    stepIndex: 0,
    phaseId: null,
    attemptNumber: 1,
    status: 'succeeded',
    exitCode: 0,
    completedAtMs: null,
    ...fields
  };
}

// r1 retried after a 500 ms wait: its wall clock (3000) is longer than its attempts (1000, 1500).
// r3 is still going, r4 never started and has no attempts, r5 is on the next day.
const RUNS: CapturedRuns = {
  roots: [
    root({ rootId: 'r1', createdAtMs: 1_000, status: 'failed', startedAtMs: 1_000, completedAtMs: 4_000, failureCause: 'phase_timeout' }),
    root({ rootId: 'r2', createdAtMs: 2_000, startedAtMs: 2_000, completedAtMs: 3_000 }),
    root({ rootId: 'r3', createdAtMs: 3_000, frozenDefinitionId: 'fz-2', status: 'running', startedAtMs: 3_000 }),
    root({ rootId: 'r4', createdAtMs: 4_000, workflowId: 'wf-b', frozenDefinitionId: null, status: 'cancelled', completedAtMs: 5_000 }),
    root({
      rootId: 'r5',
      createdAtMs: DAY + 100,
      workflowId: 'wf-b',
      frozenDefinitionId: null,
      status: 'aborted',
      startedAtMs: DAY + 100,
      completedAtMs: DAY + 3_100,
      failureCause: 'other'
    })
  ],
  attempts: [
    attempt({ attemptId: 'a1-1', rootId: 'r1', startedAtMs: 1_000, completedAtMs: 2_000, status: 'failed', exitCode: 1 }),
    attempt({ attemptId: 'a1-2', rootId: 'r1', attemptNumber: 2, startedAtMs: 2_500, completedAtMs: 4_000 }),
    attempt({ attemptId: 'a2-1', rootId: 'r2', startedAtMs: 2_000, completedAtMs: 3_000, phaseId: 'plan' }),
    attempt({ attemptId: 'a3-1', rootId: 'r3', startedAtMs: 3_000, status: 'running', exitCode: null }),
    attempt({ attemptId: 'a5-1', rootId: 'r5', startedAtMs: DAY + 100, completedAtMs: DAY + 1_100 })
  ]
};

function query(input: Record<string, unknown>): ReportQuery {
  const result = validateReportQuery(
    { range: { startMs: 0, endMs: NOW }, timezone: 'UTC', ...input },
    { nowMs: NOW, hostTimezone: 'UTC' }
  );
  if (!result.ok) {
    throw new Error(`fixture query refused: ${result.outcome}`);
  }
  return result.value;
}

async function build(input: Record<string, unknown>, runs: CapturedRuns = RUNS): Promise<RunRows> {
  const slicer = createWorkSlicer({ monotonicMs: () => 0, deadlineAtMs: 1 });
  const result = await buildRunRows(query(input), runs, slicer);
  if (!result.ok) {
    throw new Error(`expected rows, got ${result.outcome}`);
  }
  return result.value;
}

function ids(rows: readonly ReportRow[]): readonly string[] {
  return rows.map((row) => {
    switch (row.kind) {
      case 'root':
        return row.rootId;
      case 'attempt':
        return row.attemptId;
      default:
        return JSON.stringify(row.key);
    }
  });
}

function groups(rows: readonly ReportRow[]): readonly GroupRow[] {
  return rows.filter((row): row is GroupRow => row.kind === 'group');
}

function dist(
  basis: Distribution['basis'],
  samples: number,
  known: number,
  percentiles: readonly [Distribution['p50'], Distribution['p90'], Distribution['p99']]
): Distribution {
  const [p50, p90, p99] = percentiles;
  return { unit: 'ms', basis, samples, known, missing: samples - known, p50, p90, p99, method: 'nearest-rank' };
}

const NONE = ['unavailable', 'unavailable', 'unavailable'] as const;

const ZERO_OUTCOMES = { queued: 0, running: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 0, aborted: 0 };

describe('FR-R6-F11 T013 — execution summary root rows', () => {
  it('gives one row per root with its wall-clock duration and attempt count', async () => {
    const { rows, coverage } = await build({ view: 'execution-summary' });
    expect(ids(rows)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
    expect(rows.at(4)).toEqual({
      kind: 'root',
      rootId: 'r1',
      workflowId: 'wf-a',
      frozenDefinitionId: 'fz-1',
      outcome: 'failed',
      createdUtc: toUtcIso(1_000),
      durationMs: 3_000,
      attempts: 2
    });
    expect(rows.at(1)).toMatchObject({ rootId: 'r4', durationMs: null, attempts: 0 });
    expect(rows.at(2)).toMatchObject({ rootId: 'r3', durationMs: null, attempts: 1 });
    expect(coverage).toEqual({ roots: 5, attempts: 5, unknownDurations: 3 });
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows.at(0))).toBe(true);
  });

  it.each<[string, readonly string[]]>([
    ['root-created-asc', ['r1', 'r2', 'r3', 'r4', 'r5']],
    ['duration-desc', ['r1', 'r5', 'r2', 'r3', 'r4']],
    ['outcome-asc', ['r5', 'r4', 'r1', 'r3', 'r2']]
  ])('sorts root rows by %s, ending with the root identity', async (sort, expected) => {
    expect(ids((await build({ view: 'execution-summary', sort })).rows)).toEqual([...expected]);
  });

  it('breaks a created-time tie by root identity in either direction', async () => {
    const tied: CapturedRuns = {
      roots: [root({ rootId: 'r-b', createdAtMs: 500 }), root({ rootId: 'r-a', createdAtMs: 500 })],
      attempts: []
    };
    expect(ids((await build({ view: 'execution-summary' }, tied)).rows)).toEqual(['r-a', 'r-b']);
    expect(ids((await build({ view: 'execution-summary', sort: 'root-created-asc' }, tied)).rows)).toEqual(['r-a', 'r-b']);
  });

  it('groups by the chosen dimensions, with no attempt distribution', async () => {
    const rows = groups((await build({ view: 'execution-summary', groupBy: ['outcome'] })).rows);
    expect(rows.map((row) => row.key)).toEqual([
      { outcome: 'aborted' },
      { outcome: 'cancelled' },
      { outcome: 'failed' },
      { outcome: 'running' },
      { outcome: 'succeeded' }
    ]);
    const failed = rows.at(2);
    expect(failed).toEqual({
      kind: 'group',
      key: { outcome: 'failed' },
      roots: 1,
      attempts: 2,
      outcomes: { ...ZERO_OUTCOMES, failed: 1 },
      rootDuration: dist('root-wall-clock', 1, 1, [3_000, 3_000, 3_000])
    });
    expect(failed !== undefined && 'attemptDuration' in failed).toBe(false);
  });
});

describe('FR-R6-F11 T013 — attempt detail', () => {
  it('lists attempts newest root first, then step and attempt number, each with its own duration', async () => {
    const { rows } = await build({ view: 'attempt-detail' });
    expect(ids(rows)).toEqual(['a5-1', 'a3-1', 'a2-1', 'a1-1', 'a1-2']);
    expect(rows.at(4)).toEqual({
      kind: 'attempt',
      attemptId: 'a1-2',
      rootId: 'r1',
      attemptNumber: 2,
      stepIndex: 0,
      phaseId: null,
      status: 'succeeded',
      exitCode: 0,
      startedUtc: toUtcIso(2_500),
      completedUtc: toUtcIso(4_000),
      durationMs: 1_500
    });
    expect(rows.at(1)).toMatchObject({ attemptId: 'a3-1', completedUtc: null, durationMs: null });
    const ascending = await build({ view: 'attempt-detail', sort: 'root-created-asc' });
    expect(ids(ascending.rows)).toEqual(['a1-1', 'a1-2', 'a2-1', 'a3-1', 'a5-1']);
  });
});

describe('FR-R6-F11 T013 — workflow revision', () => {
  it('reports counts and nearest-rank distributions over known durations, an empty one unavailable', async () => {
    const rows = groups((await build({ view: 'workflow-revision' })).rows);
    expect(rows).toEqual([
      {
        kind: 'group',
        key: { workflowId: 'wf-a', frozenDefinitionId: 'fz-1' },
        roots: 2,
        attempts: 3,
        outcomes: { ...ZERO_OUTCOMES, failed: 1, succeeded: 1 },
        rootDuration: dist('root-wall-clock', 2, 2, [1_000, 3_000, 3_000]),
        attemptDuration: dist('attempt-own', 3, 3, [1_000, 1_500, 1_500])
      },
      {
        kind: 'group',
        key: { workflowId: 'wf-a', frozenDefinitionId: 'fz-2' },
        roots: 1,
        attempts: 1,
        outcomes: { ...ZERO_OUTCOMES, running: 1 },
        rootDuration: dist('root-wall-clock', 1, 0, NONE),
        attemptDuration: dist('attempt-own', 1, 0, NONE)
      },
      {
        kind: 'group',
        key: { workflowId: 'wf-b', frozenDefinitionId: null },
        roots: 2,
        attempts: 1,
        outcomes: { ...ZERO_OUTCOMES, cancelled: 1, aborted: 1 },
        rootDuration: dist('root-wall-clock', 2, 1, [3_000, 3_000, 3_000]),
        attemptDuration: dist('attempt-own', 1, 1, [1_000, 1_000, 1_000])
      }
    ]);
  });

  it('orders by roots, then by key, under roots-desc', async () => {
    const rows = groups((await build({ view: 'workflow-revision', sort: 'roots-desc' })).rows);
    expect(rows.map((row) => row.key)).toEqual([
      { workflowId: 'wf-a', frozenDefinitionId: 'fz-1' },
      { workflowId: 'wf-b', frozenDefinitionId: null },
      { workflowId: 'wf-a', frozenDefinitionId: 'fz-2' }
    ]);
  });

  it('reports a group whose roots have no attempts with an unavailable attempt distribution', async () => {
    const lone: CapturedRuns = { roots: [root({ rootId: 'solo', createdAtMs: 100 })], attempts: [] };
    const rows = groups((await build({ view: 'workflow-revision' }, lone)).rows);
    expect(rows.at(0)?.attemptDuration).toEqual(dist('attempt-own', 0, 0, NONE));
  });
});

describe('FR-R6-F11 T013 — failure cause', () => {
  it('admits only failed, aborted and cancelled roots, keyed by cause', async () => {
    const { rows, coverage } = await build({ view: 'failure-cause' });
    expect(groups(rows).map((row) => [row.key, row.roots])).toEqual([
      [{ failureCause: 'not-recorded' }, 1],
      [{ failureCause: 'other' }, 1],
      [{ failureCause: 'phase_timeout' }, 1]
    ]);
    expect(coverage).toEqual({ roots: 3, attempts: 3, unknownDurations: 1 });
  });

  it('puts the fixed cause before a chosen dimension', async () => {
    const rows = groups((await build({ view: 'failure-cause', groupBy: ['workflowId'] })).rows);
    expect(rows.map((row) => Object.keys(row.key ?? {}))).toEqual([
      ['failureCause', 'workflowId'],
      ['failureCause', 'workflowId'],
      ['failureCause', 'workflowId']
    ]);
    expect(rows.at(0)?.key).toEqual({ failureCause: 'not-recorded', workflowId: 'wf-b' });
  });
});

describe('FR-R6-F11 T013 — time series', () => {
  it('keys each root by its local creation day in the query zone', async () => {
    const utc = groups((await build({ view: 'time-series' })).rows);
    expect(utc.map((row) => [row.key, row.roots, row.attempts])).toEqual([
      [{ localDay: '1970-01-01' }, 4, 4],
      [{ localDay: '1970-01-02' }, 1, 1]
    ]);
    expect(utc.at(0)?.rootDuration).toEqual(dist('root-wall-clock', 4, 2, [1_000, 3_000, 3_000]));
    expect(utc.at(0)?.attemptDuration).toEqual(dist('attempt-own', 4, 3, [1_000, 1_500, 1_500]));

    const newYork = groups((await build({ view: 'time-series', timezone: 'America/New_York' })).rows);
    expect(newYork.map((row) => row.key)).toEqual([{ localDay: '1969-12-31' }, { localDay: '1970-01-01' }]);
  });

  it('adds a chosen dimension after the day', async () => {
    const rows = groups((await build({ view: 'time-series', groupBy: ['workflowId'] })).rows);
    expect(rows.map((row) => row.key)).toEqual([
      { localDay: '1970-01-01', workflowId: 'wf-a' },
      { localDay: '1970-01-01', workflowId: 'wf-b' },
      { localDay: '1970-01-02', workflowId: 'wf-b' }
    ]);
  });
});

describe('FR-R6-F11 T013 — empty population and cancellation', () => {
  it('gives no rows and zero coverage for an empty snapshot', async () => {
    const empty: CapturedRuns = { roots: [], attempts: [] };
    for (const view of ['execution-summary', 'attempt-detail', 'workflow-revision', 'failure-cause', 'time-series']) {
      const result = await build({ view }, empty);
      expect(result.rows).toEqual([]);
      expect(result.coverage).toEqual({ roots: 0, attempts: 0, unknownDurations: 0 });
    }
  });

  it('ends cancelled when the slicer signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const slicer = createWorkSlicer({ monotonicMs: () => 0, deadlineAtMs: 1, signal: controller.signal });
    const result = await buildRunRows(query({ view: 'workflow-revision' }), RUNS, slicer);
    expect(result).toEqual({ ok: false, outcome: 'cancelled' });
  });
});
