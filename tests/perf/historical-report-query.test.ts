// FR-R6-F11 (T044; NFR-002, NFR-004, NFR-005; research R1, R9) — historical reports at 25,000
// roots and 100,000 attempts.
//
// The fixture is 25,000 roots of four attempts each, over two steps, one root a minute back from
// the cutoff, so every root is inside one 30-day range, in a file-backed store under the OS
// temp directory (quickstart section 3). Each measured query is `execution-summary`
// at the 200-row page bound: all 100,000 attempts captured and aggregated into 25,000 rows, 125
// pages. `attempt-detail` over the same range is pinned to end `limited` with `working-data`: its
// 100,000 rows on top of the captured population pass the shared 32 MiB budget (R11), and the cap
// is a visible outcome, never a shortened success (US4 scenario 3).
//
// Measured and printed:
//   - first-page reads (capture, aggregation and the first page), 3 warm-up and 20 measured;
//   - later-page reads, through the F03 sampler (20 warm-up, 200 measured);
//   - the capture, timed around the read pool call (research R1: one unsliced read);
//   - host work per scheduled slice, as the gaps between back-to-back `setImmediate` probes while
//     one report is built: each gap is the host work done between two yields, the capture included.
// Asserted: later-page p95 within 500 ms (NFR-002), cancellation acknowledged within 1 s (NFR-004),
// the deadline ending `limited` with `deadline-exceeded` and the work yielding more than once.
// First-page p95 (NFR-002) and slice p95 (NFR-005) are SHOULDs: recorded with their measured
// values, met or missed, and not asserted (spec: a missed target is recorded, not loosened).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SQLITE_BENCHMARK_MEASURED_SAMPLES,
  SQLITE_BENCHMARK_WARMUP_SAMPLES
} from '../../src/contracts/sqlite-store/schema-types';
import type { ReportResult } from '../../src/contracts/reporting/report-outcomes';
import type { ReportPage } from '../../src/contracts/reporting/report-rows';
import { createReportingService, type ReportingService } from '../../src/services/reporting/index';
import { NodeSqliteConnection, SchemaBootstrapService, measureOperationDistribution } from '../../src/services/sqlite-store';
import { seedAttempt, seedRun } from '../unit/reporting/report-fixture';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const DAY = 86_400_000;
const ROOT_COUNT = 25_000;
const ATTEMPTS_PER_ROOT = 4;
const PAGE_ROWS = 200;
const FIRST_PAGE_WARMUP = 3;
const FIRST_PAGE_MEASURED = 20;
const PAGE_P95_BUDGET_MS = 500;
const CANCEL_ACK_BUDGET_MS = 1_000;
const TEST_TIMEOUT_MS = 900_000;
const QUERY = Object.freeze({
  view: 'execution-summary',
  range: Object.freeze({ startMs: NOW - 30 * DAY, endMs: NOW }),
  pageSize: PAGE_ROWS
});

function seedFixture(conn: NodeSqliteConnection): void {
  conn.exec('BEGIN');
  for (let root = 0; root < ROOT_COUNT; root += 1) {
    const runId = `root-${String(root).padStart(5, '0')}`;
    const createdAtMs = NOW - (root + 1) * MINUTE;
    seedRun(conn, {
      runId,
      createdAtMs,
      workflowId: `wf-${String(root % 20)}`,
      frozenClosureId: `fz-${String(root % 7)}`,
      status: root % 10 === 0 ? 'failed' : 'succeeded',
      startedAtMs: createdAtMs,
      completedAtMs: createdAtMs + 30_000
    });
    for (let attempt = 0; attempt < ATTEMPTS_PER_ROOT; attempt += 1) {
      seedAttempt(conn, {
        attemptId: `${runId}-a${String(attempt)}`,
        runId,
        stepIndex: attempt % 2,
        attemptNumber: Math.floor(attempt / 2) + 1,
        startedAtMs: createdAtMs + attempt * 1_000,
        completedAtMs: createdAtMs + attempt * 1_000 + 500,
        exitCode: 0
      });
    }
  }
  conn.exec('COMMIT');
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted.at(Math.max(0, Math.ceil(fraction * sorted.length) - 1)) ?? Number.NaN;
}

function rounded(value: number): number {
  return Number(value.toFixed(2));
}

function pageOf(result: ReportResult<ReportPage>): ReportPage {
  if (!result.ok) throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  return result.value;
}

/** Records the gap between back-to-back `setImmediate` callbacks until `stop` is called. */
function probeGaps(): { readonly stop: () => readonly number[] } {
  const gaps: number[] = [];
  let last = performance.now();
  let running = true;
  const tick = (): void => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  return {
    stop: () => {
      running = false;
      return gaps;
    }
  };
}

