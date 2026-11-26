import type { ExportReceipt } from '../../../src/contracts/reporting/report-manifest';
import type { ReportFailure, ReportResult } from '../../../src/contracts/reporting/report-outcomes';
import type { ReportSort, ReportView } from '../../../src/contracts/reporting/report-query';
import { boundaryRefusalText } from './boundary-refusal-text';

export type ExportOutcomeView =
  | { readonly outcome: 'dialog-canceled' }
  | { readonly outcome: 'completed'; readonly result: ReportResult<ExportReceipt> };

export function failureCode(f: ReportFailure): string {
  if (f.outcome === 'refused' || f.outcome === 'failed') return f.reason;
  if (f.outcome === 'limited') return f.limit;
  return f.outcome;
}

export const VIEW_LABELS: Readonly<Record<ReportView, string>> = {
  'execution-summary': 'Run summary',
  'attempt-detail': 'Attempts',
  'failure-cause': 'Failure causes',
  'workflow-revision': 'Workflow versions',
  'time-series': 'Daily totals',
  usage: 'Usage and cost'
};

export const SORT_LABELS: Readonly<Record<ReportSort, string>> = {
  'root-created-desc': 'Newest first',
  'root-created-asc': 'Oldest first',
  'duration-desc': 'Longest first',
  'outcome-asc': 'By outcome',
  'key-asc': 'By group, A to Z',
  'roots-desc': 'Most runs first'
};

/** "2026-11-11T01:00:00.000Z" reads "2026-11-11 01:00 UTC". */
export function cutoffLabel(iso: string): string {
  return iso.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?Z$/, '$1 $2 UTC');
}

export function formatExportOutcomeNotice(exportOutcome: ExportOutcomeView): string {
  if (exportOutcome.outcome === 'dialog-canceled') {
    return 'Export canceled before writing any file.';
  }
  if (exportOutcome.result.ok) {
    const rec = exportOutcome.result.value;
    return `Exported ${rec.fileName} (${rec.rowCount} rows, sha256 ${rec.sha256.slice(0, 12)}…) plus ${rec.manifestFileName}.`;
  }
  const res = exportOutcome.result;
  if (res.outcome === 'expired') {
    return 'Report snapshot expired before export completed. Run the report again to export.';
  }
  if (res.outcome === 'refused' && res.reason === 'workspace-untrusted') {
    return boundaryRefusalText('workspace-not-trusted');
  }
  return `Export failed: ${failureCode(res)}.`;
}
