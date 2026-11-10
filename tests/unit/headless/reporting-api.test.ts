// FR-R6-F11 T042 (FR-016, FR-021, FR-022; contracts/reporting.md sections 1, 2 and 7) — the
// headless reporting port.
//
// WHAT THIS PINS:
//   - every operation checks its exact key set and primitive types before the service sees it, and
//     refuses `invalid-query` otherwise;
//   - an untrusted workspace is refused `workspace-untrusted` for export, save and delete, while
//     every read still reaches the service;
//   - no operation starts, resumes or changes an execution: the run, step and attempt rows are equal
//     before and after every operation over a real service;
//   - the logger receives a fixed code and `{ operation, reason }` only: no filter value, no path.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reportCancelled, type ReportResult } from '../../../src/contracts/reporting/report-outcomes';
import type { ReportPage } from '../../../src/contracts/reporting/report-rows';
import { createReportingApi, type ReportingApi } from '../../../src/headless/reporting-api';
import { createReportingService, type ReportingService } from '../../../src/services/reporting/index';
import { nodeExportFs, partialNames } from '../../../src/services/reporting/export-publisher';
import { EXPORT_STALE_AFTER_MS } from '../../../src/services/reporting/export-reconciler';
import { ExportStore } from '../../../src/services/reporting/export-store';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import { FIXTURE_NOW, FIXTURE_WORKSPACE, seedAttempt, seedRun } from '../reporting/report-fixture';

const HOUR = 3_600_000;
const REPORT_ID = 'a'.repeat(32);
const SENTINEL = reportCancelled();
const SECRET_FILTER = 'secret-workflow-label';
const STALE_EXPORT_ID = 'e'.repeat(32);

interface Call {
  readonly op: string;
  readonly input: unknown;
}

/** A service that records each call and answers a sentinel, so delegation is observable. */
function spyService(calls: Call[]): ReportingService {
  const record = (op: string, input: unknown): typeof SENTINEL => {
    calls.push({ op, input });
    return SENTINEL;
  };
  return {
    runReport: (input) => Promise.resolve(record('runReport', input)),
    readPage: (input) => record('readPage', input),
    drillDown: (input) => record('drillDown', input),
    closeReport: (input) => record('closeReport', input),
    exportReport: (input) => Promise.resolve(record('exportReport', input)),
    saveReport: (input) => record('saveReport', input),
    listSavedReports: (input) => record('listSavedReports', input),
    rerunSavedReport: (input) => Promise.resolve(record('rerunSavedReport', input)),
    reproduceSavedReport: (input) => Promise.resolve(record('reproduceSavedReport', input)),
    deleteSavedReport: (input) => record('deleteSavedReport', input),
    reconcileExports: () => Promise.resolve(record('reconcileExports', {})),
    resources: () => ({ executing: 0, waiting: 0, reservedBytes: 0, liveReports: 0 })
  } as ReportingService;
}

const VALID_EXPORT = Object.freeze({
  reportId: REPORT_ID,
  format: 'csv',
  destination: Object.freeze({ scheme: 'file', fsPath: '/x/report.csv' })
});

type Invoke = (api: ReportingApi, input: unknown) => Promise<unknown>;

const OPERATIONS: readonly (readonly [string, Invoke, unknown])[] = [
  ['runReport', (api, input) => api.runReport(input), { view: 'execution-summary', pageSize: 10 }],
  ['readPage', async (api, input) => api.readPage(input), { cursor: 'c' }],
  ['drillDown', async (api, input) => api.drillDown(input), { reportId: REPORT_ID, rootId: 'r-1' }],
  ['closeReport', async (api, input) => api.closeReport(input), { reportId: REPORT_ID }],
  ['exportReport', (api, input) => api.exportReport(input), VALID_EXPORT],
  ['saveReport', async (api, input) => api.saveReport(input), { reportId: REPORT_ID }],
  ['listSavedReports', async (api, input) => api.listSavedReports(input), { limit: 5 }],
  ['rerunSavedReport', (api, input) => api.rerunSavedReport(input), { reportId: REPORT_ID }],
  ['reproduceSavedReport', (api, input) => api.reproduceSavedReport(input), { reportId: REPORT_ID }],
  ['deleteSavedReport', async (api, input) => api.deleteSavedReport(input), { reportId: REPORT_ID }],
  ['reconcileExports', (api, input) => api.reconcileExports(input), {}]
];

