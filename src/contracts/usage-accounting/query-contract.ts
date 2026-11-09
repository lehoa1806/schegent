/**
 * FR-R6-F06 (FR-017, FR-018, FR-022) — the accounting query request and response.
 *
 * One shape for the headless API and the sidebar read, so the two surfaces cannot disagree.
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { Completeness, GapKind, Measure, Reconciliation } from './accounting-types';

export const ACCOUNTING_DIMENSIONS = Object.freeze([
  'backend',
  'model',
  'workflowRevision',
  'phaseId',
  'attemptOutcome',
  'utcDay'
] as const);
export type AccountingDimension = (typeof ACCOUNTING_DIMENSIONS)[number];

export const MAX_GROUP_BY_DIMENSIONS = 3;
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_CURSOR_CHARS = 512;
export const MAX_REPORTED_GAP_KINDS = 20;

export interface AccountingQueryRequest {
  /** UTC instant, inclusive, over event time. */
  readonly from?: string;
  /** UTC instant, exclusive; must be after `from`. */
  readonly to?: string;
  /** 0..3 unique dimensions. */
  readonly groupBy: readonly AccountingDimension[];
  readonly filters?: Partial<Record<AccountingDimension, string>>;
  /** Default: every measure. */
  readonly measures?: readonly Measure[];
  /** Default: the latest revision. */
  readonly asOfRevision?: number;
  /** Default false. Legacy buckets are listed separately, never merged. */
  readonly includeLegacy?: boolean;
  /** 1..200, default 50. */
  readonly limit?: number;
  /** Opaque keyset cursor, at most 512 characters. */
  readonly cursor?: string;
}

export interface AccountingMeasureTotal {
  readonly measure: Measure;
  readonly unit: string;
  /** Exact decimal text. Tokens are integers; money and credits have scale 6. */
  readonly total: string;
  /** Cost only: the provider-reported and derived lane. */
  readonly reportedTotal?: string;
  /** Cost only: the estimated lane. */
  readonly estimatedTotal?: string;
  readonly completeness: Completeness;
  /** Attempts with a known value over attempts in the row. */
  readonly coverage: { readonly known: number; readonly denominator: number };
}

export interface AccountingRow {
  /** A `null` value is the bucket of attempts missing that dimension. */
  readonly key: Partial<Record<AccountingDimension, string | null>>;
  readonly attempts: number;
  readonly roots: number;
  readonly measures: readonly AccountingMeasureTotal[];
}

export interface LegacyEpochSummary {
  readonly runCount: number;
  readonly costMicros: string;
  readonly boundaryRunId: string | null;
  readonly boundaryTerminalUtc: string | null;
  readonly reconciliation: Reconciliation | null;
  /** Backend, model and phase are not recorded for legacy runs (FR-013). */
  readonly detail: 'unavailable';
}

export interface GapSummary {
  readonly kind: GapKind;
  readonly count: number;
}

export interface AccountingQueryResponse {
  readonly revision: number;
  readonly cutoffIngestSeq: number;
  readonly policyVersion: 1;
  readonly calculationVersion: 1;
  readonly rows: readonly AccountingRow[];
  readonly legacy?: LegacyEpochSummary;
  readonly unattributedCount: number;
  /** The top 20 gap kinds by count. */
  readonly gaps: readonly GapSummary[];
  readonly nextCursor?: string;
}

export const MAX_QUERY_LIMIT = 200;

/**
 * The closed patterns a stored or filtered dimension value must match (research R11). Shared by
 * the host sanitizer and the request validator, which the webview may bundle, so this module
 * stays free of Node imports.
 */
export const DIMENSION_VALUE_PATTERNS = Object.freeze({
  backend: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  model: /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/,
  identifier: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  utcDay: /^\d{4}-\d{2}-\d{2}$/
});

export interface ReadGapsRequest {
  /** 1..200, default 50. */
  readonly limit?: number;
  readonly cursor?: string;
}

export interface AccountingGapRow {
  readonly kind: GapKind;
  readonly scopeKey: string;
  readonly count: number;
  readonly firstSeenUtc: string;
  readonly lastSeenUtc: string;
}

export interface ReadGapsResponse {
  readonly gaps: readonly AccountingGapRow[];
  readonly nextCursor?: string;
}
