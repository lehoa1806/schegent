/**
 * FR-R6-F11 (FR-006, FR-010, FR-023; research R2) — the usage view, delegated to F06.
 *
 * The view reads every F06 page at one revision: the first page fixes it (or the caller passes a
 * captured one), and every later page passes it as `asOfRevision`. The engine never adds,
 * multiplies or converts a measure: each row's measures are F06's, copied as they are. Rows are
 * re-ordered by the code-point order of their key values, in grouping order.
 *
 * F06 refusals map to report outcomes: a compacted revision fails
 * `accounting-revision-unavailable`, a missing store is `accounting-unavailable`, the deadline and
 * response bound end `limited`, and any other refusal fails `source-read-failed`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { ReportQuery } from '../../contracts/reporting/report-query';
import {
  reportCancelled,
  reportFailed,
  reportLimited,
  reportOk,
  reportRefused,
  type ReportFailure,
  type ReportResult
} from '../../contracts/reporting/report-outcomes';
import type { LegacyUsageSummary, UsageRow } from '../../contracts/reporting/report-rows';
import type { AccountingRefusal, AccountingResult } from '../../contracts/usage-accounting/accounting-types';
import {
  MAX_QUERY_LIMIT,
  type AccountingDimension,
  type AccountingQueryRequest,
  type AccountingQueryResponse,
  type AccountingRow
} from '../../contracts/usage-accounting/query-contract';
import { compareCodePoints } from './report-aggregates';
import { toUtcIso } from './report-time';

/** The F06 read the usage view needs; `UsageAccountingService` satisfies it. */
export interface AccountingPort {
  query(request: AccountingQueryRequest & { readonly limit: number }, signal?: AbortSignal): AccountingResult<AccountingQueryResponse>;
}

/** The usage dimensions a report may group by (VIEW_SHAPES.usage). */
export type UsageDimension = Extract<AccountingDimension, 'backend' | 'model' | 'utcDay'>;

export interface UsageRequest {
  /** The usage view groups by `UsageDimension`s; drill-down also by `attemptOutcome`. */
  readonly groupBy: readonly AccountingDimension[];
  /** UTC instant, inclusive, over F06 event time. */
  readonly from?: string;
  /** UTC instant, exclusive. */
  readonly to?: string;
  readonly backend?: string;
  readonly model?: string;
  readonly rootIds?: readonly string[];
  /** The captured revision; absent means the first page fixes it. */
  readonly asOfRevision?: number;
}

export interface UsageReadOptions {
  /** The most rows the snapshot may hold. */
  readonly cap: number;
  readonly signal?: AbortSignal;
  /** F06 rows per request; tests only. */
  readonly pageLimit?: number;
}

export interface UsageSnapshot {
  readonly revision: number;
  readonly calculationVersion: number;
  readonly rows: readonly UsageRow[];
  readonly unattributed: number;
  readonly gaps: readonly { readonly kind: string; readonly count: number }[];
  readonly legacy?: LegacyUsageSummary;
}

