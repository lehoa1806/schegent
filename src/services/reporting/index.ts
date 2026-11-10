/**
 * FR-R6-F11 (contracts/reporting.md section 1) — the reporting service of one workspace.
 *
 * `createReportingService` composes the report engine, the saved reports and the export pipeline
 * over one run store. It reads through the bounded read pool when one is given, and through the
 * writer connection otherwise. No operation here starts, resumes or changes an execution
 * (FR-016, FR-021): the engine only reads the run store, and the only rows written are the
 * reporting tables' own.
 *
 * An export resolves its destination at the write (FR-022): the resolver decides, before anything
 * is created, that the path is a local file outside the evidence store. Stale pending exports an
 * earlier host left behind are ended before a new export is admitted; a record younger than
 * `EXPORT_STALE_AFTER_MS` is left, so a new export can be refused `export-busy` for up to that long
 * after a crash.
 *
 * A store error while exporting or reconciling (a driver failure, not a refusal) answers
 * `failed write-failed` and is logged with the operation and reason only, so the driver's text,
 * which can name the database path, never reaches the caller (review S6).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ExportFormat, ExportReceipt, ReproduceVerdict, SavedReportView } from '../../contracts/reporting/report-manifest';
import {
  reportFailed,
  reportOk,
  reportRefused,
  type ReportProgressListener,
  type ReportResult
} from '../../contracts/reporting/report-outcomes';
import type { ReportPage, RootDrillDown } from '../../contracts/reporting/report-rows';
import { evidenceStoreOf, resolveExportDestination, type ExportDestinationUri } from '../export-destination';
import type { NodeSqliteConnection } from '../sqlite-store';
import { nodeExportFs, type ExportFs } from './export-publisher';
import { reconcileExports } from './export-reconciler';
import { runExport, type ExportCaps } from './export-service';
import { ExportStore } from './export-store';
import type { ReportingLogger } from './report-capture';
import { createReportEngine, type ReportEngineBounds } from './report-engine';
import type { ReportResources } from './report-snapshots';
import type { AccountingPort } from './report-usage';
import { createSavedReports, type SavedReportPage } from './saved-reports';

export type { ReportingLogger } from './report-capture';
export type { ReportEngineBounds } from './report-engine';
export type { ReportResources } from './report-snapshots';
export type { AccountingPort } from './report-usage';
export type { SavedReportPage } from './saved-reports';

const EXPORT_STORE_FAILED = 'reporting: export store failed';

/** The read pool surface the service needs. */
export interface ReportingReadPool {
  withReadConnection<T>(fallbackWriterConn: NodeSqliteConnection, fn: (conn: NodeSqliteConnection) => T): T;
}

/** Test-only bounds: the engine's caps, lease lifetime and slice budget, and the export caps. */
export interface ReportingServiceBounds extends ReportEngineBounds {
  readonly exportCaps?: Partial<ExportCaps>;
}

export interface ReportingServiceOptions {
  readonly conn: NodeSqliteConnection;
  readonly readPool?: ReportingReadPool;
  readonly workspaceId: string;
  /**
   * The absolute workspace folder whose `.schegent/` store an export may never write into. It is
   * fixed here, at construction, so no request can name a different one.
   */
  readonly workspaceRoot: string;
  readonly nowMs: () => number;
  readonly monotonicMs: () => number;
  readonly hostTimezone: string;
  readonly accounting?: AccountingPort | null;
  readonly exportFs?: ExportFs;
  readonly bounds?: ReportingServiceBounds;
  readonly logger?: ReportingLogger;
}

/** One export request, already shape-checked by the headless port. */
export interface ExportReportInput {
  readonly reportId: string;
  readonly format: ExportFormat;
  readonly destination: ExportDestinationUri;
  readonly overwrite?: boolean;
}

