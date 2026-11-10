/**
 * FR-R6-F11 (FR-017; research R10; data-model "Saved report") — saved reports.
 *
 * `saveReport` stores a live report's canonical query and an immutable manifest (no export
 * identity, no data section). Saving the same report again answers the stored record, so a save is
 * idempotent. A re-run's link names its parent only while the parent is stored; deleting the
 * parent sets the link to NULL (the column's `ON DELETE SET NULL`), while the child's manifest keeps
 * the identity it was saved with.
 *
 * `rerunSavedReport` runs the saved absolute range at a new cutoff under a new identity, and stores
 * nothing until the caller saves it. `reproduceSavedReport` re-reads the population at the saved
 * cutoff and accounting revision and compares its digest: a different calculation version, a
 * changed population or a compacted revision is `source-no-longer-reproducible`.
 *
 * `deleteSavedReport` removes the record only; no exported file is ever touched. Every statement is
 * scoped to the workspace, and every operation refuses an input whose key set is not exact.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  REPORT_CALCULATION_VERSION,
  type ReportManifest,
  type ReproduceVerdict,
  type SavedReportView
} from '../../contracts/reporting/report-manifest';
import {
  reportFailed,
  reportOk,
  reportRefused,
  type ReportProgressListener,
  type ReportResult
} from '../../contracts/reporting/report-outcomes';
import type { ReportQuery, ReportView } from '../../contracts/reporting/report-query';
import type { ReportPage } from '../../contracts/reporting/report-rows';
import { DIMENSION_VALUE_PATTERNS } from '../../contracts/usage-accounting/query-contract';
import type { NodeSqliteConnection } from '../sqlite-store';
import { buildReportManifest, manifestSha256, manifestText } from './export-manifest';
import type { ReportingLogger } from './report-capture';
import type { ReportEngine } from './report-engine';
import { canonicalQueryJson } from './report-query-validator';
import { toUtcIso } from './report-time';

/** The page size of `listSavedReports` when none is given, and its largest accepted value. */
export const DEFAULT_SAVED_PAGE_SIZE = 50;
export const MAX_SAVED_PAGE_SIZE = 200;

const SAVED_CURSOR_PATTERN = /^(\d{1,16})\.([0-9a-f]{32})$/;
const WRITE_FAILED = 'reporting: saved report write failed';
const READ_FAILED = 'reporting: saved report read failed';
const INVALID_QUERY = reportRefused('invalid-query');
const UNKNOWN = reportRefused('unknown-saved-report');

export interface SavedReportsOptions {
  readonly conn: NodeSqliteConnection;
  readonly workspaceId: string;
  readonly engine: ReportEngine;
  readonly nowMs: () => number;
  readonly logger?: ReportingLogger;
}

export interface SavedReportPage {
  readonly items: readonly SavedReportView[];
  /** Opaque; `null` on the last page. */
  readonly cursor: string | null;
}

export interface SavedReports {
  saveReport(input: unknown): ReportResult<SavedReportView>;
  listSavedReports(input: unknown): ReportResult<SavedReportPage>;
  rerunSavedReport(input: unknown, signal?: AbortSignal, progress?: ReportProgressListener): Promise<ReportResult<ReportPage>>;
  reproduceSavedReport(input: unknown, signal?: AbortSignal): Promise<ReportResult<ReproduceVerdict>>;
  deleteSavedReport(input: unknown): ReportResult<{ readonly deleted: boolean }>;
}

interface SavedRow {
  readonly report_id: string;
  readonly rerun_of: string | null;
  readonly view: ReportView;
  readonly query_json: string;
  readonly manifest_json: string;
  readonly manifest_sha256: string;
  readonly calculation_version: number;
  readonly accounting_revision: number | null;
  readonly source_cutoff_ms: number;
  readonly population_digest: string;
  readonly created_at_ms: number;
}

const COLUMNS = `report_id, rerun_of, view, query_json, manifest_json, manifest_sha256, calculation_version,
  accounting_revision, source_cutoff_ms, population_digest, created_at_ms`;

