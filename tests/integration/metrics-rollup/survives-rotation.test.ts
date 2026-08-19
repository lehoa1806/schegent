// FR-R3-009 T400 — cumulative totals are unchanged across an archive prune.
//
// This is the acceptance test for the finding itself. Every metric in
// `metrics-service.ts` is a fold over `.schegent/audit.log` plus its rotated
// archives, and that corpus is pruned on two triggers: an eleventh archive, or a
// ninety-first day. Before the rollup, a cumulative figure derived from that
// fold shrank whenever the corpus did — the total an operator quoted last month
// stopped being the total this month, silently, because a smaller fold still
// looks like a complete answer.
//
// The test drives the REAL metrics service over a REAL `.schegent/` tree rather
// than composing in memory, because the property only holds if three separate
// things line up on disk: the archive scan finds the archives, the rollup file
// is read alongside the fold, and the two ranges deduplicate by run id. A pure
// composition test (T398) cannot catch a break in any of the three.
//
// The prune is performed by deleting archive files, which is what
// `AuditLogWriter`'s retention does to them. Nothing in the product ever
// rewrites the rollup, so its file is left exactly as the runs left it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import { readMetrics } from '../../../src/metrics/metrics-service';
import { MetricsRollupWriter } from '../../../src/metrics/metrics-rollup-writer';
import { METRICS_ROLLUP_FILENAME } from '../../../src/metrics/metrics-rollup';
import type { SanitizedLogger } from '../../../src/lib/logger';
import type { CumulativeTotals } from '../../../src/contracts/sidebar-ipc';

const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');
const RUN_COUNT = 12;
/** Runs 0-7 live in archives; 8-11 live in the live log. */
const ARCHIVED_RUNS = 8;
const COST_PER_PHASE = 0.25;
const PHASES_PER_RUN = 2;
const INVOCATIONS_PER_PHASE = 2;

let workspaceRoot: string;
let auditDir: string;

function silentLogger(): SanitizedLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    sanitize: (value: string) => value
  } as unknown as SanitizedLogger;
}

function entry(overrides: Partial<AuditEntry> & Pick<AuditEntry, 'id' | 'timestamp' | 'runId' | 'eventType'>): string {
  return `${JSON.stringify({
    phase: 'speckit-plan',
    iteration: 1,
    payload: {},
    outcome: 'info',
    ...overrides
  })}\n`;
}

interface SeededRun {
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
}

// One complete run: a task-execution pair wrapping two phases, each with its own
// cli-invocation entries and cost. Shaped like the real log so the fold produces
// the same TaskRecord the product would build.
function runLines(index: number): { lines: string; run: SeededRun } {
  const startMs = BASE_MS + index * 86_400_000;
  const durationMs = 300_000;
  const runId = `run-${String(index).padStart(2, '0')}`;
  const at = (offsetMs: number): string => new Date(startMs + offsetMs).toISOString();
  const parts: string[] = [
    entry({
      id: `${runId}-start`,
      timestamp: at(0),
      runId,
      phase: 'speckit-specify',
      iteration: 0,
      eventType: 'task-execution-started',
      payload: { taskId: runId, runId, queueId: 'default', pipelineId: 'default', isResume: false }
    })
  ];

  for (let phaseIndex = 0; phaseIndex < PHASES_PER_RUN; phaseIndex += 1) {
    const phase = phaseIndex === 0 ? 'speckit-plan' : 'speckit-implement';
    const phaseStartMs = 1000 + phaseIndex * 100_000;
    parts.push(
      entry({ id: `${runId}-p${phaseIndex}-start`, timestamp: at(phaseStartMs), runId, phase, iteration: 1, eventType: 'phase-start', payload: { pipelineId: 'default', phaseId: phase } })
    );
    for (let invocation = 0; invocation < INVOCATIONS_PER_PHASE; invocation += 1) {
      parts.push(
        entry({ id: `${runId}-p${phaseIndex}-i${invocation}`, timestamp: at(phaseStartMs + 100 + invocation), runId, phase, iteration: 1, eventType: 'cli-invocation', payload: { pipelineId: 'default', phaseId: phase } })
      );
    }
    parts.push(
      entry({
        id: `${runId}-p${phaseIndex}-end`,
        timestamp: at(phaseStartMs + 90_000),
        runId,
        phase,
        iteration: 1,
        eventType: 'phase-end',
        outcome: 'success',
        payload: { pipelineId: 'default', phaseId: phase, outcome: 'clean', totalCostUsd: COST_PER_PHASE }
      })
    );
  }

  parts.push(
    entry({
      id: `${runId}-end`,
      timestamp: at(durationMs),
      runId,
      phase: 'done',
      iteration: 0,
      eventType: 'task-execution-ended',
      outcome: 'success',
      payload: {
        taskId: runId,
        runId,
        terminalStatus: 'completed',
        durationMs,
        phasesTotal: PHASES_PER_RUN,
        phasesCompleted: PHASES_PER_RUN,
        phasesSkipped: 0
      }
    })
  );

  return {
    lines: parts.join(''),
    run: { runId, startedAt: at(0), endedAt: at(durationMs), durationMs }
  };
}

// Archive stamps must match the metrics service's ARCHIVE_STAMP_RE, or the
// archive scan skips them and the "before" figure is wrong for the wrong reason.
function archiveName(index: number): string {
  return `audit.log.2026010${index + 1}-000000`;
}

