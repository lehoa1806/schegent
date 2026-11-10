/**
 * FR-R6-F11 (FR-001, FR-002, FR-004; data-model ReportQuery, research R3, R5) — the report query
 * validator and its canonical form.
 *
 * Every level is an exact key set, checked before any read. A filter or grouping dimension that
 * exists but that the view does not carry is `unsupported-dimension`; every other defect is
 * `invalid-query`. The refusal never echoes a value.
 *
 * Defaults: the 30 days ending at query start, the host zone, page size 50, the view's default
 * grouping, and the first sort of the view's row or group sorts. In the canonical form filter
 * values are sorted (every value grammar is ASCII, so code-unit order is code-point order), keys
 * are in a fixed order, and absent filters are omitted. `queryDigest` hashes that text.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash } from 'node:crypto';
import {
  DAY_MS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_RANGE_DAYS,
  MAX_FILTER_VALUES,
  MAX_GROUP_BY,
  MAX_PAGE_SIZE,
  MAX_RANGE_DAYS,
  REPORT_DIMENSIONS,
  REPORT_FILTER_KEYS,
  REPORT_VIEWS,
  RUN_OUTCOMES,
  SINGLE_VALUE_FILTERS,
  VIEW_SHAPES,
  type ReportDimension,
  type ReportFilterKey,
  type ReportFilters,
  type ReportQuery,
  type ReportRange,
  type ReportSort,
  type ReportView,
  type ViewShape
} from '../../contracts/reporting/report-query';
import { reportOk, reportRefused, type ReportFailure, type ReportResult } from '../../contracts/reporting/report-outcomes';
import { DIMENSION_VALUE_PATTERNS } from '../../contracts/usage-accounting/query-contract';
import { resolveTimezone } from './report-time';

/** What the validator needs from its host: the query-start clock and the host zone. */
export interface ReportQueryContext {
  readonly nowMs: number;
  readonly hostTimezone: string;
}

/** The keys a report query may carry; the headless port checks them before delegating. */
export const QUERY_KEYS: readonly string[] = ['view', 'range', 'timezone', 'filters', 'groupBy', 'sort', 'pageSize'];
const RANGE_KEYS: readonly string[] = ['startMs', 'endMs'];
/** The last instant a JavaScript date can hold; a later range bound could not be written as UTC. */
const MAX_DATE_MS = 8_640_000_000_000_000;

const VALUE_CHECKS: Readonly<Record<ReportFilterKey, (value: string) => boolean>> = Object.freeze({
  rootId: (value) => DIMENSION_VALUE_PATTERNS.identifier.test(value),
  workflowId: (value) => DIMENSION_VALUE_PATTERNS.identifier.test(value),
  frozenDefinitionId: (value) => DIMENSION_VALUE_PATTERNS.identifier.test(value),
  outcome: (value) => (RUN_OUTCOMES as readonly string[]).includes(value),
  backend: (value) => DIMENSION_VALUE_PATTERNS.backend.test(value),
  model: (value) => DIMENSION_VALUE_PATTERNS.model.test(value)
});

type Plain = Record<string, unknown>;
type Checked<T> = { readonly ok: true; readonly value: T } | ReportFailure;

const INVALID = reportRefused('invalid-query');
const UNSUPPORTED = reportRefused('unsupported-dimension');

function isPlain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Plain, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isView(value: unknown): value is ReportView {
  return typeof value === 'string' && (REPORT_VIEWS as readonly string[]).includes(value);
}

function isMillis(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS;
}

function checkRange(input: unknown, nowMs: number): Checked<ReportRange> {
  if (input === undefined) {
    return reportOk({ startMs: nowMs - DEFAULT_RANGE_DAYS * DAY_MS, endMs: nowMs });
  }
  if (!isPlain(input) || !hasOnlyKeys(input, RANGE_KEYS)) {
    return INVALID;
  }
  const { startMs, endMs } = input;
  if (!isMillis(startMs) || !isMillis(endMs) || startMs >= endMs || endMs - startMs > MAX_RANGE_DAYS * DAY_MS) {
    return INVALID;
  }
  return reportOk({ startMs, endMs });
}

function checkFilterValues(key: ReportFilterKey, raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  if (SINGLE_VALUE_FILTERS.includes(key) && raw.length > 1) {
    return undefined;
  }
  const check = VALUE_CHECKS[key];
  const wellFormed = raw.every((value) => typeof value === 'string' && check(value));
  if (!wellFormed || new Set(raw).size !== raw.length) {
    return undefined;
  }
  return Object.freeze([...(raw as string[])].sort());
}

