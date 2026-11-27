// FR-R6-F11 T016 — the report engine: run, page, drill down, close (FR-003..FR-006, FR-010,
// FR-022; research R9, R11, R13).
//
// WHAT THIS PINS:
//   - `runReport` gives the first page and `readPage` pages to the end, in the view's order;
//   - rows inserted, updated or deleted mid-paging change nothing (SC-002);
//   - lease expiry answers `expired` with `restart-report-query` and releases the budget;
//   - `closeReport` releases the lease and the budget, once;
//   - admission: a second query waits for the slot, a full queue is `query-busy`, and a waiting
//     query cancelled by its signal leaves the queue;
//   - the working-data, lease, snapshot-row and deadline bounds end in their typed outcomes;
//   - a source read failure is `source-read-failed`, logged by code with no value;
//   - drill-down: the root, its attempts, the outcome lineage, the root's usage at the report's
//     revision, no path, and `unknown-root`;
//   - a zero-row report is `ok`, and the page byte bound stops a page early;
//   - progress events carry `{ phase, rowsDone, rowsTotal?, elapsedMs }`, and an aborted signal
//     ends `cancelled`;
//   - every operation refuses an input whose key set is not exact.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReportProgress, ReportResult } from '../../../src/contracts/reporting/report-outcomes';
import type { ReportPage, ReportRow } from '../../../src/contracts/reporting/report-rows';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import {
  type UsageAccountingService,
  createUsageAccountingService
} from '../../../src/services/usage-accounting/usage-accounting-service';
import {
  type ReportEngine,
  type ReportEngineBounds,
  createReportEngine
} from '../../../src/services/reporting/report-engine';
import type { AccountingPort } from '../../../src/services/reporting/report-usage';
import { measurePopulation } from '../../../src/services/reporting/report-snapshots';
import { createWorkSlicer } from '../../../src/services/reporting/work-slicer';
import { toUtcIso } from '../../../src/services/reporting/report-time';
import { FIXTURE_NOW, FIXTURE_WORKSPACE, seedAttempt, seedRun } from './report-fixture';

const HOUR = 3_600_000;
const LEASE_MS = 60_000;

let conn: NodeSqliteConnection;
let now = FIXTURE_NOW;
let warnings: { code: string; context: unknown; extra: number }[] = [];

beforeEach(() => {
  now = FIXTURE_NOW;
  warnings = [];
  conn = new NodeSqliteConnection({ databasePath: ':memory:' });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => FIXTURE_NOW);
});

afterEach(() => {
  conn.close();
});

function accountingService(): UsageAccountingService {
  return createUsageAccountingService({
    conn,
    nowUtc: () => toUtcIso(now),
    monotonicMs: () => 1,
    workspaceId: FIXTURE_WORKSPACE,
    bounds: {}
  });
}

interface EngineSetup {
  readonly accounting?: AccountingPort | null;
  readonly bounds?: ReportEngineBounds;
  readonly readSource?: <T>(read: (source: NodeSqliteConnection) => T) => T;
  readonly monotonicMs?: () => number;
}

function engineWith(setup: EngineSetup = {}): ReportEngine {
  return createReportEngine({
    readSource: setup.readSource ?? ((read) => read(conn)),
    workspaceId: FIXTURE_WORKSPACE,
    nowMs: () => now,
    monotonicMs: setup.monotonicMs ?? (() => 0),
    hostTimezone: 'UTC',
    accounting: setup.accounting === undefined ? accountingService() : setup.accounting,
    bounds: { leaseLifetimeMs: LEASE_MS, ...setup.bounds },
    logger: {
      warn: (code: string, context: unknown, ...rest: unknown[]) => {
        warnings.push({ code, context, extra: rest.length });
      }
    }
  });
}

/** Seeds `count` roots, one hour apart, newest last: r-1 .. r-count. */
function seedRoots(count: number): void {
  for (let index = 1; index <= count; index += 1) {
    seedRun(conn, { runId: `r-${String(index)}`, createdAtMs: FIXTURE_NOW - (count + 1 - index) * HOUR, frozenClosureId: 'fz-1' });
  }
}

function pageOf(result: ReportResult<ReportPage>): ReportPage {
  if (!result.ok) throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  return result.value;
}

