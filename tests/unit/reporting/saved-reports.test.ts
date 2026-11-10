// FR-R6-F11 T040 (FR-017; research R10) — saved reports: save, list, re-run, reproduce, delete.
//
// WHAT THIS PINS:
//   - save stores the query and an immutable manifest (no export identity, no data section) and is
//     idempotent for one report;
//   - re-run gives a new identity carrying `rerunOf`, over the saved absolute range, at its own
//     cutoff, and leaves the saved manifest unchanged;
//   - reproduce answers `reproduced` when nothing changed, and `source-no-longer-reproducible`
//     after a run update, a deletion, a calculation version change or a compacted revision;
//   - delete removes the record only: a re-run's link becomes null, files are never touched;
//   - every operation is scoped to its workspace and refuses an inexact input.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReproduceVerdict, SavedReportView } from '../../../src/contracts/reporting/report-manifest';
import type { ReportResult } from '../../../src/contracts/reporting/report-outcomes';
import type { ReportPage } from '../../../src/contracts/reporting/report-rows';
import { NodeSqliteConnection, SchemaBootstrapService } from '../../../src/services/sqlite-store';
import {
  type UsageAccountingService,
  createUsageAccountingService
} from '../../../src/services/usage-accounting/usage-accounting-service';
import { type ReportEngine, createReportEngine } from '../../../src/services/reporting/report-engine';
import type { AccountingPort } from '../../../src/services/reporting/report-usage';
import { toUtcIso } from '../../../src/services/reporting/report-time';
import { type SavedReports, createSavedReports } from '../../../src/services/reporting/saved-reports';
import { FIXTURE_NOW, FIXTURE_WORKSPACE, seedAttempt, seedRun } from './report-fixture';

const HOUR = 3_600_000;
const SUMMARY = { view: 'execution-summary' } as const;
const UNKNOWN_ID = 'f'.repeat(32);

let conn: NodeSqliteConnection;
let now = FIXTURE_NOW;

