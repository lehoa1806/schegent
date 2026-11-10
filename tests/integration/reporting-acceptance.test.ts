// FR-R6-F11 T045 — historical reports and exports, the acceptance scenarios (quickstart section 2),
// end to end through the headless reporting port over a file-backed store and a real F06
// accounting service.
//
// The fixture is four roots in the day before the cutoff, plus one hostile root twenty days back
// that only its own range reads:
//   r-1  wf-a / fz-1  succeeded  60,000 ms   two attempts, 20,000 and 30,000 ms
//   r-2  wf-a / fz-1  failed    120,000 ms   one failed attempt, 100,000 ms; a free-text reason
//                                            naming a file in the workspace
//   r-3  wf-b / fz-2  running    unknown     one attempt still open
//   r-4  wf-b / fz-2  succeeded  30,000 ms   no attempts
// r-1 is created at 23:00 UTC on 2027-01-14, the others on 2027-01-15, so a UTC time series has
// two days and an Asia/Tokyo one has one.
//
// WHAT THIS PINS:
//   - AC-01: each view's values equal the hand-computed ones; nearest-rank percentiles, unknown
//     durations counted and never zero, usage measures equal F06's own answer;
//   - AC-02: paging while runs are inserted, updated and deleted gives the rows as of the cutoff,
//     each once; after the lease ends the answer is `expired` with `restart-report-query`;
//   - AC-03: a saved usage report whose revision was compacted reproduces as
//     `source-no-longer-reproducible` with `accounting-revision-unavailable`; the legacy summary
//     sits beside the rows; drill-down carries no path and no free-text reason;
//   - AC-04: two exports per format of one report are byte-identical; reproduce gives `reproduced`,
//     then `population-changed` after a correction, and a rerun carries `rerunOf`;
//   - AC-05: the CSV and JSON bytes of the hostile root are exact;
//   - AC-06: write failure, cancellation, a row cap and an existing destination leave no
//     complete-looking file and an unrelated file unchanged; reconciliation removes only owned
//     partials;
//   - AC-08: an untrusted workspace refuses export, save and delete, and still reads;
//   - AC-09: both capture statements use the migration 7 indexes, and no report operation that
//     only reads changes the store.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExportReceipt, SavedReportView } from '../../src/contracts/reporting/report-manifest';
import type { ReportResult } from '../../src/contracts/reporting/report-outcomes';
import type { GroupRow, ReportPage, ReportRow } from '../../src/contracts/reporting/report-rows';
import { createReportingApi, type ReportingApi } from '../../src/headless/reporting-api';
import { nodeExportFs, partialNames, type ExportFs } from '../../src/services/reporting/export-publisher';
import { EXPORT_STALE_AFTER_MS } from '../../src/services/reporting/export-reconciler';
import { ExportStore } from '../../src/services/reporting/export-store';
import {
  createReportingService,
  type ReportingService,
  type ReportingServiceBounds
} from '../../src/services/reporting/index';
import { toUtcIso } from '../../src/services/reporting/report-time';
import { CAPTURE_ATTEMPTS_SQL, CAPTURE_ROOTS_SQL } from '../../src/services/reporting/snapshot-capture';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../src/services/sqlite-store';
import type { AccountingMeasureInput } from '../../src/services/usage-accounting/observation-normalizer';
import {
  createUsageAccountingService,
  type UsageAccountingService
} from '../../src/services/usage-accounting/usage-accounting-service';
import { FIXTURE_NOW, FIXTURE_WORKSPACE, seedAttempt, seedRun } from '../unit/reporting/report-fixture';

const NOW = FIXTURE_NOW;
const SECOND = 1_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DAY_RANGE = Object.freeze({ startMs: NOW - DAY, endMs: NOW });
const HOSTILE_RANGE = Object.freeze({ startMs: NOW - 21 * DAY, endMs: NOW - 19 * DAY });
const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const HOSTILE_WORKFLOW = `=HYPERLINK("x")${BIDI_OVERRIDE}evil`;
const PRIVATE_FILE_NAME = 'private-notes.txt';
const EVENT_UTC = '2027-01-15T04:00:00.000Z';
/** 91 days after the events: past F06's 90-day retention horizon. */
const LATER_ACCOUNTING_UTC = toUtcIso(NOW + 91 * DAY);
const UNRELATED_TEXT = 'unrelated bytes\n';