export interface ReportingService {
  runReport(input: unknown, signal?: AbortSignal, progress?: ReportProgressListener): Promise<ReportResult<ReportPage>>;
  readPage(input: unknown): ReportResult<ReportPage>;
  drillDown(input: unknown): ReportResult<RootDrillDown>;
  closeReport(input: unknown): ReportResult<{ readonly released: boolean }>;
  exportReport(
    input: ExportReportInput,
    signal?: AbortSignal,
    progress?: ReportProgressListener
  ): Promise<ReportResult<ExportReceipt>>;
  saveReport(input: unknown): ReportResult<SavedReportView>;
  listSavedReports(input: unknown): ReportResult<SavedReportPage>;
  rerunSavedReport(input: unknown, signal?: AbortSignal, progress?: ReportProgressListener): Promise<ReportResult<ReportPage>>;
  reproduceSavedReport(input: unknown, signal?: AbortSignal): Promise<ReportResult<ReproduceVerdict>>;
  deleteSavedReport(input: unknown): ReportResult<{ readonly deleted: boolean }>;
  /** Ends exports an earlier host left pending; the host calls it once at start. */
  reconcileExports(): Promise<ReportResult<{ readonly reconciled: number }>>;
  resources(): ReportResources;
}

function newExportId(): string {
  return randomUUID().replaceAll('-', '');
}

/** Creates the reporting service of one workspace; throws a `TypeError` for a relative root. */
export function createReportingService(options: ReportingServiceOptions): ReportingService {
  const { conn, readPool, workspaceId, workspaceRoot, nowMs, monotonicMs, logger } = options;
  if (!path.isAbsolute(workspaceRoot)) {
    throw new TypeError('reporting service: workspaceRoot must be an absolute path');
  }
  const exportFs = options.exportFs ?? nodeExportFs;
  const store = new ExportStore(conn);
  const engine = createReportEngine({
    readSource: (read) => (readPool === undefined ? read(conn) : readPool.withReadConnection(conn, read)),
    workspaceId,
    nowMs,
    monotonicMs,
    hostTimezone: options.hostTimezone,
    accounting: options.accounting ?? null,
    ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
    ...(logger === undefined ? {} : { logger })
  });
  const saved = createSavedReports({ conn, workspaceId, engine, nowMs, ...(logger === undefined ? {} : { logger }) });

  function reconcile(): Promise<{ readonly reconciled: number }> {
    return reconcileExports({ store, fs: exportFs, workspaceId, nowMs, ...(logger === undefined ? {} : { logger }) });
  }

  async function storeGuarded<T>(operation: string, run: () => Promise<ReportResult<T>>): Promise<ReportResult<T>> {
    try {
      return await run();
    } catch {
      logger?.warn(EXPORT_STORE_FAILED, { operation, reason: 'write-failed' });
      return reportFailed('write-failed');
    }
  }

  async function exportReport(
    input: ExportReportInput,
    signal?: AbortSignal,
    progress?: ReportProgressListener
  ): Promise<ReportResult<ExportReceipt>> {
    await reconcile();
    const live = engine.useReport(input.reportId);
    if (!live.ok) return live;
    const destination = await resolveExportDestination(input.destination, workspaceRoot);
    if (!destination.ok) {
      return reportRefused(destination.refusal === 'destination-not-local-file' || destination.refusal === 'destination-in-evidence-store'
        ? destination.refusal
        : 'destination-unresolvable');
    }
    return runExport(
      {
        report: live.value,
        workspaceId,
        destinationPath: destination.path,
        evidenceStore: evidenceStoreOf(workspaceRoot),
        format: input.format,
        overwrite: input.overwrite ?? false,
        ...(signal === undefined ? {} : { signal }),
        ...(progress === undefined ? {} : { onProgress: progress })
      },
      {
        store,
        fs: exportFs,
        nowMs,
        monotonicMs,
        newExportId,
        ...(logger === undefined ? {} : { logger }),
        ...(options.bounds?.exportCaps === undefined ? {} : { caps: options.bounds.exportCaps })
      }
    );
  }

  return {
    runReport: (input, signal, progress) => engine.runReport(input, signal, progress),
    readPage: (input) => engine.readPage(input),
    drillDown: (input) => engine.drillDown(input),
    closeReport: (input) => engine.closeReport(input),
    exportReport: (input, signal, progress) => storeGuarded('exportReport', () => exportReport(input, signal, progress)),
    saveReport: (input) => saved.saveReport(input),
    listSavedReports: (input) => saved.listSavedReports(input),
    rerunSavedReport: (input, signal, progress) => saved.rerunSavedReport(input, signal, progress),
    reproduceSavedReport: (input, signal) => saved.reproduceSavedReport(input, signal),
    deleteSavedReport: (input) => saved.deleteSavedReport(input),
    reconcileExports: () => storeGuarded('reconcileExports', async () => reportOk(await reconcile())),
    resources: () => engine.resources()
  };
}