describe('FR-R6-F11 historical reports at 25,000 roots and 100,000 attempts (NFR-002, NFR-004, NFR-005)', () => {
  let storeDir: string | undefined;

  afterAll(() => {
    if (storeDir !== undefined) fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it(
    'reads pages within 500 ms at p95, cancels within 1 s and ends at the deadline',
    async () => {
      storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-310-perf-'));
      const conn = new NodeSqliteConnection({ databasePath: path.join(storeDir, 'runs.sqlite') });
      SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
      const seedStarted = performance.now();
      seedFixture(conn);
      const seedMs = performance.now() - seedStarted;
      expect(Number(conn.scalar('SELECT count(*) FROM attempts'))).toBe(ROOT_COUNT * ATTEMPTS_PER_ROOT);

      const captureMs: number[] = [];
      const readPool = {
        withReadConnection: <T>(fallback: NodeSqliteConnection, read: (source: NodeSqliteConnection) => T): T => {
          const started = performance.now();
          try {
            return read(fallback);
          } finally {
            captureMs.push(performance.now() - started);
          }
        }
      };
      const serviceWith = (queryDeadlineMs?: number): ReportingService =>
        createReportingService({
          conn,
          readPool,
          workspaceId: 'ws-1',
          workspaceRoot: os.tmpdir(),
          nowMs: () => NOW,
          monotonicMs: () => performance.now(),
          hostTimezone: 'UTC',
          accounting: null,
          bounds: queryDeadlineMs === undefined ? {} : { queryDeadlineMs }
        });
      const service = serviceWith();

      const firstPageMs: number[] = [];
      for (let sample = 0; sample < FIRST_PAGE_WARMUP + FIRST_PAGE_MEASURED; sample += 1) {
        const started = performance.now();
        const page = pageOf(await service.runReport(QUERY));
        const elapsed = performance.now() - started;
        if (sample >= FIRST_PAGE_WARMUP) firstPageMs.push(elapsed);
        expect(page.rowCount).toBe(ROOT_COUNT);
        expect(service.closeReport({ reportId: page.reportId }).ok).toBe(true);
      }

      const probe = probeGaps();
      const probed = pageOf(await service.runReport(QUERY));
      const gaps = probe.stop();
      const probedCaptureMs = captureMs.at(-1) ?? Number.NaN;
      const probedBytes = service.resources().reservedBytes;
      const firstCursor = probed.cursor;
      if (firstCursor === null) throw new Error('expected more than one page');
      let cursor: string = firstCursor;
      let maxPageBytes = 0;
      const later = measureOperationDistribution({
        operationName: 'historical_report_later_page',
        warmupSamples: SQLITE_BENCHMARK_WARMUP_SAMPLES,
        measuredSamples: SQLITE_BENCHMARK_MEASURED_SAMPLES,
        step: () => {
          const page = pageOf(service.readPage({ cursor }));
          maxPageBytes = Math.max(maxPageBytes, Buffer.byteLength(JSON.stringify(page), 'utf8'));
          cursor = page.cursor ?? firstCursor;
        }
      });
      service.closeReport({ reportId: probed.reportId });

      const controller = new AbortController();
      let abortedAt = Number.NaN;
      setTimeout(() => {
        abortedAt = performance.now();
        controller.abort();
      }, 0);
      const cancelled = await service.runReport(QUERY, controller.signal);
      const cancelAckMs = performance.now() - abortedAt;

      const deadlined = await serviceWith(1).runReport(QUERY);
      const attemptDetail = await service.runReport({ ...QUERY, view: 'attempt-detail' });

      const slicedGaps = gaps.filter((gap) => gap < probedCaptureMs);
      const result = {
        platform: `${os.platform()}-${os.arch()}`,
        node: process.version,
        fixture: { roots: ROOT_COUNT, attempts: ROOT_COUNT * ATTEMPTS_PER_ROOT, pageRows: PAGE_ROWS },
        seed: { ms: Number(seedMs.toFixed(0)) },
        firstPage: { p50Ms: rounded(percentile(firstPageMs, 0.5)), p95Ms: rounded(percentile(firstPageMs, 0.95)), maxMs: rounded(Math.max(...firstPageMs)) },
        laterPage: { p50Ms: later.p50Ms, p95Ms: later.p95Ms, p99Ms: later.p99Ms, maxMs: later.maxMs, maxBytes: maxPageBytes },
        capture: { p50Ms: rounded(percentile(captureMs, 0.5)), maxMs: rounded(Math.max(...captureMs)) },
        workingData: { executionSummaryBytes: probedBytes },
        slices: {
          count: gaps.length,
          p95Ms: rounded(percentile(gaps, 0.95)),
          maxMs: rounded(Math.max(...gaps)),
          largestMs: [...gaps].sort((left, right) => right - left).slice(0, 4).map(rounded),
          slicedP95Ms: rounded(percentile(slicedGaps, 0.95))
        },
        cancel: { outcome: cancelled.ok ? 'complete' : cancelled.outcome, ackMs: rounded(cancelAckMs) },
        deadline: deadlined,
        attemptDetail
      };
      console.info(JSON.stringify(result));

      expect(later.failureCount).toBe(0);
      expect(later.p95Ms).toBeLessThanOrEqual(PAGE_P95_BUDGET_MS);
      expect(cancelled).toEqual({ ok: false, outcome: 'cancelled' });
      expect(cancelAckMs).toBeLessThanOrEqual(CANCEL_ACK_BUDGET_MS);
      expect(deadlined).toEqual({ ok: false, outcome: 'limited', limit: 'deadline-exceeded' });
      expect(attemptDetail).toEqual({ ok: false, outcome: 'limited', limit: 'working-data' });
      expect(service.resources()).toMatchObject({ executing: 0, waiting: 0, reservedBytes: 0, liveReports: 0 });
      expect(gaps.length).toBeGreaterThan(1);
      conn.close();
    },
    TEST_TIMEOUT_MS
  );
});