function hasExactKeys(input: unknown, required: readonly string[], optional: readonly string[] = []): input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return false;
  }
  const keys = Object.keys(input);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

function reportIdOf(input: unknown): string | undefined {
  if (!hasExactKeys(input, ['reportId'])) {
    return undefined;
  }
  const { reportId } = input;
  return typeof reportId === 'string' && DIMENSION_VALUE_PATTERNS.identifier.test(reportId) ? reportId : undefined;
}

function viewOf(row: SavedRow): SavedReportView {
  return Object.freeze({
    reportId: row.report_id,
    rerunOf: row.rerun_of,
    view: row.view,
    query: JSON.parse(row.query_json) as ReportQuery,
    manifest: JSON.parse(row.manifest_json) as ReportManifest,
    manifestSha256: row.manifest_sha256,
    createdUtc: toUtcIso(row.created_at_ms)
  });
}

function limitOf(raw: unknown): number | undefined {
  if (raw === undefined) {
    return DEFAULT_SAVED_PAGE_SIZE;
  }
  return Number.isInteger(raw) && typeof raw === 'number' && raw >= 1 && raw <= MAX_SAVED_PAGE_SIZE ? raw : undefined;
}

/** Creates the saved-report operations of one workspace. */
export function createSavedReports(options: SavedReportsOptions): SavedReports {
  const { conn, workspaceId, engine } = options;

  function warn(code: string, operation: string, reason: string): void {
    options.logger?.warn(code, { operation, reason });
  }

  function storedRow(reportId: string): SavedRow | undefined {
    return conn.get<SavedRow>(`SELECT ${COLUMNS} FROM report_saved WHERE report_id = ? AND workspace_id = ?`, reportId, workspaceId);
  }

  function readView(operation: string, read: () => SavedRow | undefined): ReportResult<SavedReportView> | undefined {
    try {
      const row = read();
      return row === undefined ? undefined : reportOk(viewOf(row));
    } catch {
      warn(READ_FAILED, operation, 'source-read-failed');
      return reportFailed('source-read-failed');
    }
  }

  function insert(reportId: string): ReportResult<SavedReportView> {
    const live = engine.useReport(reportId);
    if (!live.ok) {
      return live;
    }
    const report = live.value;
    const now = options.nowMs();
    const manifest = buildReportManifest(report, { exportId: null, rerunOf: report.rerunOf ?? null, generatedMs: now });
    try {
      conn.run(
        `INSERT OR IGNORE INTO report_saved (report_id, workspace_id, rerun_of, view, query_json, manifest_json,
           manifest_sha256, calculation_version, accounting_revision, source_cutoff_ms, population_digest, created_at_ms)
         VALUES (?, ?, (SELECT report_id FROM report_saved WHERE report_id = ? AND workspace_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        report.reportId,
        workspaceId,
        report.rerunOf ?? null,
        workspaceId,
        report.query.view,
        canonicalQueryJson(report.query),
        manifestText(manifest),
        manifestSha256(manifest),
        report.calculationVersion,
        report.accountingRevision,
        report.sourceCutoffMs,
        report.populationDigest,
        now
      );
    } catch {
      warn(WRITE_FAILED, 'saveReport', 'write-failed');
      return reportFailed('write-failed');
    }
    return readView('saveReport', () => storedRow(reportId)) ?? reportFailed('write-failed');
  }

  function saveReport(input: unknown): ReportResult<SavedReportView> {
    const reportId = reportIdOf(input);
    if (reportId === undefined) {
      return INVALID_QUERY;
    }
    return readView('saveReport', () => storedRow(reportId)) ?? insert(reportId);
  }

  function listSavedReports(input: unknown): ReportResult<SavedReportPage> {
    if (!hasExactKeys(input, [], ['limit', 'cursor'])) {
      return INVALID_QUERY;
    }
    const limit = limitOf(input.limit);
    if (limit === undefined) {
      return INVALID_QUERY;
    }
    const after = input.cursor === undefined || input.cursor === null ? null : SAVED_CURSOR_PATTERN.exec(String(input.cursor));
    if (input.cursor !== undefined && input.cursor !== null && (typeof input.cursor !== 'string' || after === null)) {
      return reportRefused('invalid-cursor');
    }
    let rows: SavedRow[];
    try {
      rows =
        after === null
          ? conn.all<SavedRow>(
              `SELECT ${COLUMNS} FROM report_saved WHERE workspace_id = ? ORDER BY created_at_ms DESC, report_id DESC LIMIT ?`,
              workspaceId,
              limit + 1
            )
          : conn.all<SavedRow>(
              `SELECT ${COLUMNS} FROM report_saved WHERE workspace_id = ?
                 AND (created_at_ms < ? OR (created_at_ms = ? AND report_id < ?))
               ORDER BY created_at_ms DESC, report_id DESC LIMIT ?`,
              workspaceId,
              Number(after.at(1)),
              Number(after.at(1)),
              after.at(2) ?? '',
              limit + 1
            );
      const items = rows.slice(0, limit).map(viewOf);
      const last = rows.length > limit ? rows.at(limit - 1) : undefined;
      return reportOk(Object.freeze({ items: Object.freeze(items), cursor: last === undefined ? null : `${last.created_at_ms}.${last.report_id}` }));
    } catch {
      warn(READ_FAILED, 'listSavedReports', 'source-read-failed');
      return reportFailed('source-read-failed');
    }
  }

  function savedRowOf(input: unknown, operation: string): ReportResult<SavedRow> {
    const reportId = reportIdOf(input);
    if (reportId === undefined) {
      return INVALID_QUERY;
    }
    try {
      const row = storedRow(reportId);
      return row === undefined ? UNKNOWN : reportOk(row);
    } catch {
      warn(READ_FAILED, operation, 'source-read-failed');
      return reportFailed('source-read-failed');
    }
  }

  async function rerunSavedReport(
    input: unknown,
    signal?: AbortSignal,
    progress?: ReportProgressListener
  ): Promise<ReportResult<ReportPage>> {
    const saved = savedRowOf(input, 'rerunSavedReport');
    if (!saved.ok) {
      return saved;
    }
    return engine.rerunReport(JSON.parse(saved.value.query_json), saved.value.report_id, signal, progress);
  }

  async function reproduceSavedReport(input: unknown, signal?: AbortSignal): Promise<ReportResult<ReproduceVerdict>> {
    const saved = savedRowOf(input, 'reproduceSavedReport');
    if (!saved.ok) {
      return saved;
    }
    const row = saved.value;
    if (row.calculation_version !== REPORT_CALCULATION_VERSION) {
      return reportOk(Object.freeze({ verdict: 'source-no-longer-reproducible', reason: 'calculation-version-changed' }));
    }
    const recaptured = await engine.recapture(JSON.parse(row.query_json), row.source_cutoff_ms, row.accounting_revision, signal);
    if (!recaptured.ok) {
      const compacted = recaptured.outcome === 'failed' && recaptured.reason === 'accounting-revision-unavailable';
      return compacted
        ? reportOk(Object.freeze({ verdict: 'source-no-longer-reproducible', reason: 'accounting-revision-unavailable' }))
        : recaptured;
    }
    return recaptured.value.populationDigest === row.population_digest
      ? reportOk(Object.freeze({ verdict: 'reproduced' }))
      : reportOk(Object.freeze({ verdict: 'source-no-longer-reproducible', reason: 'population-changed' }));
  }

  function deleteSavedReport(input: unknown): ReportResult<{ readonly deleted: boolean }> {
    const reportId = reportIdOf(input);
    if (reportId === undefined) {
      return INVALID_QUERY;
    }
    try {
      const { changes } = conn.run('DELETE FROM report_saved WHERE report_id = ? AND workspace_id = ?', reportId, workspaceId);
      return reportOk(Object.freeze({ deleted: changes === 1 }));
    } catch {
      warn(WRITE_FAILED, 'deleteSavedReport', 'write-failed');
      return reportFailed('write-failed');
    }
  }

  return Object.freeze({ saveReport, listSavedReports, rerunSavedReport, reproduceSavedReport, deleteSavedReport });
}
