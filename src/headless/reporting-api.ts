// FR-R6-F11 (contracts/reporting.md sections 1 and 2; FR-016, FR-021, FR-022) — the headless
// reporting port.
//
// Every operation checks its exact key set and primitive types before the service sees it, and
// refuses `invalid-query` otherwise; the service then applies its own full validation. Shape comes
// first, trust second: an untrusted workspace is refused `workspace-untrusted` for the four
// operations that write (export, save, delete, and reconciliation, which removes files), and every
// read still reaches the service. Trust is read at each call, so a workspace trusted later needs no
// new port. An export names no workspace root: the service holds the one it was created with.
//
// No operation starts, resumes or changes an execution. This module imports no editor host API
// (rule 13). It performs no I/O of its own and retains nothing.

import type { ExportReceipt, ReproduceVerdict, SavedReportView } from '../contracts/reporting/report-manifest';
import {
  reportRefused,
  type ReportFailure,
  type ReportProgressListener,
  type ReportResult
} from '../contracts/reporting/report-outcomes';
import type { ReportPage, RootDrillDown } from '../contracts/reporting/report-rows';
import type { ExportReportInput, ReportingService, SavedReportPage } from '../services/reporting/index';
import { QUERY_KEYS } from '../services/reporting/report-query-validator';

export interface ReportingApiOptions {
  /** Whether the workspace is trusted now; read at each write. */
  readonly isWorkspaceTrusted: () => boolean;
}

export interface ReportingApi {
  runReport(input: unknown, signal?: AbortSignal, progress?: ReportProgressListener): Promise<ReportResult<ReportPage>>;
  readPage(input: unknown): ReportResult<ReportPage>;
  drillDown(input: unknown): ReportResult<RootDrillDown>;
  closeReport(input: unknown): ReportResult<{ readonly released: boolean }>;
  exportReport(input: unknown, signal?: AbortSignal, progress?: ReportProgressListener): Promise<ReportResult<ExportReceipt>>;
  saveReport(input: unknown): ReportResult<SavedReportView>;
  listSavedReports(input: unknown): ReportResult<SavedReportPage>;
  rerunSavedReport(input: unknown, signal?: AbortSignal, progress?: ReportProgressListener): Promise<ReportResult<ReportPage>>;
  reproduceSavedReport(input: unknown, signal?: AbortSignal): Promise<ReportResult<ReproduceVerdict>>;
  deleteSavedReport(input: unknown): ReportResult<{ readonly deleted: boolean }>;
  reconcileExports(input: unknown): Promise<ReportResult<{ readonly reconciled: number }>>;
}

type Shape = Readonly<Record<string, (value: unknown) => boolean>>;

const INVALID_QUERY = reportRefused('invalid-query');
const UNTRUSTED = reportRefused('workspace-untrusted');
const EXPORT_FORMATS: readonly unknown[] = ['json', 'csv'];

const isString = (value: unknown): boolean => typeof value === 'string';
const isNumber = (value: unknown): boolean => typeof value === 'number';
const isBoolean = (value: unknown): boolean => typeof value === 'boolean';
const isExportFormat = (value: unknown): boolean => EXPORT_FORMATS.includes(value);

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

/** True when `input` holds every required key, only known keys, and each value fits its check. */
function fits(input: unknown, required: Shape, optional: Shape = {}): input is Record<string, unknown> {
  if (!isPlainRecord(input)) return false;
  for (const key of Object.keys(required)) {
    if (!Object.hasOwn(input, key)) return false;
  }
  return Object.entries(input).every(([key, value]) => {
    const check = Object.hasOwn(required, key) ? required[key] : Object.hasOwn(optional, key) ? optional[key] : undefined;
    return check !== undefined && check(value);
  });
}

const QUERY_SHAPE: Shape = Object.freeze(
  Object.fromEntries(QUERY_KEYS.filter((key) => key !== 'view').map((key) => [key, () => true]))
);
const REPORT_ID_SHAPE: Shape = Object.freeze({ reportId: isString });
const DESTINATION_SHAPE: Shape = Object.freeze({ scheme: isString, fsPath: isString });
const EXPORT_SHAPE: Shape = Object.freeze({
  reportId: isString,
  format: isExportFormat,
  destination: (value: unknown) => fits(value, DESTINATION_SHAPE)
});

const isQuery = (input: unknown): boolean => fits(input, { view: isString }, QUERY_SHAPE);
const isCursorRequest = (input: unknown): boolean => fits(input, { cursor: isString });
const isDrillDown = (input: unknown): boolean => fits(input, { reportId: isString, rootId: isString });
const isReportId = (input: unknown): boolean => fits(input, REPORT_ID_SHAPE);
const isListRequest = (input: unknown): boolean => fits(input, {}, { limit: isNumber, cursor: isString });
const isExportRequest = (input: unknown): input is ExportReportInput => fits(input, EXPORT_SHAPE, { overwrite: isBoolean });
const isEmpty = (input: unknown): boolean => fits(input, {});

function guarded<T>(valid: boolean, run: () => ReportResult<T>): ReportResult<T> {
  return valid ? run() : INVALID_QUERY;
}

function guardedAsync<T>(valid: boolean, run: () => Promise<ReportResult<T>>): Promise<ReportResult<T>> {
  return valid ? run() : Promise.resolve(INVALID_QUERY);
}

/** Creates the headless reporting port over a reporting service. */
export function createReportingApi(service: ReportingService, options: ReportingApiOptions): ReportingApi {
  function trusted<T>(run: () => T, refused: (failure: ReportFailure) => T): T {
    return options.isWorkspaceTrusted() ? run() : refused(UNTRUSTED);
  }

  return {
    runReport: (input, signal, progress) => guardedAsync(isQuery(input), () => service.runReport(input, signal, progress)),
    readPage: (input) => guarded(isCursorRequest(input), () => service.readPage(input)),
    drillDown: (input) => guarded(isDrillDown(input), () => service.drillDown(input)),
    closeReport: (input) => guarded(isReportId(input), () => service.closeReport(input)),
    exportReport: (input, signal, progress) => {
      if (!isExportRequest(input)) return Promise.resolve(INVALID_QUERY);
      return trusted(() => service.exportReport(input, signal, progress), (failure) => Promise.resolve(failure));
    },
    saveReport: (input) => guarded(isReportId(input), () => trusted(() => service.saveReport(input), (failure) => failure)),
    listSavedReports: (input) => guarded(isListRequest(input), () => service.listSavedReports(input)),
    rerunSavedReport: (input, signal, progress) =>
      guardedAsync(isReportId(input), () => service.rerunSavedReport(input, signal, progress)),
    reproduceSavedReport: (input, signal) => guardedAsync(isReportId(input), () => service.reproduceSavedReport(input, signal)),
    deleteSavedReport: (input) =>
      guarded(isReportId(input), () => trusted(() => service.deleteSavedReport(input), (failure) => failure)),
    reconcileExports: (input) =>
      guardedAsync(isEmpty(input), () => trusted(() => service.reconcileExports(), (failure) => Promise.resolve(failure)))
  };
}