function rootIds(rows: readonly ReportRow[]): string[] {
  return rows.map((row) => (row.kind === 'root' ? row.rootId : row.kind));
}

function drain(engine: ReportEngine, first: ReportPage): ReportRow[] {
  const rows = [...first.rows];
  let cursor = first.cursor;
  while (cursor !== null) {
    const next = pageOf(engine.readPage({ cursor }));
    rows.push(...next.rows);
    cursor = next.cursor;
  }
  return rows;
}

const SUMMARY = { view: 'execution-summary', pageSize: 2 } as const;

describe('FR-R6-F11 T016 — report engine: paging and the snapshot', () => {
  it('gives the first page, then pages to the end in the view order', async () => {
    seedRoots(5);
    const engine = engineWith();
    const first = pageOf(await engine.runReport(SUMMARY));
    expect(first.outcome).toBe('complete');
    expect(first.view).toBe('execution-summary');
    expect(first.rowCount).toBe(5);
    expect(first.rows).toHaveLength(2);
    expect(first.cursor).not.toBeNull();
    expect(first.sourceCutoffUtc).toBe(toUtcIso(FIXTURE_NOW));
    expect(first.timeBasis).toBe('root-created');
    expect(first.calculationVersion).toBe(1);
    expect(first.coverage).toMatchObject({ roots: 5, attempts: 0 });
    expect(first.reportId).toMatch(/^[0-9a-f]{32}$/);
    expect(rootIds(drain(engine, first))).toEqual(['r-5', 'r-4', 'r-3', 'r-2', 'r-1']);
  });

  it('keeps the snapshot when rows are inserted, updated or deleted mid-paging', async () => {
    seedRoots(5);
    const engine = engineWith();
    const expected = drain(engine, pageOf(await engine.runReport(SUMMARY)));
    const first = pageOf(await engine.runReport(SUMMARY));

    seedRun(conn, { runId: 'r-new', createdAtMs: FIXTURE_NOW - HOUR / 2 });
    conn.run(`UPDATE runs SET status = 'failed' WHERE run_id = 'r-2'`);
    conn.run(`DELETE FROM runs WHERE run_id = 'r-1'`);
    now += 1_000;

    expect(drain(engine, first)).toEqual(expected);
  });

  it('answers a zero-row report ok, with no cursor', async () => {
    const page = pageOf(await engineWith().runReport(SUMMARY));
    expect(page.rows).toEqual([]);
    expect(page.cursor).toBeNull();
    expect(page.rowCount).toBe(0);
  });

  it('stops a page early at the byte bound, always with at least one row', async () => {
    seedRoots(5);
    const engine = engineWith({ bounds: { maxPageBytes: 600 } });
    const first = pageOf(await engine.runReport({ view: 'execution-summary', pageSize: 50 }));
    expect(first.rows.length).toBeGreaterThanOrEqual(1);
    expect(first.rows.length).toBeLessThan(5);
    expect(first.cursor).not.toBeNull();
    expect(rootIds(drain(engine, first))).toEqual(['r-5', 'r-4', 'r-3', 'r-2', 'r-1']);

    const tiny = engineWith({ bounds: { maxPageBytes: 1 } });
    const single = pageOf(await tiny.runReport({ view: 'execution-summary', pageSize: 50 }));
    expect(single.rows).toHaveLength(1);
  });

  it('refuses a malformed cursor and an input whose key set is not exact', async () => {
    seedRoots(3);
    const engine = engineWith();
    const first = pageOf(await engine.runReport(SUMMARY));
    expect(engine.readPage({ cursor: 'not-a-cursor' })).toEqual({ ok: false, outcome: 'refused', reason: 'invalid-cursor' });
    const invalid = { ok: false, outcome: 'refused', reason: 'invalid-query' };
    expect(engine.readPage({})).toEqual(invalid);
    expect(engine.readPage({ cursor: first.cursor, extra: 1 })).toEqual(invalid);
    expect(engine.readPage(null)).toEqual(invalid);
    expect(engine.drillDown({ reportId: first.reportId })).toEqual(invalid);
    expect(engine.closeReport({ reportId: first.reportId, extra: true })).toEqual(invalid);
    expect(engine.closeReport({ reportId: 42 })).toEqual(invalid);
    expect(await engine.runReport({ view: 'execution-summary', bogus: 1 })).toEqual(invalid);
  });
});

