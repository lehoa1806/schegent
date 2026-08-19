// FR-R3-009 T399 — cumulative totals only ever grow.
//
// The property under test is the user story stated as an invariant: for any
// sequence of run completions, audit-log rotations, and host reloads, no
// cumulative figure is ever smaller than it was at an earlier step. That is the
// whole point of the rollup — the fold it composes with is taken over a corpus
// that retention prunes, so a figure derived from the fold alone shrinks as
// evidence ages out, and a number quoted last month stops being the number this
// month.
//
// The generator is seeded rather than random so a failure is reproducible; the
// point is breadth over shapes (durations, costs, missing costs, mixed
// outcomes), not nondeterminism.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeCumulativeTotals,
  METRICS_ROLLUP_SCHEMA_VERSION,
  type MetricsRollupRecord
} from '../../../src/metrics/metrics-rollup';
import { readMetricsRollup } from '../../../src/metrics/metrics-rollup-reader';
import { MetricsRollupWriter } from '../../../src/metrics/metrics-rollup-writer';
import type { CumulativeTotals, TaskRecord } from '../../../src/contracts/sidebar-ipc';
import type { SanitizedLogger } from '../../../src/lib/logger';

const MONOTONIC_FIELDS = [
  'runs',
  'completedRuns',
  'failedRuns',
  'canceledRuns',
  'durationMs',
  'costUsd',
  'phasesTotal',
  'phasesCompleted',
  'phasesSkipped',
  'backendInvocations'
] as const satisfies readonly (keyof CumulativeTotals)[];

// Deterministic 32-bit LCG. A seeded generator keeps a failing case
// reproducible, which a Math.random-driven one would not.
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function silentLogger(): SanitizedLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    sanitize: (value: string) => value
  } as unknown as SanitizedLogger;
}

interface SimulatedRun {
  readonly runId: string;
  readonly terminalStatus: 'completed' | 'failed' | 'canceled';
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly phasesTotal: number;
  readonly phasesCompleted: number;
  readonly phasesSkipped: number;
  readonly backendInvocations: number;
  readonly costUsd: number | undefined;
}

const STATUSES = ['completed', 'failed', 'canceled'] as const;
const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');

function generateRuns(seed: number, count: number): SimulatedRun[] {
  const next = lcg(seed);
  const runs: SimulatedRun[] = [];
  for (let index = 0; index < count; index += 1) {
    const startMs = BASE_MS + index * 3_600_000;
    const durationMs = Math.floor(next() * 900_000);
    const phasesTotal = 1 + Math.floor(next() * 7);
    const phasesSkipped = Math.floor(next() * phasesTotal);
    runs.push({
      runId: `run-${index}`,
      terminalStatus: STATUSES[Math.floor(next() * STATUSES.length)]!,
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(startMs + durationMs).toISOString(),
      durationMs,
      phasesTotal,
      phasesCompleted: phasesTotal - phasesSkipped,
      phasesSkipped,
      backendInvocations: Math.floor(next() * 30),
      // Roughly one run in five reports no cost, so the partiality flag and the
      // "absent, not zero" distinction are exercised.
      costUsd: next() < 0.2 ? undefined : Math.round(next() * 500) / 100
    });
  }
  return runs;
}

function toRollupRecord(run: SimulatedRun): MetricsRollupRecord {
  return {
    v: METRICS_ROLLUP_SCHEMA_VERSION,
    runId: run.runId,
    terminalStatus: run.terminalStatus,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    phasesTotal: run.phasesTotal,
    phasesCompleted: run.phasesCompleted,
    phasesSkipped: run.phasesSkipped,
    backendInvocations: run.backendInvocations,
    ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd })
  };
}

function toTaskRecord(run: SimulatedRun): TaskRecord {
  return {
    runId: run.runId,
    description: `task ${run.runId}`,
    startTime: run.startedAt,
    endTime: run.endedAt,
    durationMs: run.durationMs,
    status: run.terminalStatus,
    isRunning: false,
    phasesTotal: run.phasesTotal,
    phasesCompleted: run.phasesCompleted,
    phasesSkipped: run.phasesSkipped,
    totalCostUsd: run.costUsd,
    totalBackendInvocations: run.backendInvocations,
    phases: [],
    source: 'task-lifecycle'
  };
}

function expectNotBelow(later: CumulativeTotals, earlier: CumulativeTotals, step: string): void {
  for (const field of MONOTONIC_FIELDS) {
    expect(
      later[field],
      `${field} fell from ${earlier[field]} to ${later[field]} at ${step}`
    ).toBeGreaterThanOrEqual(earlier[field]);
  }
}