beforeEach(() => {
  now = FIXTURE_NOW;
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

function engineWith(accounting: AccountingPort | null, workspaceId = FIXTURE_WORKSPACE): ReportEngine {
  return createReportEngine({
    readSource: (read) => read(conn),
    workspaceId,
    nowMs: () => now,
    monotonicMs: () => 0,
    hostTimezone: 'UTC',
    accounting,
    bounds: { leaseLifetimeMs: 10 * HOUR }
  });
}

function savedWith(engine: ReportEngine, workspaceId = FIXTURE_WORKSPACE): SavedReports {
  return createSavedReports({ conn, workspaceId, engine, nowMs: () => now });
}

function valueOf<T>(result: ReportResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.value;
}

function seedRoots(): void {
  seedRun(conn, { runId: 'r-1', createdAtMs: FIXTURE_NOW - 2 * HOUR, frozenClosureId: 'fz-1' });
  seedAttempt(conn, { attemptId: 'a-1', runId: 'r-1', stepIndex: 0, attemptNumber: 1, startedAtMs: FIXTURE_NOW - 2 * HOUR, completedAtMs: FIXTURE_NOW - 2 * HOUR + 1_000 });
  seedRun(conn, { runId: 'r-2', createdAtMs: FIXTURE_NOW - HOUR, frozenClosureId: 'fz-1' });
}

async function savedSummary(saved: SavedReports, engine: ReportEngine): Promise<SavedReportView> {
  const page = valueOf(await engine.runReport(SUMMARY));
  return valueOf(saved.saveReport({ reportId: page.reportId }));
}

function storedManifestJson(reportId: string): string {
  const row = conn.get<{ manifest_json: string }>('SELECT manifest_json FROM report_saved WHERE report_id = ?', reportId);
  if (row === undefined) throw new Error('no saved row');
  return row.manifest_json;
}

describe('FR-R6-F11 T040 — saving a report', () => {
  it('stores the query and an immutable manifest without an export identity', async () => {
    seedRoots();
    const engine = engineWith(accountingService());
    const saved = savedWith(engine);
    const page = valueOf(await engine.runReport(SUMMARY));
    const view = valueOf(saved.saveReport({ reportId: page.reportId }));
    expect(view).toMatchObject({ reportId: page.reportId, rerunOf: null, view: 'execution-summary', createdUtc: toUtcIso(now) });
    expect(view.query.view).toBe('execution-summary');
    expect(view.manifest).toMatchObject({ reportId: page.reportId, exportId: null, rerunOf: null, rowCount: 2 });
    expect(view.manifest.data).toBeUndefined();
    const json = storedManifestJson(page.reportId);
    expect(view.manifestSha256).toBe(createHash('sha256').update(json, 'utf8').digest('hex'));
    expect(JSON.parse(json)).toEqual(view.manifest);
  });

  it('answers the stored record when the same report is saved twice', async () => {
    seedRoots();
    const engine = engineWith(accountingService());
    const saved = savedWith(engine);
    const first = await savedSummary(saved, engine);
    now += HOUR;
    expect(valueOf(saved.saveReport({ reportId: first.reportId }))).toEqual(first);
    expect(valueOf(saved.listSavedReports({})).items).toHaveLength(1);
  });

  it('refuses an inexact input and passes on an expired report', async () => {
    const engine = engineWith(accountingService());
    const saved = savedWith(engine);
    expect(saved.saveReport({ reportId: UNKNOWN_ID, extra: 1 })).toEqual({ ok: false, outcome: 'refused', reason: 'invalid-query' });
    expect(saved.saveReport({ reportId: '../x' })).toEqual({ ok: false, outcome: 'refused', reason: 'invalid-query' });
    expect(saved.saveReport({ reportId: UNKNOWN_ID })).toEqual({ ok: false, outcome: 'expired', instruction: 'restart-report-query' });
  });
});

describe('FR-R6-F11 T040 — listing saved reports', () => {
  it('pages newest first with an opaque cursor, within its workspace', async () => {
    seedRoots();
    const engine = engineWith(accountingService());
    const saved = savedWith(engine);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push((await savedSummary(saved, engine)).reportId);
      now += 1_000;
    }
    const first = valueOf(saved.listSavedReports({ limit: 2 }));
    expect(first.items.map((item) => item.reportId)).toEqual([ids.at(2), ids.at(1)]);
    expect(first.cursor).toEqual(expect.any(String));
    const second = valueOf(saved.listSavedReports({ cursor: first.cursor }));
    expect(second.items.map((item) => item.reportId)).toEqual([ids.at(0)]);
    expect(second.cursor).toBeNull();
    expect(valueOf(savedWith(engineWith(null, 'ws-2'), 'ws-2').listSavedReports({})).items).toEqual([]);
  });

  it('refuses a malformed limit or cursor', () => {
    const saved = savedWith(engineWith(null));
    expect(saved.listSavedReports({ limit: 0 })).toEqual({ ok: false, outcome: 'refused', reason: 'invalid-query' });
    expect(saved.listSavedReports({ limit: 1.5 })).toEqual({ ok: false, outcome: 'refused', reason: 'invalid-query' });
    expect(saved.listSavedReports({ other: 1 })).toEqual({ ok: false, outcome: 'refused', reason: 'invalid-query' });
    expect(saved.listSavedReports({ cursor: 'not-a-cursor' })).toEqual({ ok: false, outcome: 'refused', reason: 'invalid-cursor' });
  });
});

describe('FR-R6-F11 T040 — re-running a saved report', () => {
  it('creates a new identity with rerunOf over the saved range at its own cutoff', async () => {
    seedRoots();
    const engine = engineWith(accountingService());
    const saved = savedWith(engine);
    const original = await savedSummary(saved, engine);
    const manifestBefore = storedManifestJson(original.reportId);
    now += HOUR;
    seedRun(conn, { runId: 'r-3', createdAtMs: now - 1_000, frozenClosureId: 'fz-1' });
    const page: ReportPage = valueOf(await saved.rerunSavedReport({ reportId: original.reportId }));
    expect(page.reportId).not.toBe(original.reportId);
    expect(page.rerunOf).toBe(original.reportId);
    expect(page.sourceCutoffUtc).toBe(toUtcIso(now));
    expect(page.rowCount).toBe(2);
    const live = valueOf(engine.useReport(page.reportId));
    expect(live.query.range).toEqual(original.query.range);
    const rerun = valueOf(saved.saveReport({ reportId: page.reportId }));
    expect(rerun).toMatchObject({ rerunOf: original.reportId, manifest: { rerunOf: original.reportId } });
    expect(storedManifestJson(original.reportId)).toBe(manifestBefore);
  });

  it('refuses an unknown saved report', async () => {
    const saved = savedWith(engineWith(null));
    expect(await saved.rerunSavedReport({ reportId: UNKNOWN_ID })).toEqual({ ok: false, outcome: 'refused', reason: 'unknown-saved-report' });
  });
});

describe('FR-R6-F11 T040 — reproducing a saved report', () => {
  async function reproduceAfter(change: () => void): Promise<ReportResult<ReproduceVerdict>> {
    seedRoots();
    const engine = engineWith(accountingService());
    const saved = savedWith(engine);
    const original = await savedSummary(saved, engine);
    now += HOUR;
    change();
    return saved.reproduceSavedReport({ reportId: original.reportId });
  }

  it('reproduces when nothing in the population changed', async () => {
    const result = await reproduceAfter(() => {
      seedRun(conn, { runId: 'r-late', createdAtMs: now - 1_000, frozenClosureId: 'fz-1' });
    });
    expect(result).toEqual({ ok: true, value: { verdict: 'reproduced' } });
  });

  it('is no longer reproducible after a run in the population is updated', async () => {
    const result = await reproduceAfter(() => {
      conn.run(`UPDATE runs SET status = 'failed', terminal_reason = 'late' WHERE run_id = 'r-2'`);
    });
    expect(result).toEqual({ ok: true, value: { verdict: 'source-no-longer-reproducible', reason: 'population-changed' } });
  });

  it('is no longer reproducible after a run in the population is deleted', async () => {
    const result = await reproduceAfter(() => {
      conn.run(`DELETE FROM runs WHERE run_id = 'r-2'`);
    });
    expect(result).toEqual({ ok: true, value: { verdict: 'source-no-longer-reproducible', reason: 'population-changed' } });
  });

  it('is no longer reproducible after the calculation version changes', async () => {
    const result = await reproduceAfter(() => {
      conn.run('UPDATE report_saved SET calculation_version = calculation_version + 1');
    });
    expect(result).toEqual({ ok: true, value: { verdict: 'source-no-longer-reproducible', reason: 'calculation-version-changed' } });
  });

  function ingestUsage(accounting: UsageAccountingService, ordinal: number): void {
    const ingested = accounting.ingestObservation({
      producerNamespace: 'schegent.phase-end/1',
      source: 'phase-end',
      sourceKind: 'phase-end',
      sourceIdentity: `a-1:${ordinal}`,
      rootId: 'r-1',
      attemptId: 'a-1',
      invocationOrdinal: ordinal,
      counterScope: 'invocation-delta',
      adapterVersion: 'test/1',
      dimensions: { backend: 'claude', modelRequested: 'm-1', phaseId: 'implement' },
      eventUtc: toUtcIso(FIXTURE_NOW - HOUR),
      observedUtc: toUtcIso(FIXTURE_NOW - HOUR),
      measures: [{ measure: 'input_tokens', quantity: 4, unit: 'count', provenance: 'provider-reported' }]
    });
    expect(ingested.ok).toBe(true);
  }

  async function savedUsage(accounting: UsageAccountingService): Promise<SavedReportView> {
    seedRun(conn, { runId: 'r-1', createdAtMs: FIXTURE_NOW - 2 * HOUR, frozenClosureId: 'fz-1' });
    seedAttempt(conn, { attemptId: 'a-1', runId: 'r-1', stepIndex: 0, attemptNumber: 1, startedAtMs: FIXTURE_NOW - 2 * HOUR });
    ingestUsage(accounting, 0);
    const engine = engineWith(accounting);
    const page = valueOf(await engine.runReport({ view: 'usage' }));
    return valueOf(savedWith(engine).saveReport({ reportId: page.reportId }));
  }

  it('reproduces a usage report at its saved revision after later usage is recorded', async () => {
    const accounting = accountingService();
    const original = await savedUsage(accounting);
    now += HOUR;
    ingestUsage(accounting, 1);
    const later = savedWith(engineWith(accounting));
    expect(await later.reproduceSavedReport({ reportId: original.reportId })).toEqual({ ok: true, value: { verdict: 'reproduced' } });
    const rerun = valueOf(await later.rerunSavedReport({ reportId: original.reportId }));
    expect(rerun.accountingRevision).toBeGreaterThan(original.manifest.accountingRevision ?? Number.MAX_SAFE_INTEGER);
  });

  it('is no longer reproducible once the saved accounting revision is compacted', async () => {
    const accounting = accountingService();
    const original = await savedUsage(accounting);
    const saved = savedWith(engineWith(accounting));
    expect(valueOf(await saved.reproduceSavedReport({ reportId: original.reportId }))).toEqual({ verdict: 'reproduced' });
    const compacted: AccountingPort = {
      query: (request, signal) =>
        request.asOfRevision === undefined ? accounting.query(request, signal) : { ok: false, refusal: { code: 'revision-compacted' } }
    };
    const later = savedWith(engineWith(compacted));
    expect(await later.reproduceSavedReport({ reportId: original.reportId })).toEqual({
      ok: true,
      value: { verdict: 'source-no-longer-reproducible', reason: 'accounting-revision-unavailable' }
    });
  });

  it('refuses an unknown saved report and one from another workspace', async () => {
    seedRoots();
    const engine = engineWith(accountingService());
    const original = await savedSummary(savedWith(engine), engine);
    const other = savedWith(engineWith(null, 'ws-2'), 'ws-2');
    const unknown = { ok: false, outcome: 'refused', reason: 'unknown-saved-report' };
    expect(await savedWith(engine).reproduceSavedReport({ reportId: UNKNOWN_ID })).toEqual(unknown);
    expect(await other.reproduceSavedReport({ reportId: original.reportId })).toEqual(unknown);
  });
});

describe('FR-R6-F11 T040 — deleting a saved report', () => {
  let sandbox = '';

  beforeEach(() => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'saved-reports-')));
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('removes the record only, unlinks re-runs and leaves exported files untouched', async () => {
    seedRoots();
    const engine = engineWith(accountingService());
    const saved = savedWith(engine);
    const original = await savedSummary(saved, engine);
    const page = valueOf(await saved.rerunSavedReport({ reportId: original.reportId }));
    const rerun = valueOf(saved.saveReport({ reportId: page.reportId }));
    const exported = path.join(sandbox, 'report.json');
    fs.writeFileSync(exported, '{"rows":[]}\n');
    fs.writeFileSync(`${exported}.manifest.json`, storedManifestJson(original.reportId));
    const before = fs.readdirSync(sandbox).map((name) => [name, fs.readFileSync(path.join(sandbox, name), 'utf8')]);

    expect(savedWith(engineWith(null, 'ws-2'), 'ws-2').deleteSavedReport({ reportId: original.reportId })).toEqual({ ok: true, value: { deleted: false } });
    expect(saved.deleteSavedReport({ reportId: original.reportId })).toEqual({ ok: true, value: { deleted: true } });
    expect(saved.deleteSavedReport({ reportId: original.reportId })).toEqual({ ok: true, value: { deleted: false } });

    const remaining = valueOf(saved.listSavedReports({})).items;
    expect(remaining.map((item) => item.reportId)).toEqual([rerun.reportId]);
    expect(remaining.at(0)).toMatchObject({ rerunOf: null, manifest: { rerunOf: original.reportId } });
    expect(fs.readdirSync(sandbox).map((name) => [name, fs.readFileSync(path.join(sandbox, name), 'utf8')])).toEqual(before);
  });

  it('refuses an inexact input', () => {
    const saved = savedWith(engineWith(null));
    expect(saved.deleteSavedReport({})).toEqual({ ok: false, outcome: 'refused', reason: 'invalid-query' });
  });
});