const MALFORMED: readonly (readonly [string, unknown])[] = [
  ['runReport', { view: 'execution-summary', extra: 1 }],
  ['runReport', { view: 7 }],
  ['runReport', null],
  ['readPage', { cursor: 1 }],
  ['readPage', { cursor: 'c', extra: true }],
  ['drillDown', { reportId: REPORT_ID }],
  ['drillDown', { reportId: REPORT_ID, rootId: 3 }],
  ['closeReport', { reportId: [REPORT_ID] }],
  ['closeReport', []],
  ['exportReport', { ...VALID_EXPORT, format: 'xlsx' }],
  ['exportReport', { ...VALID_EXPORT, overwrite: 'yes' }],
  ['exportReport', { ...VALID_EXPORT, workspaceRoot: '/x/ws' }],
  ['exportReport', { ...VALID_EXPORT, destination: { scheme: 'file' } }],
  ['exportReport', { ...VALID_EXPORT, destination: { scheme: 'file', fsPath: '/x', query: 'q' } }],
  ['exportReport', { reportId: REPORT_ID, format: 'json' }],
  ['saveReport', { reportId: REPORT_ID, name: 'n' }],
  ['listSavedReports', { limit: '5' }],
  ['listSavedReports', { page: 1 }],
  ['rerunSavedReport', {}],
  ['reproduceSavedReport', 'id'],
  ['deleteSavedReport', undefined],
  ['reconcileExports', { force: true }]
];

function operation(name: string): Invoke {
  const found = OPERATIONS.find(([op]) => op === name);
  if (found === undefined) throw new Error(`no operation ${name}`);
  return found[1];
}

describe('FR-R6-F11 T042 — headless validation before delegation', () => {
  it.each(MALFORMED)('refuses a malformed %s input without calling the service', async (name, input) => {
    const calls: Call[] = [];
    const api = createReportingApi(spyService(calls), { isWorkspaceTrusted: () => true });
    expect(await operation(name)(api, input)).toEqual({ ok: false, outcome: 'refused', reason: 'invalid-query' });
    expect(calls).toHaveLength(0);
  });

  it.each(OPERATIONS)('delegates a well-formed %s input once, unchanged', async (name, invoke, input) => {
    const calls: Call[] = [];
    const api = createReportingApi(spyService(calls), { isWorkspaceTrusted: () => true });
    expect(await invoke(api, input)).toBe(SENTINEL);
    expect(calls).toEqual([{ op: name, input }]);
  });

  it('accepts an export that names overwrite as a boolean', async () => {
    const calls: Call[] = [];
    const api = createReportingApi(spyService(calls), { isWorkspaceTrusted: () => true });
    expect(await api.exportReport({ ...VALID_EXPORT, overwrite: true })).toBe(SENTINEL);
    expect(calls).toHaveLength(1);
  });
});

describe('FR-R6-F11 T042 — an untrusted workspace', () => {
  const WRITES = new Set(['exportReport', 'saveReport', 'deleteSavedReport', 'reconcileExports']);

  it.each(OPERATIONS.filter(([name]) => WRITES.has(name)))('refuses %s before the service', async (_name, invoke, input) => {
    const calls: Call[] = [];
    const api = createReportingApi(spyService(calls), { isWorkspaceTrusted: () => false });
    expect(await invoke(api, input)).toEqual({ ok: false, outcome: 'refused', reason: 'workspace-untrusted' });
    expect(calls).toHaveLength(0);
  });

  it.each(OPERATIONS.filter(([name]) => !WRITES.has(name)))('still delegates %s', async (name, invoke, input) => {
    const calls: Call[] = [];
    const api = createReportingApi(spyService(calls), { isWorkspaceTrusted: () => false });
    expect(await invoke(api, input)).toBe(SENTINEL);
    expect(calls.map((call) => call.op)).toEqual([name]);
  });

  it('reads trust at each call, not once at construction', async () => {
    const calls: Call[] = [];
    let trusted = false;
    const api = createReportingApi(spyService(calls), { isWorkspaceTrusted: () => trusted });
    expect(api.saveReport({ reportId: REPORT_ID })).toEqual({ ok: false, outcome: 'refused', reason: 'workspace-untrusted' });
    trusted = true;
    expect(api.saveReport({ reportId: REPORT_ID })).toBe(SENTINEL);
  });
});