/** Maps a validated usage-view query to the F06 request it delegates to. */
export function usageRequestOf(query: ReportQuery): UsageRequest {
  const backend = query.filters.backend?.at(0);
  const model = query.filters.model?.at(0);
  const rootIds = query.filters.rootId;
  return {
    groupBy: query.groupBy as readonly UsageDimension[],
    from: toUtcIso(query.range.startMs),
    to: toUtcIso(query.range.endMs),
    ...(backend !== undefined ? { backend } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(rootIds !== undefined ? { rootIds } : {})
  };
}

function failureOf(refusal: AccountingRefusal, signal: AbortSignal | undefined): ReportFailure {
  if (signal?.aborted === true) {
    return reportCancelled();
  }
  switch (refusal.code) {
    case 'revision-compacted':
      return reportFailed('accounting-revision-unavailable');
    case 'store-unavailable':
      return reportRefused('accounting-unavailable');
    case 'deadline-exceeded':
      return reportLimited('deadline-exceeded');
    case 'response-too-large':
      return reportLimited('working-data');
    default:
      return reportFailed('source-read-failed');
  }
}

function filtersOf(request: UsageRequest): Partial<Record<AccountingDimension, string>> | undefined {
  const filters: Partial<Record<AccountingDimension, string>> = {
    ...(request.backend !== undefined ? { backend: request.backend } : {}),
    ...(request.model !== undefined ? { model: request.model } : {})
  };
  return Object.keys(filters).length === 0 ? undefined : filters;
}

function pageRequest(
  request: UsageRequest,
  limit: number,
  revision: number | undefined,
  cursor: string | undefined
): AccountingQueryRequest & { readonly limit: number } {
  const filters = filtersOf(request);
  return {
    groupBy: request.groupBy,
    ...(request.from !== undefined ? { from: request.from } : {}),
    ...(request.to !== undefined ? { to: request.to } : {}),
    ...(filters !== undefined ? { filters } : {}),
    ...(revision !== undefined ? { asOfRevision: revision } : {}),
    includeLegacy: true,
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(request.rootIds !== undefined ? { rootIds: request.rootIds } : {})
  };
}

function keyValues(row: UsageRow, groupBy: readonly AccountingDimension[]): string {
  return JSON.stringify(groupBy.map((dimension) => row.key[dimension] ?? null));
}

function usageRowOf(row: AccountingRow, groupBy: readonly AccountingDimension[]): UsageRow {
  const key: Record<string, string | null> = {};
  for (const dimension of groupBy) {
    key[dimension] = row.key[dimension] ?? null;
  }
  return Object.freeze({
    kind: 'usage',
    key: Object.freeze(key),
    attempts: row.attempts,
    roots: row.roots,
    measures: row.measures,
    invocations: 'not-recorded'
  });
}

function legacyOf(response: AccountingQueryResponse): LegacyUsageSummary | undefined {
  if (response.legacy === undefined) {
    return undefined;
  }
  return Object.freeze({ runCount: response.legacy.runCount, costMicros: response.legacy.costMicros, detail: 'unavailable' });
}

function snapshotOf(response: AccountingQueryResponse, revision: number, rows: readonly UsageRow[]): UsageSnapshot {
  const legacy = legacyOf(response);
  return Object.freeze({
    revision,
    calculationVersion: response.calculationVersion,
    rows: Object.freeze(rows),
    unattributed: response.unattributedCount,
    gaps: response.gaps,
    ...(legacy !== undefined ? { legacy } : {})
  });
}

/**
 * Revision 0 is an accounting store with nothing committed: it holds no rows by definition, and
 * F06 refuses it as `asOfRevision`. One ungrouped read at the latest revision supplies the fields
 * F06 does not pin to a revision (calculation version, unattributed count, gaps, legacy summary);
 * its rows are dropped, so a later commit never reaches a report captured at revision 0.
 */
function readRevisionZero(port: AccountingPort, request: UsageRequest, signal: AbortSignal | undefined): ReportResult<UsageSnapshot> {
  const page = port.query(pageRequest({ ...request, groupBy: [] }, 1, undefined, undefined), signal);
  if (!page.ok) {
    return failureOf(page.refusal, signal);
  }
  return reportOk(snapshotOf(page.value, 0, []));
}

/** Reads every F06 page of `request` at one revision into a bounded, key-ordered snapshot. */
export function readUsage(
  port: AccountingPort | null,
  request: UsageRequest,
  options: UsageReadOptions
): ReportResult<UsageSnapshot> {
  if (port === null) {
    return reportRefused('accounting-unavailable');
  }
  // A call, so the check inside the loop is not narrowed away by this one.
  const aborted = (): boolean => options.signal?.aborted === true;
  if (aborted()) {
    return reportCancelled();
  }
  if (request.asOfRevision === 0) {
    return readRevisionZero(port, request, options.signal);
  }
  const limit = Math.min(options.pageLimit ?? MAX_QUERY_LIMIT, MAX_QUERY_LIMIT);
  const rows: UsageRow[] = [];
  let revision = request.asOfRevision;
  let cursor: string | undefined;
  let last: AccountingQueryResponse | undefined;
  do {
    if (aborted()) {
      return reportCancelled();
    }
    const page = port.query(pageRequest(request, limit, revision, cursor), options.signal);
    if (!page.ok) {
      return failureOf(page.refusal, options.signal);
    }
    last = page.value;
    revision = page.value.revision;
    rows.push(...page.value.rows.map((row) => usageRowOf(row, request.groupBy)));
    if (rows.length > options.cap) {
      return reportLimited('snapshot-rows');
    }
    cursor = request.groupBy.length === 0 ? undefined : page.value.nextCursor;
  } while (cursor !== undefined);

  rows.sort((left, right) => compareCodePoints(keyValues(left, request.groupBy), keyValues(right, request.groupBy)));
  return reportOk(snapshotOf(last, last.revision, rows));
}