describe('FR-R6-F11 T016 — report engine: lease, budget and admission', () => {
  it('answers expired after the lease lifetime and releases the budget', async () => {
    seedRoots(3);
    const engine = engineWith();
    const first = pageOf(await engine.runReport(SUMMARY));
    expect(engine.resources().liveReports).toBe(1);
    expect(engine.resources().reservedBytes).toBeGreaterThan(0);

    now += LEASE_MS + 1;
    const expired = { ok: false, outcome: 'expired', instruction: 'restart-report-query' };
    expect(engine.readPage({ cursor: first.cursor })).toEqual(expired);
    expect(engine.drillDown({ reportId: first.reportId, rootId: 'r-1' })).toEqual(expired);
    expect(engine.resources()).toMatchObject({ liveReports: 0, reservedBytes: 0 });
  });

  it('sweeps expired reports when a new report starts', async () => {
    seedRoots(3);
    const engine = engineWith({ bounds: { maxLeases: 1 } });
    pageOf(await engine.runReport(SUMMARY));
    now += LEASE_MS + 1;
    pageOf(await engine.runReport(SUMMARY));
    expect(engine.resources().liveReports).toBe(1);
  });

  it('releases the lease and the budget on close, once', async () => {
    seedRoots(3);
    const engine = engineWith();
    const first = pageOf(await engine.runReport(SUMMARY));
    expect(engine.closeReport({ reportId: first.reportId })).toEqual({ ok: true, value: { released: true } });
    expect(engine.resources()).toMatchObject({ liveReports: 0, reservedBytes: 0 });
    expect(engine.readPage({ cursor: first.cursor })).toEqual({ ok: false, outcome: 'expired', instruction: 'restart-report-query' });
    expect(engine.closeReport({ reportId: first.reportId })).toEqual({ ok: true, value: { released: false } });
  });

  it('hands an export the live report until its lease ends', async () => {
    seedRoots(3);
    const engine = engineWith();
    const first = pageOf(await engine.runReport(SUMMARY));
    const used = engine.useReport(first.reportId);
    expect(used.ok).toBe(true);
    expect(used.ok ? used.value.reportId : '').toBe(first.reportId);
    now += LEASE_MS + 1;
    expect(engine.useReport(first.reportId)).toEqual({ ok: false, outcome: 'expired', instruction: 'restart-report-query' });
  });

  it('refuses a report past the lease limit and keeps only the first reservation', async () => {
    seedRoots(3);
    const engine = engineWith({ bounds: { maxLeases: 1 } });
    pageOf(await engine.runReport(SUMMARY));
    const held = engine.resources().reservedBytes;
    expect(await engine.runReport(SUMMARY)).toEqual({ ok: false, outcome: 'refused', reason: 'report-lease-limit' });
    expect(engine.resources()).toMatchObject({ liveReports: 1, reservedBytes: held, executing: 0 });
  });

  it('ends limited when the working-data budget is too small, holding nothing', async () => {
    seedRoots(3);
    const engine = engineWith({ bounds: { workingDataBytes: 100 } });
    expect(await engine.runReport(SUMMARY)).toEqual({ ok: false, outcome: 'limited', limit: 'working-data' });
    expect(engine.resources()).toMatchObject({ liveReports: 0, reservedBytes: 0, executing: 0 });
  });

  it('reserves a run view\'s built rows on top of its population', async () => {
    seedRoots(3);
    const slicer = createWorkSlicer({ monotonicMs: () => 0, deadlineAtMs: Number.POSITIVE_INFINITY });
    const held = async (query: Parameters<ReportEngine['runReport']>[0]): Promise<{ reserved: number; rows: number }> => {
      const engine = engineWith();
      const rows = drain(engine, pageOf(await engine.runReport(query)));
      const measured = await measurePopulation([rows], slicer);
      if (!measured.ok) throw new Error('measure failed');
      return { reserved: engine.resources().reservedBytes, rows: measured.value.bytes };
    };
    const ungrouped = await held({ view: 'execution-summary' });
    const grouped = await held({ view: 'execution-summary', groupBy: ['outcome'] });
    expect(grouped.rows).not.toBe(ungrouped.rows);
    expect(grouped.reserved - ungrouped.reserved).toBe(grouped.rows - ungrouped.rows);
  });

  it('estimates working data from string values only: code units x 2 plus 64 bytes a row (R11)', async () => {
    const slicer = createWorkSlicer({ monotonicMs: () => 0, deadlineAtMs: Number.POSITIVE_INFINITY });
    const rows = [
      { attemptId: 'ab', attemptNumber: 12_345, nested: { phaseId: 'xyz', exitCode: null } },
      { rootId: '', startedAtMs: 1_800_000_000_000, tags: ['p', 'qr'] }
    ];
    const measured = await measurePopulation([rows], slicer);
    expect(measured.ok && measured.value.bytes).toBe((2 + 3) * 2 + 64 + (0 + 1 + 2) * 2 + 64);
  });

  it('ends limited when the population exceeds the snapshot cap', async () => {
    seedRoots(3);
    const engine = engineWith({ bounds: { snapshotCap: 2 } });
    expect(await engine.runReport(SUMMARY)).toEqual({ ok: false, outcome: 'limited', limit: 'snapshot-rows' });
    expect(engine.resources()).toMatchObject({ liveReports: 0, reservedBytes: 0, executing: 0 });
  });

  it('ends limited at the query deadline', async () => {
    seedRoots(3);
    let clock = 0;
    const engine = engineWith({ bounds: { queryDeadlineMs: 5 }, monotonicMs: () => (clock += 10) });
    expect(await engine.runReport(SUMMARY)).toEqual({ ok: false, outcome: 'limited', limit: 'deadline-exceeded' });
    expect(engine.resources()).toMatchObject({ reservedBytes: 0, executing: 0 });
  });

  it('queues a second query behind the slot and refuses one past the queue', async () => {
    seedRoots(3);
    const engine = engineWith({ bounds: { maxExecuting: 1, maxWaiting: 1 } });
    const first = engine.runReport(SUMMARY);
    const second = engine.runReport(SUMMARY);
    const third = engine.runReport(SUMMARY);
    expect(await third).toEqual({ ok: false, outcome: 'refused', reason: 'query-busy' });
    expect(pageOf(await first).rowCount).toBe(3);
    expect(pageOf(await second).rowCount).toBe(3);
    expect(engine.resources()).toMatchObject({ executing: 0, waiting: 0 });
  });

  it('removes a waiting query from the queue when its signal aborts', async () => {
    seedRoots(3);
    const engine = engineWith({ bounds: { maxExecuting: 1, maxWaiting: 1 } });
    const controller = new AbortController();
    const first = engine.runReport(SUMMARY);
    const waiting = engine.runReport(SUMMARY, controller.signal);
    controller.abort();
    expect(await waiting).toEqual({ ok: false, outcome: 'cancelled' });
    expect(pageOf(await first).rowCount).toBe(3);
    expect(engine.resources()).toMatchObject({ executing: 0, waiting: 0, liveReports: 1 });
  });

  it('fails source-read-failed when the source read throws, logging a code and no value', async () => {
    const engine = engineWith({
      readSource: () => {
        throw new Error('disk gone /secret/path');
      }
    });
    expect(await engine.runReport(SUMMARY)).toEqual({ ok: false, outcome: 'failed', reason: 'source-read-failed' });
    expect(warnings).toEqual([
      { code: 'reporting: source read failed', context: { operation: 'runReport', reason: 'source-read-failed' }, extra: 0 }
    ]);
    expect(engine.resources()).toMatchObject({ executing: 0, reservedBytes: 0 });
  });
});