function checkFilters(input: unknown, shape: ViewShape): Checked<ReportFilters> {
  if (input === undefined) {
    return reportOk(Object.freeze({}));
  }
  if (!isPlain(input) || !hasOnlyKeys(input, REPORT_FILTER_KEYS)) {
    return INVALID;
  }
  const filters: Partial<Record<ReportFilterKey, readonly string[]>> = {};
  let total = 0;
  for (const key of REPORT_FILTER_KEYS) {
    const raw = input[key];
    if (raw === undefined) {
      continue;
    }
    if (!shape.filters.includes(key)) {
      return UNSUPPORTED;
    }
    const values = checkFilterValues(key, raw);
    if (values === undefined) {
      return INVALID;
    }
    total += values.length;
    filters[key] = values;
  }
  return total > MAX_FILTER_VALUES ? INVALID : reportOk(Object.freeze(filters));
}

function isDimension(value: unknown): value is ReportDimension {
  return typeof value === 'string' && (REPORT_DIMENSIONS as readonly string[]).includes(value);
}

function checkGroupBy(input: unknown, shape: ViewShape): Checked<readonly ReportDimension[]> {
  if (input === undefined) {
    return reportOk(Object.freeze([...shape.defaultGroupBy]));
  }
  if (!Array.isArray(input) || input.length > MAX_GROUP_BY || !input.every(isDimension)) {
    return INVALID;
  }
  if (new Set(input).size !== input.length) {
    return INVALID;
  }
  if (!input.every((dimension) => shape.optionalDimensions.includes(dimension))) {
    return UNSUPPORTED;
  }
  return reportOk(Object.freeze([...input]));
}

/** Root or attempt rows take the row sorts; any grouping takes the group sorts. */
function sortsFor(shape: ViewShape, groupBy: readonly ReportDimension[]): readonly ReportSort[] {
  const ungrouped = shape.fixedDimensions.length === 0 && groupBy.length === 0 && shape.rowSorts.length > 0;
  return ungrouped ? shape.rowSorts : shape.groupSorts;
}

function checkSort(input: unknown, sorts: readonly ReportSort[]): Checked<ReportSort> {
  const sort = input ?? sorts.at(0);
  if (typeof sort !== 'string' || !(sorts as readonly string[]).includes(sort)) {
    return INVALID;
  }
  return reportOk(sort as ReportSort);
}

function checkPageSize(input: unknown): Checked<number> {
  if (input === undefined) {
    return reportOk(DEFAULT_PAGE_SIZE);
  }
  const valid = typeof input === 'number' && Number.isInteger(input) && input >= 1 && input <= MAX_PAGE_SIZE;
  return valid ? reportOk(input) : INVALID;
}

function checkTimezone(input: unknown, hostTimezone: string): Checked<string> {
  const timezone = resolveTimezone(input ?? hostTimezone);
  return timezone === undefined ? INVALID : reportOk(timezone);
}

/** Validates a raw report request into its canonical, frozen form. */
export function validateReportQuery(input: unknown, context: ReportQueryContext): ReportResult<ReportQuery> {
  if (!isPlain(input) || !hasOnlyKeys(input, QUERY_KEYS) || !isView(input.view)) {
    return INVALID;
  }
  const shape = VIEW_SHAPES[input.view];
  const range = checkRange(input.range, context.nowMs);
  if (!range.ok) return range;
  const timezone = checkTimezone(input.timezone, context.hostTimezone);
  if (!timezone.ok) return timezone;
  const filters = checkFilters(input.filters, shape);
  if (!filters.ok) return filters;
  const groupBy = checkGroupBy(input.groupBy, shape);
  if (!groupBy.ok) return groupBy;
  const sort = checkSort(input.sort, sortsFor(shape, groupBy.value));
  if (!sort.ok) return sort;
  const pageSize = checkPageSize(input.pageSize);
  if (!pageSize.ok) return pageSize;
  return reportOk(
    Object.freeze({
      view: input.view,
      range: Object.freeze(range.value),
      timezone: timezone.value,
      filters: filters.value,
      groupBy: groupBy.value,
      sort: sort.value,
      pageSize: pageSize.value
    })
  );
}

/** The canonical JSON of a validated query: fixed key order, filters in key order, absent omitted. */
export function canonicalQueryJson(query: ReportQuery): string {
  const filters: Partial<Record<ReportFilterKey, readonly string[]>> = {};
  for (const key of REPORT_FILTER_KEYS) {
    const values = query.filters[key];
    if (values !== undefined) {
      filters[key] = values;
    }
  }
  return JSON.stringify({
    view: query.view,
    range: { startMs: query.range.startMs, endMs: query.range.endMs },
    timezone: query.timezone,
    filters,
    groupBy: query.groupBy,
    sort: query.sort,
    pageSize: query.pageSize
  });
}

/** The lowercase hex SHA-256 of the canonical JSON. */
export function queryDigest(query: ReportQuery): string {
  return createHash('sha256').update(canonicalQueryJson(query), 'utf8').digest('hex');
}
