/**
 * FR-R6-F11 (FR-012, FR-014, FR-017, FR-018; research R6, R7) — the manifest of a report.
 *
 * Built from the live snapshot alone: what the data is, how it was computed, what it leaves out,
 * and, for an export, the data file's name, length and SHA-256. It holds no directory, no prompt,
 * no transcript and no free-text reason. The F06 policy and calculation versions are the contract
 * constants, present only when the report pinned an accounting revision.
 *
 * The manifest file is compact JSON with a final newline; its SHA-256 is the saved report's
 * manifest digest.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash } from 'node:crypto';
import {
  CSV_PROFILE_VERSION,
  CSV_STATEMENT,
  PRIVACY_PROFILE,
  REPORT_DATA_SCHEMA_VERSION,
  REPORT_MANIFEST_SCHEMA,
  REPORT_MANIFEST_VERSION,
  REPORT_SOURCE_VERSION,
  RETENTION_STATEMENT,
  type CsvTransformation,
  type ManifestData,
  type ManifestVersions,
  type ReportManifest
} from '../../contracts/reporting/report-manifest';
import type { ReportRow } from '../../contracts/reporting/report-rows';
import type { AccountingQueryResponse } from '../../contracts/usage-accounting/query-contract';
import { compareCodePoints } from './report-aggregates';
import type { LiveReport } from './report-snapshots';
import { toUtcIso } from './report-time';

/** F06's policy and calculation versions; typed from the response so a bump fails to compile. */
const ACCOUNTING_POLICY_VERSION: AccountingQueryResponse['policyVersion'] = 1;
const ACCOUNTING_CALCULATION_VERSION: AccountingQueryResponse['calculationVersion'] = 1;
const DURATION_UNIT = 'ms';

export interface ManifestOptions {
  readonly exportId: string | null;
  readonly rerunOf: string | null;
  readonly generatedMs: number;
  /** An export's data file; absent on a saved report. */
  readonly data?: ManifestData;
  /** A CSV export's transformation counts. */
  readonly transformations?: readonly { readonly name: CsvTransformation; readonly count: number }[];
}

function unitsOf(row: ReportRow): readonly string[] {
  return row.kind === 'usage' ? row.measures.map((measure) => measure.unit) : [DURATION_UNIT];
}

/** Every unit the rows carry, distinct, in code-point order. */
export function manifestUnits(rows: readonly ReportRow[]): readonly string[] {
  const units = new Set<string>();
  for (const row of rows) {
    for (const unit of unitsOf(row)) {
      units.add(unit);
    }
  }
  return Object.freeze([...units].sort(compareCodePoints));
}

function versionsOf(report: LiveReport, csv: boolean): ManifestVersions {
  const pinned = report.accountingRevision !== null;
  return Object.freeze({
    source: REPORT_SOURCE_VERSION,
    schema: REPORT_DATA_SCHEMA_VERSION,
    calculation: report.calculationVersion,
    accountingPolicy: pinned ? ACCOUNTING_POLICY_VERSION : null,
    accountingCalculation: pinned ? ACCOUNTING_CALCULATION_VERSION : null,
    ...(csv ? { csvProfile: CSV_PROFILE_VERSION } : {})
  });
}

/** The manifest of `report`, for an export or a saved report. */
export function buildReportManifest(report: LiveReport, options: ManifestOptions): ReportManifest {
  const csv = options.data?.format === 'csv';
  return Object.freeze({
    schema: REPORT_MANIFEST_SCHEMA,
    manifestVersion: REPORT_MANIFEST_VERSION,
    reportId: report.reportId,
    exportId: options.exportId,
    rerunOf: options.rerunOf,
    view: report.query.view,
    query: report.query,
    queryDigest: report.queryDigest,
    generatedUtc: toUtcIso(options.generatedMs),
    sourceCutoffUtc: toUtcIso(report.sourceCutoffMs),
    timezone: report.query.timezone,
    timeBasis: report.timeBasis,
    versions: versionsOf(report, csv),
    accountingRevision: report.accountingRevision,
    coverage: Object.freeze({
      roots: report.coverage.roots,
      attempts: report.coverage.attempts,
      unknownDurations: report.coverage.unknownDurations,
      unattributed: report.coverage.unattributed ?? null,
      gaps: report.coverage.gaps ?? Object.freeze([])
    }),
    omissions: report.omissions,
    rowCount: report.rows.length,
    units: manifestUnits(report.rows),
    privacyProfile: PRIVACY_PROFILE,
    retention: RETENTION_STATEMENT,
    populationDigest: report.populationDigest,
    ...(options.data !== undefined ? { data: Object.freeze({ ...options.data }) } : {}),
    ...(csv && options.transformations !== undefined ? { transformations: options.transformations } : {}),
    ...(csv ? { csvStatement: CSV_STATEMENT } : {})
  });
}

/** The manifest file's text: compact JSON with a final newline. */
export function manifestText(manifest: ReportManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

/** The SHA-256 of the manifest file's text, in lowercase hex. */
export function manifestSha256(manifest: ReportManifest): string {
  return createHash('sha256').update(manifestText(manifest), 'utf8').digest('hex');
}