describe('cumulative totals are monotonic (FR-R3-009, T399)', () => {
  it.each([1, 7, 42, 20_260_818])(
    'never falls across interleaved completions and prunes (seed %i)',
    (seed) => {
      const runs = generateRuns(seed, 60);
      const rollup: MetricsRollupRecord[] = [];
      // The fold window is a moving suffix: retention prunes the oldest evidence
      // while new runs land at the head, which is exactly how the audit corpus
      // behaves in service.
      let pruneCursor = 0;
      let previous = composeCumulativeTotals([], []).totals;

      for (let index = 0; index < runs.length; index += 1) {
        const run = runs[index]!;
        rollup.push(toRollupRecord(run));

        // Every third completion also prunes the oldest surviving log evidence.
        if (index % 3 === 2) pruneCursor += 1;
        const foldWindow = runs.slice(pruneCursor, index + 1).map(toTaskRecord);

        const totals = composeCumulativeTotals(rollup, foldWindow).totals;
        expectNotBelow(totals, previous, `completion ${index}`);
        expect(totals.runs).toBe(index + 1);
        previous = totals;
      }

      // With every log entry pruned, the totals still hold every run.
      const afterFullPrune = composeCumulativeTotals(rollup, []).totals;
      expectNotBelow(afterFullPrune, previous, 'full prune');
      expect(afterFullPrune.runs).toBe(runs.length);
    }
  );

  it('is unchanged by a reload that re-reads the same rollup', () => {
    const runs = generateRuns(99, 25);
    const rollup = runs.map(toRollupRecord);
    const first = composeCumulativeTotals(rollup, runs.map(toTaskRecord)).totals;

    // A reload re-reads the file and re-folds the log; nothing is recomputed
    // from a different domain, so the answer must be byte-identical.
    const second = composeCumulativeTotals(rollup, runs.map(toTaskRecord)).totals;
    const thirdWithNoLog = composeCumulativeTotals(rollup, []).totals;

    expect(second).toEqual(first);
    expect(thirdWithNoLog).toEqual(first);
  });

  it('holds when the fold and the rollup disagree about a run', () => {
    // A fold over a partially pruned corpus can only understate a run it can
    // still see. Preferring the rollup is what keeps the total from dipping.
    const runs = generateRuns(5, 10);
    const full = composeCumulativeTotals(runs.map(toRollupRecord), []).totals;
    const understated = composeCumulativeTotals(
      runs.map(toRollupRecord),
      runs.map((run) => toTaskRecord({ ...run, durationMs: 0, backendInvocations: 0, costUsd: 0 }))
    ).totals;

    expect(understated).toEqual(full);
  });

  it('grows when a run reaches the fold before the rollup, and does not double-count when the rollup catches up', () => {
    const runs = generateRuns(11, 4);
    const recorded = runs.slice(0, 3);
    const pending = runs[3]!;

    const beforeRollupCatchesUp = composeCumulativeTotals(
      recorded.map(toRollupRecord),
      [...recorded, pending].map(toTaskRecord)
    ).totals;
    const afterRollupCatchesUp = composeCumulativeTotals(
      [...recorded, pending].map(toRollupRecord),
      [...recorded, pending].map(toTaskRecord)
    ).totals;

    expect(beforeRollupCatchesUp.runs).toBe(4);
    expect(afterRollupCatchesUp.runs).toBe(4);
    expectNotBelow(afterRollupCatchesUp, beforeRollupCatchesUp, 'rollup catch-up');
  });

  // The one documented residual, asserted rather than glossed over: a run the
  // rollup never recorded is held only by its log evidence, so pruning that
  // evidence does drop it. This is why rollup writability is surfaced in
  // evidence health instead of being papered over with a backfill from a corpus
  // that may already be incomplete.
  it('does drop a run whose rollup append failed once its log evidence is pruned', () => {
    const runs = generateRuns(13, 5);
    const missedByRollup = runs[2]!;
    const rollup = runs.filter((run) => run.runId !== missedByRollup.runId).map(toRollupRecord);

    const withEvidence = composeCumulativeTotals(rollup, runs.map(toTaskRecord)).totals;
    const afterPrune = composeCumulativeTotals(rollup, []).totals;

    expect(withEvidence.runs).toBe(5);
    expect(afterPrune.runs).toBe(4);
  });
});

describe('cumulative totals survive a real writer/reader round trip (FR-R3-009, T399)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'schegent-rollup-monotonic-'));
  });
  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('reads back the same totals a session appended, with no log evidence at all', async () => {
    const runs = generateRuns(21, 30);
    const writer = new MetricsRollupWriter({ workspaceRoot, logger: silentLogger() });
    for (const run of runs) {
      await writer.append({
        runId: run.runId,
        terminalStatus: run.terminalStatus,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: run.durationMs,
        phasesTotal: run.phasesTotal,
        phasesCompleted: run.phasesCompleted,
        phasesSkipped: run.phasesSkipped,
        backendInvocations: run.backendInvocations,
        ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd })
      });
    }

    const read = await readMetricsRollup(workspaceRoot, silentLogger());
    expect(read.available).toBe(true);
    expect(read.unreadableRecords).toBe(0);

    const fromDisk = composeCumulativeTotals(read.records, []).totals;
    const expected = composeCumulativeTotals(runs.map(toRollupRecord), []).totals;
    expect(fromDisk).toEqual(expected);
  });

  it('reports an absent rollup as unavailable with zeroed totals rather than a fabricated zero window', async () => {
    const read = await readMetricsRollup(workspaceRoot, silentLogger());
    expect(read).toEqual({ available: false, records: [], unreadableRecords: 0 });
  });
});
