/**
 * FR-R6-F11 (FR-012, FR-014, FR-017, FR-018) — the manifest written beside every export and
 * stored with every saved report.
 *
 * The manifest names what the data is, how it was computed and what it leaves out. It never
 * holds a directory, a prompt, a transcript or a free-text reason. Zero `vscode` imports
 * (docs/hard-rules.md rule 13).
 */
import type { ReportQuery, ReportView } from './report-query';
import type { ReportOmission, TimeBasis } from './report-rows';

export const REPORT_CALCULATION_VERSION = 1;
export const REPORT_DATA_SCHEMA_VERSION = 1;
export const REPORT_MANIFEST_VERSION = 1;
export const CSV_PROFILE_VERSION = 1;
export const REPORT_SOURCE_VERSION = 'sqlite-store/7';
export const REPORT_MANIFEST_SCHEMA = 'schegent.report-manifest';
export const REPORT_DATA_SCHEMA = 'schegent.report-data';
export const PRIVACY_PROFILE = 'metadata-only';
export const RETENTION_STATEMENT = 'outside-managed-retention';

export const CSV_STATEMENT =
  'CSV is for viewing. Text cells carry a text: prefix, unsafe characters are shown as \\u{XXXX} ' +
  'escapes, long text is truncated and large numbers carry a number: prefix. An empty cell is ' +
  'unknown, never zero. The JSON export is the exact format.';

export const CSV_TRANSFORMATIONS = Object.freeze([
  'text-prefix',
  'control-escaped',
  'truncated',
  'number-prefixed'
] as const);
export type CsvTransformation = (typeof CSV_TRANSFORMATIONS)[number];

export type ExportFormat = 'json' | 'csv';

export interface ManifestVersions {
  readonly source: string;
  readonly schema: number;
  readonly calculation: number;
  readonly accountingPolicy: number | null;
  readonly accountingCalculation: number | null;
  readonly csvProfile?: number;
}

export interface ManifestCoverage {
  readonly roots: number;
  readonly attempts: number;
  readonly unknownDurations: number;
  readonly unattributed: number | null;
  readonly gaps: readonly { readonly kind: string; readonly count: number }[];
}

export interface ManifestData {
  readonly format: ExportFormat;
  readonly fileName: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ReportManifest {
  readonly schema: typeof REPORT_MANIFEST_SCHEMA;
  readonly manifestVersion: typeof REPORT_MANIFEST_VERSION;
  readonly reportId: string;
  readonly exportId: string | null;
  readonly rerunOf: string | null;
  readonly view: ReportView;
  readonly query: ReportQuery;
  readonly queryDigest: string;
  readonly generatedUtc: string;
  readonly sourceCutoffUtc: string;
  readonly timezone: string;
  readonly timeBasis: TimeBasis;
  readonly versions: ManifestVersions;
  readonly accountingRevision: number | null;
  readonly coverage: ManifestCoverage;
  readonly omissions: readonly ReportOmission[];
  readonly rowCount: number;
  readonly units: readonly string[];
  readonly privacyProfile: typeof PRIVACY_PROFILE;
  readonly retention: typeof RETENTION_STATEMENT;
  readonly populationDigest: string;
  /** Absent on a saved-report manifest. */
  readonly data?: ManifestData;
  /** CSV only. */
  readonly transformations?: readonly { readonly name: CsvTransformation; readonly count: number }[];
  readonly csvStatement?: string;
}

export interface ExportReceipt {
  readonly exportId: string;
  readonly reportId: string;
  readonly format: ExportFormat;
  readonly fileName: string;
  readonly manifestFileName: string;
  readonly rowCount: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly manifest: ReportManifest;
}

export interface SavedReportView {
  readonly reportId: string;
  readonly rerunOf: string | null;
  readonly view: ReportView;
  readonly query: ReportQuery;
  readonly manifest: ReportManifest;
  readonly manifestSha256: string;
  readonly createdUtc: string;
}

export type ReproduceVerdict =
  | { readonly verdict: 'reproduced' }
  | {
      readonly verdict: 'source-no-longer-reproducible';
      readonly reason:
        | 'calculation-version-changed'
        | 'population-changed'
        | 'accounting-revision-unavailable';
    };
