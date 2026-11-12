/**
 * FR-R6-F11 (FR-003, FR-006, FR-023; research R1, R2, R13) — one report's source capture.
 *
 * - A run-derived view pins the current F06 revision first, for drill-down; with no accounting
 *   store, or a refusal, the revision is null and an omission says why. It then reads its
 *   population in one read transaction through `readSource`. A read that throws is logged by code
 *   with `{ operation, reason }` only, never the error, and fails `source-read-failed`.
 * - The usage view reads every F06 page at one revision, then one ungrouped total at that revision
 *   for its coverage.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { reportFailed, reportOk, type ReportResult } from '../../contracts/reporting/report-outcomes';
import type { ReportQuery } from '../../contracts/reporting/report-query';
import type {
  AttemptAcpAttribution,
  AttemptHandoffSummary,
  LegacyUsageSummary,
  ReportCoverage,
  ReportEvidenceReference,
  ReportOmission,
  ReportRow,
  RootReviewLoopSummary
} from '../../contracts/reporting/report-rows';
import { toUtcIso } from './report-time';
import { readUsage, usageRequestOf, type AccountingPort, type UsageReadOptions } from './report-usage';
import {
  captureRunSnapshot,
  type CaptureConnection,
  type SnapshotAttempt,
  type SnapshotRoot
} from './snapshot-capture';

const SOURCE_READ_FAILED = 'reporting: source read failed';
const NO_REVISION: readonly ReportOmission[] = Object.freeze([
  Object.freeze({ what: 'accountingRevision', reason: 'accounting-unavailable' })
]);
const NONE: readonly ReportOmission[] = Object.freeze([]);

/** Logs by code; the context carries an operation and a reason, never a value. */
export interface ReportingLogger {
  warn(code: string, context: { readonly operation: string; readonly reason: string }): void;
}

/** Where a report reads from. */
export interface ReportSource {
  /** Runs `read` against the run store's read connection. */
  readonly readSource: <T>(read: (source: CaptureConnection) => T) => T;
  readonly workspaceId: string;
  readonly accounting: AccountingPort | null;
  /** The most roots, attempts or usage rows one snapshot may hold. */
  readonly snapshotCap: number;
  readonly logger?: ReportingLogger;
}

/** The usage view's captured rows and coverage. */
export interface UsageCapture {
  readonly rows: readonly ReportRow[];
  readonly coverage: ReportCoverage;
  readonly legacy?: LegacyUsageSummary;
}

/** What a capture hands to aggregation. */
export interface Capture {
  readonly roots: readonly SnapshotRoot[];
  readonly attempts: readonly SnapshotAttempt[];
  readonly accountingRevision: number | null;
  readonly omissions: readonly ReportOmission[];
  readonly evidenceRefs?: readonly ReportEvidenceReference[];
  readonly acpAttributions?: readonly AttemptAcpAttribution[];
  readonly handoffSummaries?: readonly AttemptHandoffSummary[];
  readonly reviewSummaries?: readonly RootReviewLoopSummary[];
  readonly usage?: UsageCapture;
}

/** The source rows of a capture in identity order (R10): roots then attempts (plus joined cutoff facts), or F06 rows then legacy. */
export function sourcesOf(capture: Capture): readonly (readonly unknown[])[] {
  if (capture.usage === undefined) {
    const groups: (readonly unknown[])[] = [capture.roots, capture.attempts];
    if (capture.evidenceRefs !== undefined && capture.evidenceRefs.length > 0) {
      groups.push(capture.evidenceRefs);
    }
    if (capture.acpAttributions !== undefined && capture.acpAttributions.length > 0) {
      groups.push(capture.acpAttributions);
    }
    if (capture.handoffSummaries !== undefined && capture.handoffSummaries.length > 0) {
      groups.push(capture.handoffSummaries);
    }
    if (capture.reviewSummaries !== undefined && capture.reviewSummaries.length > 0) {
      groups.push(capture.reviewSummaries);
    }
    return groups;
  }
  return [capture.usage.rows, capture.usage.legacy === undefined ? [] : [capture.usage.legacy]];
}

function pinnedRevision(accounting: AccountingPort | null, cutoffMs: number): Pick<Capture, 'accountingRevision' | 'omissions'> {
  const unavailable = { accountingRevision: null, omissions: NO_REVISION };
  if (accounting === null) {
    return unavailable;
  }
  const probe = accounting.query({ groupBy: [], from: toUtcIso(cutoffMs), to: toUtcIso(cutoffMs + 1), limit: 1 });
  return probe.ok ? { accountingRevision: probe.value.revision, omissions: NONE } : unavailable;
}

function captureRuns(source: ReportSource, query: ReportQuery, cutoffMs: number): ReportResult<Capture> {
  const pinned = pinnedRevision(source.accounting, cutoffMs);
  const request = {
    workspaceId: source.workspaceId,
    range: query.range,
    cutoffMs,
    filters: query.filters,
    cap: source.snapshotCap
  };
  let captured: ReturnType<typeof captureRunSnapshot>;
  try {
    captured = source.readSource((connection) => captureRunSnapshot(connection, request));
  } catch {
    source.logger?.warn(SOURCE_READ_FAILED, { operation: 'runReport', reason: 'source-read-failed' });
    return reportFailed('source-read-failed');
  }
  if (!captured.ok) {
    return captured;
  }
  return reportOk({
    ...captured.value,
    ...pinned
  });
}

function usageOptions(cap: number, signal: AbortSignal | undefined): UsageReadOptions {
  return signal === undefined ? { cap } : { cap, signal };
}

function captureUsage(
  source: ReportSource,
  query: ReportQuery,
  signal: AbortSignal | undefined,
  asOfRevision: number | undefined
): ReportResult<Capture> {
  const request = asOfRevision === undefined ? usageRequestOf(query) : { ...usageRequestOf(query), asOfRevision };
  const read = readUsage(source.accounting, request, usageOptions(source.snapshotCap, signal));
  if (!read.ok) {
    return read;
  }
  const { revision, rows, unattributed, gaps, legacy } = read.value;
  const totals = readUsage(source.accounting, { ...request, groupBy: [], asOfRevision: revision }, usageOptions(1, signal));
  if (!totals.ok) {
    return totals;
  }
  const total = totals.value.rows.at(0);
  const coverage: ReportCoverage = Object.freeze({
    roots: total?.roots ?? 0,
    attempts: total?.attempts ?? 0,
    unknownDurations: 0,
    unattributed,
    ...(gaps.length > 0 ? { gaps } : {})
  });
  return reportOk({
    roots: [],
    attempts: [],
    accountingRevision: revision,
    omissions: NONE,
    usage: Object.freeze({ rows, coverage, ...(legacy !== undefined ? { legacy } : {}) })
  });
}

/**
 * Captures the source rows of one validated query at `cutoffMs`. A usage view reads at
 * `asOfRevision` when one is given (a saved report's reproduction, research R10), else at the
 * latest revision.
 */
export function captureReport(
  source: ReportSource,
  query: ReportQuery,
  cutoffMs: number,
  signal: AbortSignal | undefined,
  asOfRevision?: number
): ReportResult<Capture> {
  return query.view === 'usage' ? captureUsage(source, query, signal, asOfRevision) : captureRuns(source, query, cutoffMs);
}