describe('FR-R6-F11 T042 — over a real service', () => {
  let conn: NodeSqliteConnection;
  let sandbox: string;
  const warnings: unknown[] = [];

  beforeEach(() => {
    warnings.length = 0;
    conn = new NodeSqliteConnection({ databasePath: ':memory:' });
    SchemaBootstrapService.bootstrapAndMigrate(conn, () => FIXTURE_NOW);
    seedRun(conn, { runId: 'r-1', createdAtMs: FIXTURE_NOW - 2 * HOUR, workflowId: SECRET_FILTER, status: 'running' });
    seedAttempt(conn, { attemptId: 'a-1', runId: 'r-1', stepIndex: 0, attemptNumber: 1, startedAtMs: FIXTURE_NOW - 2 * HOUR, status: 'running' });
    seedRun(conn, { runId: 'r-2', createdAtMs: FIXTURE_NOW - HOUR, status: 'paused' });
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reporting-api-')));
    fs.mkdirSync(path.join(sandbox, 'ws'));
  });

  afterEach(() => {
    conn.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function serviceWith(overrides: Partial<Parameters<typeof createReportingService>[0]> = {}): ReportingService {
    return createReportingService({
      conn,
      workspaceId: FIXTURE_WORKSPACE,
      nowMs: () => FIXTURE_NOW,
      monotonicMs: () => 0,
      hostTimezone: 'UTC',
      accounting: null,
      workspaceRoot: path.join(sandbox, 'ws'),
      bounds: { leaseLifetimeMs: 10 * HOUR },
      logger: { warn: (code, context) => warnings.push({ code, context }) },
      ...overrides
    });
  }

  function executionRows(): string {
    return JSON.stringify([
      conn.all('SELECT * FROM runs ORDER BY run_id'),
      conn.all('SELECT * FROM steps ORDER BY step_id'),
      conn.all('SELECT * FROM attempts ORDER BY attempt_id')
    ]);
  }

  function pageOf(result: ReportResult<ReportPage>): ReportPage {
    if (!result.ok) throw new Error(`expected a page, got ${JSON.stringify(result)}`);
    return result.value;
  }

  it('changes no execution across every operation', async () => {
    const before = executionRows();
    const api = createReportingApi(serviceWith(), { isWorkspaceTrusted: () => true });
    const page = pageOf(await api.runReport({ view: 'execution-summary', pageSize: 1 }));
    expect(page.rows.length).toBe(1);
    expect(page.cursor).not.toBeNull();
    expect(api.readPage({ cursor: page.cursor }).ok).toBe(true);
    expect(api.drillDown({ reportId: page.reportId, rootId: 'r-1' }).ok).toBe(true);
    const exported = await api.exportReport({
      reportId: page.reportId,
      format: 'json',
      destination: { scheme: 'file', fsPath: path.join(sandbox, 'report.json') }
    });
    expect(exported.ok).toBe(true);
    expect(fs.existsSync(path.join(sandbox, 'report.json'))).toBe(true);
    expect(api.saveReport({ reportId: page.reportId }).ok).toBe(true);
    expect(api.listSavedReports({}).ok).toBe(true);
    expect((await api.reproduceSavedReport({ reportId: page.reportId })).ok).toBe(true);
    const rerun = pageOf(await api.rerunSavedReport({ reportId: page.reportId }));
    expect(rerun.rerunOf).toBe(page.reportId);
    expect(api.closeReport({ reportId: rerun.reportId })).toEqual({ ok: true, value: { released: true } });
    expect(api.deleteSavedReport({ reportId: page.reportId })).toEqual({ ok: true, value: { deleted: true } });
    expect(await api.reconcileExports({})).toEqual({ ok: true, value: { reconciled: 0 } });
    expect(executionRows()).toBe(before);
  });

  it('refuses an export into the evidence store and one with a non-file scheme', async () => {
    const api = createReportingApi(serviceWith(), { isWorkspaceTrusted: () => true });
    const page = pageOf(await api.runReport({ view: 'execution-summary' }));
    const workspaceRoot = path.join(sandbox, 'ws');
    const inStore = await api.exportReport({
      reportId: page.reportId,
      format: 'csv',
      destination: { scheme: 'file', fsPath: path.join(workspaceRoot, '.schegent', 'report.csv') }
    });
    expect(inStore).toEqual({ ok: false, outcome: 'refused', reason: 'destination-in-evidence-store' });
    const remote = await api.exportReport({
      reportId: page.reportId,
      format: 'csv',
      destination: { scheme: 'vscode-remote', fsPath: path.join(sandbox, 'report.csv') }
    });
    expect(remote).toEqual({ ok: false, outcome: 'refused', reason: 'destination-not-local-file' });
    expect(fs.readdirSync(sandbox)).toEqual(['ws']);
  });

  it('ends a stale pending export an earlier host left before admitting a new one', async () => {
    const names = partialNames('old.csv', STALE_EXPORT_ID);
    new ExportStore(conn).insertPending({
      exportId: STALE_EXPORT_ID,
      workspaceId: FIXTURE_WORKSPACE,
      reportId: REPORT_ID,
      format: 'csv',
      stagingDir: sandbox,
      finalName: 'old.csv',
      dataPartialName: names.data,
      manifestPartialName: names.manifest,
      overwrite: false,
      createdMs: FIXTURE_NOW - EXPORT_STALE_AFTER_MS - 1
    });
    const api = createReportingApi(serviceWith(), { isWorkspaceTrusted: () => true });
    const page = pageOf(await api.runReport({ view: 'execution-summary' }));
    const exported = await api.exportReport({
      reportId: page.reportId,
      format: 'csv',
      destination: { scheme: 'file', fsPath: path.join(sandbox, 'report.csv') }
    });
    expect(exported.ok).toBe(true);
    expect(new ExportStore(conn).get(STALE_EXPORT_ID)).toMatchObject({ state: 'failed', reason: 'host-stopped' });
  });

  it('takes the workspace root at construction and refuses a relative one there', () => {
    expect(() => serviceWith({ workspaceRoot: 'relative/ws' })).toThrow(TypeError);
    expect(() => serviceWith({ workspaceRoot: '' })).toThrow(TypeError);
  });

  it('answers write-failed, and logs no driver text, when the export record cannot be written (S6)', async () => {
    const api = createReportingApi(serviceWith(), { isWorkspaceTrusted: () => true });
    const page = pageOf(await api.runReport({ view: 'execution-summary' }));
    conn.run(`CREATE TRIGGER refuse_export BEFORE INSERT ON report_exports BEGIN SELECT RAISE(ABORT, 'disk full at ${sandbox}'); END`);
    const exported = await api.exportReport({
      reportId: page.reportId,
      format: 'csv',
      destination: { scheme: 'file', fsPath: path.join(sandbox, 'report.csv') }
    });
    expect(exported).toEqual({ ok: false, outcome: 'failed', reason: 'write-failed' });
    expect(fs.readdirSync(sandbox)).toEqual(['ws']);
    expect(JSON.stringify(warnings)).not.toContain(sandbox);
    expect(warnings).toEqual([{ code: expect.any(String), context: { operation: 'exportReport', reason: 'write-failed' } }]);
  });

  it('answers write-failed when the pending exports cannot be read for reconciliation (S6)', async () => {
    const api = createReportingApi(serviceWith(), { isWorkspaceTrusted: () => true });
    const page = pageOf(await api.runReport({ view: 'execution-summary' }));
    conn.run('DROP TABLE report_exports');
    expect(await api.reconcileExports({})).toEqual({ ok: false, outcome: 'failed', reason: 'write-failed' });
    const exported = await api.exportReport({
      reportId: page.reportId,
      format: 'csv',
      destination: { scheme: 'file', fsPath: path.join(sandbox, 'report.csv') }
    });
    expect(exported).toEqual({ ok: false, outcome: 'failed', reason: 'write-failed' });
    expect(warnings).toEqual([
      { code: expect.any(String), context: { operation: 'reconcileExports', reason: 'write-failed' } },
      { code: expect.any(String), context: { operation: 'exportReport', reason: 'write-failed' } }
    ]);
  });

  it('answers expired for an export of an unknown report', async () => {
    const api = createReportingApi(serviceWith(), { isWorkspaceTrusted: () => true });
    const result = await api.exportReport(VALID_EXPORT);
    expect(result).toEqual({ ok: false, outcome: 'expired', instruction: 'restart-report-query' });
  });

  it('logs a fixed code and an operation and reason only, never a filter value or a path', async () => {
    let failRead = false;
    const readPool = {
      withReadConnection: <T>(fallback: NodeSqliteConnection, read: (source: NodeSqliteConnection) => T): T => {
        if (failRead) throw new Error(`read failed for ${SECRET_FILTER} at ${sandbox}`);
        return read(fallback);
      }
    };
    const exportFs = { ...nodeExportFs, open: () => Promise.resolve(null) };
    const api = createReportingApi(serviceWith({ readPool, exportFs }), { isWorkspaceTrusted: () => true });
    const page = pageOf(await api.runReport({ view: 'execution-summary', filters: { workflowId: [SECRET_FILTER] } }));
    const failedExport = await api.exportReport({
      reportId: page.reportId,
      format: 'csv',
      destination: { scheme: 'file', fsPath: path.join(sandbox, 'report.csv') }
    });
    expect(failedExport).toEqual({ ok: false, outcome: 'failed', reason: 'write-failed' });
    failRead = true;
    const failedRun = await api.runReport({ view: 'execution-summary', filters: { workflowId: [SECRET_FILTER] } });
    expect(failedRun).toEqual({ ok: false, outcome: 'failed', reason: 'source-read-failed' });
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    const logged = JSON.stringify(warnings);
    expect(logged).not.toContain(SECRET_FILTER);
    expect(logged).not.toContain(sandbox);
    for (const warning of warnings) {
      expect(Object.keys((warning as { context: object }).context).sort()).toEqual(['operation', 'reason']);
    }
  });
});