describe('FR-R6-F11 T016 — report engine: progress and cancellation', () => {
  it('reports progress phases with counts and elapsed time', async () => {
    seedRoots(3);
    const events: ReportProgress[] = [];
    const page = pageOf(await engineWith().runReport(SUMMARY, undefined, (event) => events.push(event)));
    expect(page.rowCount).toBe(3);
    expect(events.map((event) => event.phase)).toEqual(['admitting', 'capturing', 'aggregating', 'aggregating']);
    for (const event of events) {
      expect(Object.keys(event).every((key) => ['phase', 'rowsDone', 'rowsTotal', 'elapsedMs'].includes(key))).toBe(true);
      expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(events.at(-1)).toEqual({ phase: 'aggregating', rowsDone: 3, rowsTotal: 3, elapsedMs: 0 });
  });

  it('ends cancelled on an aborted signal and holds nothing', async () => {
    seedRoots(3);
    const engine = engineWith();
    const controller = new AbortController();
    controller.abort();
    expect(await engine.runReport(SUMMARY, controller.signal)).toEqual({ ok: false, outcome: 'cancelled' });
    expect(engine.resources()).toMatchObject({ executing: 0, waiting: 0, reservedBytes: 0, liveReports: 0 });
  });
});

describe('FR-R6-F11 T016 — report engine: accounting and drill-down', () => {
  function seedUsage(accounting: UsageAccountingService): void {
    seedRun(conn, { runId: 'r-1', createdAtMs: FIXTURE_NOW - 2 * HOUR, frozenClosureId: 'fz-1', status: 'succeeded' });
    seedAttempt(conn, { attemptId: 'a-1', runId: 'r-1', stepIndex: 0, attemptNumber: 1, startedAtMs: FIXTURE_NOW - 2 * HOUR, status: 'failed', completedAtMs: FIXTURE_NOW - 2 * HOUR + 1_000 });
    seedAttempt(conn, { attemptId: 'a-2', runId: 'r-1', stepIndex: 0, attemptNumber: 2, startedAtMs: FIXTURE_NOW - HOUR, completedAtMs: FIXTURE_NOW - HOUR + 2_000 });
    seedRun(conn, { runId: 'r-2', createdAtMs: FIXTURE_NOW - HOUR, frozenClosureId: 'fz-1' });
    for (const [attemptId, rootId] of [['a-1', 'r-1'], ['a-2', 'r-1'], ['b-1', 'r-2']] as const) {
      const ingested = accounting.ingestObservation({
        producerNamespace: 'schegent.phase-end/1',
        source: 'phase-end',
        sourceKind: 'phase-end',
        sourceIdentity: `${attemptId}:0`,
        rootId,
        attemptId,
        invocationOrdinal: 0,
        counterScope: 'invocation-delta',
        adapterVersion: 'test/1',
        dimensions: { backend: 'claude', modelRequested: 'm-1', phaseId: 'implement' },
        eventUtc: toUtcIso(FIXTURE_NOW - HOUR),
        observedUtc: toUtcIso(FIXTURE_NOW - HOUR),
        measures: [{ measure: 'input_tokens', quantity: 4, unit: 'count', provenance: 'provider-reported' }]
      });
      if (!ingested.ok) throw new Error('fixture ingest failed');
    }
    for (const [attemptId, outcome] of [['a-1', 'failed'], ['a-2', 'succeeded']] as const) {
      if (!accounting.recordAttemptOutcome({ attemptId, outcome }).ok) throw new Error('fixture outcome failed');
    }
  }

  it('pins the accounting revision of a run view and drills into a root', async () => {
    const accounting = accountingService();
    seedUsage(accounting);
    const engine = engineWith({ accounting });
    const first = pageOf(await engine.runReport(SUMMARY));
    expect(first.accountingRevision).toEqual(expect.any(Number));
    expect(first.omissions).toEqual([]);

    const result = engine.drillDown({ reportId: first.reportId, rootId: 'r-1' });
    if (!result.ok) throw new Error('drill-down failed');
    const drill = result.value;
    expect(drill.reportId).toBe(first.reportId);
    expect(drill.root).toMatchObject({ kind: 'root', rootId: 'r-1', outcome: 'succeeded', attempts: 2 });
    expect(drill.attempts.map((row) => [row.attemptId, row.attemptNumber, row.status])).toEqual([
      ['a-1', 1, 'failed'],
      ['a-2', 2, 'succeeded']
    ]);
    expect(drill.frozenDefinitionId).toBe('fz-1');
    expect(drill.outcomeLineage).toEqual([
      { source: 'run-store', outcome: 'succeeded' },
      { source: 'accounting', outcome: 'failed' },
      { source: 'accounting', outcome: 'succeeded' }
    ]);
    expect(drill.usage).toEqual([
      expect.objectContaining({ kind: 'usage', key: { backend: 'claude', model: 'm-1' }, attempts: 2, roots: 1 })
    ]);
    expect(drill.omissions).toEqual([]);
    expect(JSON.stringify(drill)).not.toMatch(/[\\/]/);

    expect(engine.drillDown({ reportId: first.reportId, rootId: 'r-9' })).toEqual({ ok: false, outcome: 'refused', reason: 'unknown-root' });
    expect(engine.drillDown({ reportId: 'f'.repeat(32), rootId: 'r-1' })).toEqual({ ok: false, outcome: 'expired', instruction: 'restart-report-query' });
  });

  it('reserves the usage rows once, since they are the captured population (R8)', async () => {
    const accounting = accountingService();
    seedUsage(accounting);
    const engine = engineWith({ accounting });
    const first = pageOf(await engine.runReport({ view: 'usage', groupBy: ['backend', 'model'] }));
    const rows = drain(engine, first);
    const slicer = createWorkSlicer({ monotonicMs: () => 0, deadlineAtMs: Number.POSITIVE_INFINITY });
    const legacy = first.legacy === undefined ? [] : [first.legacy];
    const measured = await measurePopulation([rows, legacy], slicer);
    if (!measured.ok) throw new Error('measure failed');
    expect(rows.length).toBeGreaterThan(0);
    expect(engine.resources().reservedBytes).toBe(measured.value.bytes);
  });

  it('reads an accounting store with nothing committed (revision 0) as empty usage, never a failure', async () => {
    seedRoots(1);
    const accounting = accountingService();
    const engine = engineWith({ accounting });
    const usage = pageOf(await engine.runReport({ view: 'usage' }));
    expect(usage.accountingRevision).toBe(0);
    expect(usage.rowCount).toBe(0);
    expect(usage.coverage).toMatchObject({ roots: 0, attempts: 0 });

    const summary = pageOf(await engine.runReport(SUMMARY));
    expect(summary.accountingRevision).toBe(0);
    const result = engine.drillDown({ reportId: summary.reportId, rootId: 'r-1' });
    if (!result.ok) throw new Error(`drill-down failed: ${JSON.stringify(result)}`);
    expect(result.value.usage).toEqual([]);
    expect(result.value.outcomeLineage).toEqual([{ source: 'run-store', outcome: 'succeeded' }]);
  });

  it('notes the missing accounting store and drills down with no usage', async () => {
    seedRoots(2);
    const engine = engineWith({ accounting: null });
    const first = pageOf(await engine.runReport(SUMMARY));
    expect(first.accountingRevision).toBeNull();
    expect(first.omissions).toEqual([{ what: 'accountingRevision', reason: 'accounting-unavailable' }]);
    const result = engine.drillDown({ reportId: first.reportId, rootId: 'r-1' });
    if (!result.ok) throw new Error('drill-down failed');
    expect(result.value.usage).toBeNull();
    expect(result.value.outcomeLineage).toEqual([{ source: 'run-store', outcome: 'succeeded' }]);
    expect(result.value.omissions).toEqual([{ what: 'usage', reason: 'accounting-unavailable' }]);
  });

  it('runs the usage view over F06 at one revision, with its coverage', async () => {
    const accounting = accountingService();
    seedUsage(accounting);
    const page = pageOf(await engineWith({ accounting }).runReport({ view: 'usage' }));
    expect(page.timeBasis).toBe('accounting-event');
    expect(page.rows).toHaveLength(1);
    expect(page.rows.at(0)).toMatchObject({ kind: 'usage', key: { backend: 'claude', model: 'm-1' }, attempts: 3, roots: 2 });
    expect(page.coverage).toMatchObject({ roots: 2, attempts: 3, unknownDurations: 0, unattributed: 0 });
    expect(page.accountingRevision).toEqual(expect.any(Number));

    expect(await engineWith({ accounting: null }).runReport({ view: 'usage' })).toEqual({
      ok: false,
      outcome: 'refused',
      reason: 'accounting-unavailable'
    });
  });
});