async function seedCorpus(): Promise<SeededRun[]> {
  const runs: SeededRun[] = [];
  const archiveBuckets: string[][] = [[], [], [], []];
  let liveLog = '';

  for (let index = 0; index < RUN_COUNT; index += 1) {
    const { lines, run } = runLines(index);
    runs.push(run);
    if (index < ARCHIVED_RUNS) archiveBuckets[Math.floor(index / 2)]!.push(lines);
    else liveLog += lines;
  }

  for (const [bucketIndex, bucket] of archiveBuckets.entries()) {
    await writeFile(join(auditDir, archiveName(bucketIndex)), bucket.join(''), 'utf8');
  }
  await writeFile(join(auditDir, 'audit.log'), liveLog, 'utf8');
  return runs;
}

async function recordRollup(runs: readonly SeededRun[]): Promise<void> {
  const writer = new MetricsRollupWriter({ workspaceRoot, logger: silentLogger() });
  for (const run of runs) {
    const outcome = await writer.append({
      runId: run.runId,
      terminalStatus: 'completed',
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.durationMs,
      phasesTotal: PHASES_PER_RUN,
      phasesCompleted: PHASES_PER_RUN,
      phasesSkipped: 0,
      backendInvocations: PHASES_PER_RUN * INVOCATIONS_PER_PHASE,
      costUsd: PHASES_PER_RUN * COST_PER_PHASE
    });
    expect(outcome).toEqual({ outcome: 'appended' });
  }
}

async function pruneArchives(): Promise<void> {
  for (let bucketIndex = 0; bucketIndex < 4; bucketIndex += 1) {
    await rm(join(auditDir, archiveName(bucketIndex)), { force: true });
  }
}

function readCumulative(response: { cumulative: CumulativeTotals }): CumulativeTotals {
  return response.cumulative;
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'schegent-rollup-rotation-'));
  auditDir = join(workspaceRoot, '.schegent');
  await mkdir(auditDir, { recursive: true });
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('metrics rollup survives an archive prune (FR-R3-009, T400)', () => {
  it('reports identical cumulative totals before and after every archive is pruned', async () => {
    const runs = await seedCorpus();
    await recordRollup(runs);

    const before = await readMetrics(workspaceRoot, { includeArchives: true }, silentLogger());
    expect(before.tasks).toHaveLength(RUN_COUNT);
    expect(readCumulative(before)).toMatchObject({
      runs: RUN_COUNT,
      completedRuns: RUN_COUNT,
      durationMs: RUN_COUNT * 300_000,
      costUsd: RUN_COUNT * PHASES_PER_RUN * COST_PER_PHASE,
      costUsdIsPartial: false,
      backendInvocations: RUN_COUNT * PHASES_PER_RUN * INVOCATIONS_PER_PHASE
    });

    await pruneArchives();

    const after = await readMetrics(workspaceRoot, { includeArchives: true }, silentLogger());

    // The detail genuinely shrinks — that evidence is gone, and the view must
    // not pretend otherwise.
    expect(after.tasks).toHaveLength(RUN_COUNT - ARCHIVED_RUNS);
    // The cumulative figures do not.
    expect(readCumulative(after)).toEqual(readCumulative(before));
  });

  it('states the two coverage windows separately, with the totals window wider than the detail window', async () => {
    const runs = await seedCorpus();
    await recordRollup(runs);
    await pruneArchives();

    const after = await readMetrics(workspaceRoot, { includeArchives: true }, silentLogger());

    expect(after.coverage.totals.available).toBe(true);
    expect(after.coverage.totals.runs).toBe(RUN_COUNT);
    expect(after.coverage.totals.earliest).toBe(runs[0]!.endedAt);

    const totalsEarliestMs = Date.parse(after.coverage.totals.earliest!);
    const detailEarliestMs = Date.parse(after.coverage.detail.earliest!);
    expect(detailEarliestMs).toBeGreaterThan(totalsEarliestMs);
    expect(after.coverage.detail.includesArchives).toBe(true);
  });

  it('does not rewrite or trim the rollup file when the audit corpus is pruned', async () => {
    const runs = await seedCorpus();
    await recordRollup(runs);
    const rollupPath = join(auditDir, METRICS_ROLLUP_FILENAME);
    const before = await readFile(rollupPath, 'utf8');

    await pruneArchives();
    await readMetrics(workspaceRoot, { includeArchives: true }, silentLogger());

    // Reading is a read. Recomputing the rollup from a pruned corpus is the one
    // operation that could lose a total, so nothing in the read path may write.
    expect(await readFile(rollupPath, 'utf8')).toBe(before);
    expect(before.trim().split('\n')).toHaveLength(RUN_COUNT);
  });

  it('falls back to the retained fold for a workspace with no rollup at all', async () => {
    await seedCorpus();

    const response = await readMetrics(workspaceRoot, { includeArchives: true }, silentLogger());

    // A workspace that predates the feature has no rollup file. Its totals still
    // answer from the fold, and the coverage window says the totals are not
    // rollup-backed rather than presenting them as all-time.
    expect(response.coverage.totals.available).toBe(false);
    expect(response.coverage.totals.runs).toBe(0);
    expect(readCumulative(response).runs).toBe(RUN_COUNT);
  });

  it('keeps counting a run the rollup recorded even when the live log is scanned alone', async () => {
    const runs = await seedCorpus();
    await recordRollup(runs);

    // `includeArchives: false` narrows the fold to the live log — the same
    // narrowing a prune produces, reached by a different route.
    const liveOnly = await readMetrics(workspaceRoot, { includeArchives: false }, silentLogger());

    expect(liveOnly.tasks).toHaveLength(RUN_COUNT - ARCHIVED_RUNS);
    expect(readCumulative(liveOnly).runs).toBe(RUN_COUNT);
    expect(liveOnly.coverage.detail.includesArchives).toBe(false);
  });
});
