/**
 * FR-R6-F11 (FR-016..FR-022) — sidebar IPC contract for historical reporting, saved reports,
 * and host-owned report exports.
 *
 * `CMD_READ_REPORT` is read-only (no process, no file/state write, no audit row).
 * `CMD_MUTATE_REPORT` is gated concurrent: `export` obtains its destination exclusively from the
 * host save dialog (zero filesystem paths cross IPC in either direction, FR-016), while `save`
 * and `deleteSaved` mutate the workspace's `saved_reports` SQLite table.
 *
 * Node-free and `vscode`-free so both host and webview bundle it cleanly.
 */
import type { CMD_MUTATE_REPORT, CMD_READ_REPORT, CommandBase } from '../sidebar-ipc';
import type {
  ExportFormat,
  ExportReceipt,
  ReproduceVerdict,
  SavedReportView
} from '../reporting/report-manifest';
import type { ReportResult } from '../reporting/report-outcomes';
import type { ReportPage, RootDrillDown } from '../reporting/report-rows';

export interface SavedReportListPage {
  readonly items: readonly SavedReportView[];
  readonly cursor: string | null;
}

export type ReadReportRequest =
  | { readonly op: 'run'; readonly query: unknown }
  | { readonly op: 'page'; readonly cursor: string }
  | { readonly op: 'drillDown'; readonly reportId: string; readonly rootId: string }
  | { readonly op: 'close'; readonly reportId: string }
  | { readonly op: 'listSaved'; readonly request?: unknown }
  | { readonly op: 'rerunSaved'; readonly reportId: string }
  | { readonly op: 'reproduceSaved'; readonly reportId: string }
  | { readonly op: 'cancelActive' };

export interface ReadReportCommand extends CommandBase<typeof CMD_READ_REPORT> {
  readonly payload: ReadReportRequest;
}

export type ReadReportResponse =
  | { readonly op: 'run'; readonly result: ReportResult<ReportPage> }
  | { readonly op: 'page'; readonly result: ReportResult<ReportPage> }
  | { readonly op: 'drillDown'; readonly result: ReportResult<RootDrillDown> }
  | { readonly op: 'close'; readonly result: ReportResult<{ readonly released: boolean }> }
  | { readonly op: 'listSaved'; readonly result: ReportResult<SavedReportListPage> }
  | { readonly op: 'rerunSaved'; readonly result: ReportResult<ReportPage> }
  | { readonly op: 'reproduceSaved'; readonly result: ReportResult<ReproduceVerdict> }
  | { readonly op: 'cancelActive'; readonly canceled: boolean };

export type MutateReportRequest =
  | { readonly op: 'export'; readonly reportId: string; readonly format: ExportFormat }
  | { readonly op: 'save'; readonly reportId: string }
  | { readonly op: 'deleteSaved'; readonly reportId: string; readonly confirmed: true };

export interface MutateReportCommand extends CommandBase<typeof CMD_MUTATE_REPORT> {
  readonly payload: MutateReportRequest;
}

export type HostReportExportResult =
  | { readonly outcome: 'dialog-canceled' }
  | { readonly outcome: 'completed'; readonly result: ReportResult<ExportReceipt> };

export type MutateReportResponse =
  | { readonly op: 'export'; readonly exportOutcome: HostReportExportResult }
  | { readonly op: 'save'; readonly result: ReportResult<SavedReportView> }
  | { readonly op: 'deleteSaved'; readonly result: ReportResult<{ readonly deleted: boolean }> };