let sandbox = '';
let workspaceRoot = '';
let outDir = '';
let conn: NodeSqliteConnection;
let now = NOW;
let accountingNow = toUtcIso(NOW);
let trusted = true;
let warnings: string[] = [];

beforeEach(() => {
  now = NOW;
  accountingNow = toUtcIso(NOW);
  trusted = true;
  warnings = [];
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-310-acceptance-')));
  workspaceRoot = path.join(sandbox, 'ws');
  outDir = path.join(sandbox, 'out');
  fs.mkdirSync(workspaceRoot);
  fs.mkdirSync(outDir);
  conn = new NodeSqliteConnection({ databasePath: path.join(sandbox, 'runs.sqlite') });
  SchemaBootstrapService.bootstrapAndMigrate(conn, () => NOW);
  seedFixture();
});

afterEach(() => {
  conn.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function seedFixture(): void {
  const r1 = NOW - 9 * HOUR;
  seedRun(conn, { runId: 'r-1', createdAtMs: r1, frozenClosureId: 'fz-1', startedAtMs: r1, completedAtMs: r1 + 60 * SECOND });
  seedAttempt(conn, { attemptId: 'r-1-a1', runId: 'r-1', stepIndex: 0, attemptNumber: 1, startedAtMs: r1, completedAtMs: r1 + 20 * SECOND, exitCode: 0 });
  seedAttempt(conn, {
    attemptId: 'r-1-a2',
    runId: 'r-1',
    stepIndex: 1,
    attemptNumber: 1,
    startedAtMs: r1 + 20 * SECOND,
    completedAtMs: r1 + 50 * SECOND,
    exitCode: 0
  });
  const r2 = NOW - 6 * HOUR;
  seedRun(conn, {
    runId: 'r-2',
    createdAtMs: r2,
    frozenClosureId: 'fz-1',
    status: 'failed',
    startedAtMs: r2,
    completedAtMs: r2 + 120 * SECOND,
    terminalReason: `could not read ${path.join(workspaceRoot, PRIVATE_FILE_NAME)}`
  });
  seedAttempt(conn, {
    attemptId: 'r-2-a1',
    runId: 'r-2',
    stepIndex: 0,
    attemptNumber: 1,
    startedAtMs: r2,
    completedAtMs: r2 + 100 * SECOND,
    status: 'failed',
    exitCode: 1
  });
  const r3 = NOW - 4 * HOUR;
  seedRun(conn, { runId: 'r-3', createdAtMs: r3, workflowId: 'wf-b', frozenClosureId: 'fz-2', status: 'running', startedAtMs: r3 });
  seedAttempt(conn, { attemptId: 'r-3-a1', runId: 'r-3', stepIndex: 0, attemptNumber: 1, startedAtMs: r3, status: 'running' });
  const r4 = NOW - 2 * HOUR;
  seedRun(conn, { runId: 'r-4', createdAtMs: r4, workflowId: 'wf-b', frozenClosureId: 'fz-2', startedAtMs: r4, completedAtMs: r4 + 30 * SECOND });
  seedRun(conn, { runId: 'r-h', createdAtMs: NOW - 20 * DAY, workflowId: HOSTILE_WORKFLOW });
}

function accountingService(): UsageAccountingService {
  return createUsageAccountingService({ conn, nowUtc: () => accountingNow, monotonicMs: () => 1, workspaceId: FIXTURE_WORKSPACE, bounds: {} });
}

interface ServiceSetup {
  readonly accounting?: UsageAccountingService | null;
  readonly bounds?: ReportingServiceBounds;
  readonly exportFs?: ExportFs;
}

function serviceWith(setup: ServiceSetup = {}): ReportingService {
  return createReportingService({
    conn,
    workspaceId: FIXTURE_WORKSPACE,
    workspaceRoot,
    nowMs: () => now,
    monotonicMs: () => 0,
    hostTimezone: 'UTC',
    accounting: setup.accounting ?? null,
    bounds: { leaseLifetimeMs: HOUR, ...setup.bounds },
    ...(setup.exportFs === undefined ? {} : { exportFs: setup.exportFs }),
    logger: { warn: (code) => warnings.push(code) }
  });
}

function apiWith(setup: ServiceSetup = {}): ReportingApi {
  return createReportingApi(serviceWith(setup), { isWorkspaceTrusted: () => trusted });
}

function valueOf<T>(result: ReportResult<T>): T {
  if (!result.ok) throw new Error(`expected a value, got ${JSON.stringify(result)}`);
  return result.value;
}

function groupsOf(page: ReportPage): GroupRow[] {
  return page.rows.filter((row): row is GroupRow => row.kind === 'group');
}

function ingest(accounting: UsageAccountingService, attemptId: string, rootId: string, backend: string, measures: readonly AccountingMeasureInput[], identity = `${attemptId}:0`): void {
  const result = accounting.ingestObservation({
    producerNamespace: 'schegent.phase-end/1',
    source: 'phase-end',
    sourceKind: 'phase-end',
    sourceIdentity: identity,
    rootId,
    attemptId,
    invocationOrdinal: 0,
    counterScope: 'invocation-delta',
    adapterVersion: 'test/1',
    dimensions: { backend, modelRequested: 'm-1', phaseId: 'implement' },
    eventUtc: EVENT_UTC,
    observedUtc: EVENT_UTC,
    measures
  });
  expect(result.ok).toBe(true);
}

function tokensAndCost(input: number, amount: string): AccountingMeasureInput[] {
  return [
    { measure: 'input_tokens', quantity: input, unit: 'count', provenance: 'provider-reported' },
    { measure: 'cost', quantity: amount, unit: 'USD', provenance: 'provider-reported' }
  ];
}

function drain(api: ReportingApi, first: ReportPage): ReportRow[] {
  const rows = [...first.rows];
  let cursor = first.cursor;
  while (cursor !== null) {
    const page = valueOf(api.readPage({ cursor }));
    rows.push(...page.rows);
    cursor = page.cursor;
  }
  return rows;
}

function exportTo(api: ReportingApi, reportId: string, format: 'json' | 'csv', fileName: string, signal?: AbortSignal): Promise<ReportResult<ExportReceipt>> {
  return api.exportReport(
    { reportId, format, destination: { scheme: 'file', fsPath: path.join(outDir, fileName) } },
    signal
  );
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function totalChanges(): number {
  return Number(conn.scalar('SELECT total_changes()'));
}

const DISTRIBUTION = { unit: 'ms', method: 'nearest-rank' } as const;

describe('FR-R6-F11 historical reports, acceptance (quickstart section 2)', () => {
  it('AC-01: execution-summary root rows, newest first, with unknown durations counted', async () => {
    const page = valueOf(await apiWith().runReport({ view: 'execution-summary', range: DAY_RANGE, timezone: 'UTC' }));
    expect(page.rows).toEqual([
      { kind: 'root', rootId: 'r-4', workflowId: 'wf-b', frozenDefinitionId: 'fz-2', outcome: 'succeeded', createdUtc: toUtcIso(NOW - 2 * HOUR), durationMs: 30_000, attempts: 0 },
      { kind: 'root', rootId: 'r-3', workflowId: 'wf-b', frozenDefinitionId: 'fz-2', outcome: 'running', createdUtc: toUtcIso(NOW - 4 * HOUR), durationMs: null, attempts: 1 },
      { kind: 'root', rootId: 'r-2', workflowId: 'wf-a', frozenDefinitionId: 'fz-1', outcome: 'failed', createdUtc: toUtcIso(NOW - 6 * HOUR), durationMs: 120_000, attempts: 1 },
      { kind: 'root', rootId: 'r-1', workflowId: 'wf-a', frozenDefinitionId: 'fz-1', outcome: 'succeeded', createdUtc: toUtcIso(NOW - 9 * HOUR), durationMs: 60_000, attempts: 2 }
    ]);
    expect(page).toMatchObject({ outcome: 'complete', rowCount: 4, cursor: null, sourceCutoffUtc: toUtcIso(NOW) });
    // One unknown root duration (r-3) and one unknown attempt duration (r-3-a1).
    expect(page.coverage).toMatchObject({ roots: 4, attempts: 4, unknownDurations: 2 });
  });

  it('AC-01: execution-summary by workflow, nearest-rank distributions over known samples', async () => {
    const page = valueOf(await apiWith().runReport({ view: 'execution-summary', range: DAY_RANGE, timezone: 'UTC', groupBy: ['workflowId'] }));
    const [wfA, wfB] = [groupsOf(page).at(0), groupsOf(page).at(1)];
    expect(groupsOf(page).map((row) => row.key)).toEqual([{ workflowId: 'wf-a' }, { workflowId: 'wf-b' }]);
    expect(wfA).toMatchObject({
      roots: 2,
      attempts: 3,
      outcomes: { queued: 0, running: 0, paused: 0, succeeded: 1, failed: 1, cancelled: 0, aborted: 0 },
      rootDuration: { ...DISTRIBUTION, samples: 2, known: 2, missing: 0, p50: 60_000, p90: 120_000, p99: 120_000 }
    });
    expect(wfB).toMatchObject({
      roots: 2,
      attempts: 1,
      outcomes: { queued: 0, running: 1, paused: 0, succeeded: 1, failed: 0, cancelled: 0, aborted: 0 },
      rootDuration: { ...DISTRIBUTION, samples: 2, known: 1, missing: 1, p50: 30_000, p90: 30_000, p99: 30_000 }
    });
  });

  it('AC-01: workflow-revision attempt durations, and unavailable with no known sample', async () => {
    const page = valueOf(await apiWith().runReport({ view: 'workflow-revision', range: DAY_RANGE, timezone: 'UTC' }));
    expect(groupsOf(page).map((row) => row.key)).toEqual([
      { workflowId: 'wf-a', frozenDefinitionId: 'fz-1' },
      { workflowId: 'wf-b', frozenDefinitionId: 'fz-2' }
    ]);
    // wf-a attempts: 20,000, 30,000 and 100,000 ms. wf-b: one open attempt, nothing known.
    expect(groupsOf(page).at(0)?.attemptDuration).toMatchObject({ ...DISTRIBUTION, samples: 3, known: 3, missing: 0, p50: 30_000, p90: 100_000, p99: 100_000 });
    expect(groupsOf(page).at(1)?.attemptDuration).toMatchObject({
      ...DISTRIBUTION,
      samples: 1,
      known: 0,
      missing: 1,
      p50: 'unavailable',
      p90: 'unavailable',
      p99: 'unavailable'
    });
  });

  it('AC-01: failure-cause maps a free-text reason to other and never carries its text', async () => {
    const page = valueOf(await apiWith().runReport({ view: 'failure-cause', range: DAY_RANGE, timezone: 'UTC' }));
    expect(groupsOf(page).map((row) => [row.key, row.roots, row.attempts])).toEqual([[{ failureCause: 'other' }, 1, 1]]);
    const text = JSON.stringify(page);
    expect(text).not.toContain(PRIVATE_FILE_NAME);
    expect(text).not.toContain(sandbox);
  });

  it('AC-01: time-series days follow the report timezone', async () => {
    const api = apiWith();
    const utc = valueOf(await api.runReport({ view: 'time-series', range: DAY_RANGE, timezone: 'UTC' }));
    expect(groupsOf(utc).map((row) => [row.key, row.roots])).toEqual([
      [{ localDay: '2027-01-14' }, 1],
      [{ localDay: '2027-01-15' }, 3]
    ]);
    const tokyo = valueOf(await api.runReport({ view: 'time-series', range: DAY_RANGE, timezone: 'Asia/Tokyo' }));
    expect(groupsOf(tokyo).map((row) => [row.key, row.roots])).toEqual([[{ localDay: '2027-01-15' }, 4]]);
  });

  it('AC-01: usage rows carry the measures F06 itself answers, at one revision', async () => {
    const accounting = accountingService();
    ingest(accounting, 'r-1-a1', 'r-1', 'claude', tokensAndCost(100, '0.25'));
    ingest(accounting, 'r-1-a2', 'r-1', 'claude', tokensAndCost(40, '0.10'));
    ingest(accounting, 'r-2-a1', 'r-2', 'codex', tokensAndCost(7, '0.05'));
    const page = valueOf(await apiWith({ accounting }).runReport({ view: 'usage', range: DAY_RANGE, timezone: 'UTC' }));
    const direct = accounting.query({ groupBy: ['backend', 'model'], from: toUtcIso(DAY_RANGE.startMs), to: toUtcIso(DAY_RANGE.endMs), limit: 100 });
    if (!direct.ok) throw new Error('F06 query failed');
    expect(page.accountingRevision).toBe(direct.value.revision);
    const usage = page.rows.filter((row) => row.kind === 'usage');
    expect(usage.map((row) => [row.key, row.attempts, row.roots, row.invocations])).toEqual([
      [{ backend: 'claude', model: 'm-1' }, 2, 1, 'not-recorded'],
      [{ backend: 'codex', model: 'm-1' }, 1, 1, 'not-recorded']
    ]);
    for (const row of usage) {
      const own = direct.value.rows.find((candidate) => JSON.stringify(candidate.key) === JSON.stringify(row.key));
      expect(row.measures).toEqual(own?.measures);
    }
    const claudeInput = usage.at(0)?.measures.find((measure) => measure.measure === 'input_tokens');
    expect(claudeInput?.total).toBe('140');
  });

  it('AC-02: paging while the store changes gives the rows as of the cutoff, then expires', async () => {
    const api = apiWith();
    const query = { view: 'execution-summary', range: DAY_RANGE, timezone: 'UTC', pageSize: 1 };
    const before = drain(api, valueOf(await api.runReport(query)));
    const first = valueOf(await api.runReport(query));
    seedRun(conn, { runId: 'r-5', createdAtMs: NOW - HOUR, startedAtMs: NOW - HOUR, completedAtMs: NOW - HOUR + SECOND });
    conn.run(`UPDATE runs SET status = 'succeeded' WHERE run_id = 'r-2'`);
    conn.run(`DELETE FROM runs WHERE run_id = 'r-4'`);
    const during = drain(api, first);
    expect(during).toEqual(before);
    expect(during.map((row) => (row.kind === 'root' ? row.rootId : row.kind))).toEqual(['r-4', 'r-3', 'r-2', 'r-1']);
    const fresh = drain(api, valueOf(await api.runReport(query)));
    expect(fresh.map((row) => (row.kind === 'root' ? `${row.rootId}:${row.outcome}` : row.kind))).toEqual([
      'r-5:succeeded',
      'r-3:running',
      'r-2:succeeded',
      'r-1:succeeded'
    ]);
    const cursor = first.cursor;
    if (cursor === null) throw new Error('expected a second page');
    now += 2 * HOUR;
    expect(api.readPage({ cursor })).toEqual({ ok: false, outcome: 'expired', instruction: 'restart-report-query' });
    expect(api.drillDown({ reportId: first.reportId, rootId: 'r-1' })).toEqual({
      ok: false,
      outcome: 'expired',
      instruction: 'restart-report-query'
    });
  });

  it('AC-03: a saved usage report at a compacted revision is no longer reproducible', async () => {
    const accounting = accountingService();
    ingest(accounting, 'r-1-a1', 'r-1', 'claude', [{ measure: 'cost', quantity: '0.50', unit: 'USD', provenance: 'estimated', pricingVersion: 'pricing-2027-01' }], 'r-1-a1:estimate');
    const api = apiWith({ accounting });
    const page = valueOf(await api.runReport({ view: 'usage', range: DAY_RANGE, timezone: 'UTC' }));
    const saved = valueOf(api.saveReport({ reportId: page.reportId }));
    expect(valueOf(await api.reproduceSavedReport({ reportId: saved.reportId }))).toEqual({ verdict: 'reproduced' });
    ingest(accounting, 'r-1-a1', 'r-1', 'claude', [{ measure: 'cost', quantity: '0.20', unit: 'USD', provenance: 'provider-reported' }], 'r-1-a1:actual');
    accountingNow = LATER_ACCOUNTING_UTC;
    expect(accounting.pruneExpired().ok).toBe(true);
    expect(await api.reproduceSavedReport({ reportId: saved.reportId })).toEqual({
      ok: true,
      value: { verdict: 'source-no-longer-reproducible', reason: 'accounting-revision-unavailable' }
    });
  });

  it('AC-03: the legacy summary sits beside the usage rows, never in them', async () => {
    const accounting = accountingService();
    ingest(accounting, 'r-1-a1', 'r-1', 'claude', tokensAndCost(100, '0.25'));
    conn.run(
      `INSERT OR REPLACE INTO accounting_legacy_epoch (epoch_id, state, imported_runs, legacy_cost_micros, started_utc)
       VALUES (1, 'complete', 3, 1250000, ?)`,
      toUtcIso(NOW)
    );
    const page = valueOf(await apiWith({ accounting }).runReport({ view: 'usage', range: DAY_RANGE, timezone: 'UTC' }));
    expect(page.legacy).toEqual({ runCount: 3, costMicros: '1250000', detail: 'unavailable' });
    expect(page.rows.map((row) => (row.kind === 'usage' ? [row.attempts, row.roots] : row.kind))).toEqual([[1, 1]]);
  });

  it('AC-03: drill-down carries the root and its attempts, and no path or free-text reason', async () => {
    const api = apiWith();
    const page = valueOf(await api.runReport({ view: 'execution-summary', range: DAY_RANGE, timezone: 'UTC' }));
    const drill = valueOf(api.drillDown({ reportId: page.reportId, rootId: 'r-2' }));
    expect(drill.root).toMatchObject({ rootId: 'r-2', outcome: 'failed', durationMs: 120_000 });
    expect(drill.frozenDefinitionId).toBe('fz-1');
    expect(drill.attempts.map((attempt) => [attempt.attemptId, attempt.status, attempt.exitCode, attempt.durationMs])).toEqual([
      ['r-2-a1', 'failed', 1, 100_000]
    ]);
    const text = JSON.stringify(drill);
    expect(text).not.toContain(PRIVATE_FILE_NAME);
    expect(text).not.toContain(sandbox);
  });

  it('AC-04: two exports per format of one report are byte-identical', async () => {
    const api = apiWith();
    const page = valueOf(await api.runReport({ view: 'execution-summary', range: DAY_RANGE, timezone: 'UTC', groupBy: ['outcome'] }));
    for (const format of ['json', 'csv'] as const) {
      const first = valueOf(await exportTo(api, page.reportId, format, `first.${format}`));
      const second = valueOf(await exportTo(api, page.reportId, format, `second.${format}`));
      const firstBytes = fs.readFileSync(path.join(outDir, `first.${format}`));
      const secondBytes = fs.readFileSync(path.join(outDir, `second.${format}`));
      expect(firstBytes.equals(secondBytes)).toBe(true);
      expect(first.sha256).toBe(sha256Of(firstBytes));
      expect(second.sha256).toBe(first.sha256);
      expect(first.exportId).not.toBe(second.exportId);
      const manifest = JSON.parse(fs.readFileSync(path.join(outDir, first.manifestFileName), 'utf8')) as { data?: { sha256: string } };
      expect(manifest.data?.sha256).toBe(first.sha256);
    }
  });

  it('AC-04: save and reproduce, then a correction is a population change, and a rerun sees it', async () => {
    const api = apiWith();
    const page = valueOf(await api.runReport({ view: 'execution-summary', range: DAY_RANGE, timezone: 'UTC', groupBy: ['outcome'] }));
    expect(groupsOf(page).map((row) => [row.key, row.roots])).toEqual([
      [{ outcome: 'failed' }, 1],
      [{ outcome: 'running' }, 1],
      [{ outcome: 'succeeded' }, 2]
    ]);
    const saved: SavedReportView = valueOf(api.saveReport({ reportId: page.reportId }));
    expect(valueOf(await api.reproduceSavedReport({ reportId: saved.reportId }))).toEqual({ verdict: 'reproduced' });
    conn.run(`UPDATE runs SET status = 'succeeded', terminal_reason = NULL WHERE run_id = 'r-2'`);
    expect(valueOf(await api.reproduceSavedReport({ reportId: saved.reportId }))).toEqual({
      verdict: 'source-no-longer-reproducible',
      reason: 'population-changed'
    });
    const rerun = valueOf(await api.rerunSavedReport({ reportId: saved.reportId }));
    expect(rerun.rerunOf).toBe(saved.reportId);
    expect(groupsOf(rerun).map((row) => [row.key, row.roots])).toEqual([
      [{ outcome: 'running' }, 1],
      [{ outcome: 'succeeded' }, 3]
    ]);
  });

  it('AC-05: the hostile root exports to exact CSV and JSON bytes', async () => {
    const api = apiWith();
    const page = valueOf(await api.runReport({ view: 'execution-summary', range: HOSTILE_RANGE, timezone: 'UTC' }));
    const createdUtc = '2026-12-26T08:00:00.000Z';
    expect(toUtcIso(NOW - 20 * DAY)).toBe(createdUtc);
    const csv = valueOf(await exportTo(api, page.reportId, 'csv', 'hostile.csv'));
    expect(fs.readFileSync(path.join(outDir, 'hostile.csv'), 'utf8')).toBe(
      '"text:kind","text:rootId","text:workflowId","text:frozenDefinitionId","text:outcome","text:createdUtc","text:durationMs","text:attempts"\r\n' +
        `"text:root","text:r-h","text:=HYPERLINK(""x"")\\u{202E}evil","","text:succeeded","text:${createdUtc}","","0"\r\n`
    );
    expect(csv.manifest.transformations).toEqual([
      { name: 'text-prefix', count: 8 + 5 },
      { name: 'control-escaped', count: 1 },
      { name: 'truncated', count: 0 },
      { name: 'number-prefixed', count: 0 }
    ]);
    valueOf(await exportTo(api, page.reportId, 'json', 'hostile.json'));
    const expectedJson = `${JSON.stringify({
      schema: 'schegent.report-data',
      schemaVersion: 1,
      reportId: page.reportId,
      view: 'execution-summary',
      calculationVersion: 1,
      columns: ['kind', 'rootId', 'workflowId', 'frozenDefinitionId', 'outcome', 'createdUtc', 'durationMs', 'attempts'],
      rows: [
        { kind: 'root', rootId: 'r-h', workflowId: HOSTILE_WORKFLOW, frozenDefinitionId: null, outcome: 'succeeded', createdUtc, durationMs: null, attempts: 0 }
      ]
    })}\n`;
    const jsonText = fs.readFileSync(path.join(outDir, 'hostile.json'), 'utf8');
    expect(jsonText).toBe(expectedJson);
    expect(jsonText).toContain(BIDI_OVERRIDE);
  });

  it('AC-06: failed, cancelled, capped and refused exports leave no file and an unrelated file unchanged', async () => {
    const unrelated = path.join(outDir, 'notes.txt');
    fs.writeFileSync(unrelated, UNRELATED_TEXT);
    const existing = path.join(outDir, 'existing.csv');
    fs.writeFileSync(existing, UNRELATED_TEXT);
    const query = { view: 'execution-summary', range: DAY_RANGE, timezone: 'UTC' };

    const failing = apiWith({ exportFs: { ...nodeExportFs, open: () => Promise.resolve(null) } });
    const failingPage = valueOf(await failing.runReport(query));
    expect(await exportTo(failing, failingPage.reportId, 'csv', 'failed.csv')).toEqual({ ok: false, outcome: 'failed', reason: 'write-failed' });

    const api = apiWith();
    const page = valueOf(await api.runReport(query));
    const controller = new AbortController();
    controller.abort();
    expect(await exportTo(api, page.reportId, 'json', 'cancelled.json', controller.signal)).toEqual({ ok: false, outcome: 'cancelled' });
    expect(await exportTo(api, page.reportId, 'csv', 'existing.csv')).toEqual({ ok: false, outcome: 'refused', reason: 'destination-exists' });

    const capped = apiWith({ bounds: { exportCaps: { maxRows: 1 } } });
    const cappedPage = valueOf(await capped.runReport(query));
    expect(await exportTo(capped, cappedPage.reportId, 'csv', 'capped.csv')).toEqual({ ok: false, outcome: 'limited', limit: 'export-rows' });

    expect(
      await api.exportReport({
        reportId: page.reportId,
        format: 'csv',
        destination: { scheme: 'file', fsPath: path.join(workspaceRoot, '.schegent', 'report.csv') }
      })
    ).toEqual({ ok: false, outcome: 'refused', reason: 'destination-in-evidence-store' });
    expect(
      await api.exportReport({
        reportId: page.reportId,
        format: 'csv',
        destination: { scheme: 'untitled', fsPath: path.join(outDir, 'remote.csv') }
      })
    ).toEqual({ ok: false, outcome: 'refused', reason: 'destination-not-local-file' });

    expect(fs.readdirSync(outDir).sort()).toEqual(['existing.csv', 'notes.txt']);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe(UNRELATED_TEXT);
    expect(fs.readFileSync(existing, 'utf8')).toBe(UNRELATED_TEXT);
    expect(fs.existsSync(path.join(workspaceRoot, '.schegent'))).toBe(false);
  });

  it('AC-06: reconciliation ends a stale export host-stopped and removes only its own partials', async () => {
    const exportId = 'c'.repeat(32);
    const names = partialNames('report.csv', exportId);
    const store = new ExportStore(conn);
    store.insertPending({
      exportId,
      workspaceId: FIXTURE_WORKSPACE,
      reportId: 'a'.repeat(32),
      format: 'csv',
      stagingDir: outDir,
      finalName: 'report.csv',
      dataPartialName: names.data,
      manifestPartialName: names.manifest,
      overwrite: false,
      createdMs: NOW - EXPORT_STALE_AFTER_MS - 1
    });
    const lookalike = partialNames('report.csv', 'd'.repeat(32)).data;
    for (const name of [names.data, names.manifest, lookalike, 'notes.txt']) fs.writeFileSync(path.join(outDir, name), UNRELATED_TEXT);
    expect(await apiWith().reconcileExports({})).toEqual({ ok: true, value: { reconciled: 1 } });
    expect(fs.readdirSync(outDir).sort()).toEqual([lookalike, 'notes.txt'].sort());
    expect(store.get(exportId)).toMatchObject({ state: 'failed', reason: 'host-stopped' });
  });

  it('AC-08: an untrusted workspace refuses export, save, delete and reconciliation, and still reads', async () => {
    const api = apiWith();
    const page = valueOf(await api.runReport({ view: 'execution-summary', range: DAY_RANGE, timezone: 'UTC', pageSize: 2 }));
    const saved = valueOf(api.saveReport({ reportId: page.reportId }));
    trusted = false;
    const untrusted = { ok: false, outcome: 'refused', reason: 'workspace-untrusted' };
    expect(await exportTo(api, page.reportId, 'csv', 'untrusted.csv')).toEqual(untrusted);
    expect(api.saveReport({ reportId: page.reportId })).toEqual(untrusted);
    expect(api.deleteSavedReport({ reportId: saved.reportId })).toEqual(untrusted);
    expect(await api.reconcileExports({})).toEqual(untrusted);
    const cursor = page.cursor;
    if (cursor === null) throw new Error('expected a second page');
    expect(valueOf(api.readPage({ cursor })).rows).toHaveLength(2);
    expect(valueOf(api.drillDown({ reportId: page.reportId, rootId: 'r-1' })).root.rootId).toBe('r-1');
    expect(valueOf(api.listSavedReports({})).items.map((report) => report.reportId)).toEqual([saved.reportId]);
    expect(valueOf(await api.reproduceSavedReport({ reportId: saved.reportId }))).toEqual({ verdict: 'reproduced' });
    expect(fs.readdirSync(outDir)).toEqual([]);
    expect(await api.runReport({ view: 'execution-summary', pageSize: 201 })).toEqual({ ok: false, outcome: 'refused', reason: 'invalid-query' });
    expect(await api.runReport({ view: 'execution-summary', range: { startMs: NOW - 91 * DAY, endMs: NOW } })).toEqual({
      ok: false,
      outcome: 'refused',
      reason: 'invalid-query'
    });
  });

  it('AC-09: both capture statements use the migration 7 indexes', () => {
    const plan = (sql: string): string =>
      conn
        .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, FIXTURE_WORKSPACE, DAY_RANGE.startMs, DAY_RANGE.endMs, 100)
        .map((row) => row.detail)
        .join('\n');
    expect(plan(CAPTURE_ROOTS_SQL)).toContain('idx_runs_workspace_created');
    const attempts = plan(CAPTURE_ATTEMPTS_SQL);
    expect(attempts).toContain('idx_runs_workspace_created');
    expect(attempts).toContain('idx_attempts_run');
  });

  it('AC-09: report reads change nothing in the store, and the lease bound refuses a third report', async () => {
    const api = apiWith({ bounds: { maxLeases: 2 } });
    const query = { view: 'execution-summary', range: DAY_RANGE, timezone: 'UTC', pageSize: 1 };
    const before = totalChanges();
    const first = valueOf(await api.runReport(query));
    const second = valueOf(await api.runReport({ ...query, view: 'time-series' }));
    const cursor = first.cursor;
    if (cursor === null) throw new Error('expected a second page');
    valueOf(api.readPage({ cursor }));
    valueOf(api.drillDown({ reportId: first.reportId, rootId: 'r-3' }));
    expect(await api.runReport(query)).toEqual({ ok: false, outcome: 'refused', reason: 'report-lease-limit' });
    valueOf(api.closeReport({ reportId: second.reportId }));
    expect(totalChanges()).toBe(before);
    expect(warnings).toEqual([]);
  });
});
