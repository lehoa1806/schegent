import type { ReadUsageAccountingResponse } from '../sidebar-ipc';
import {
  ACCOUNTING_CALCULATION_VERSION,
  ACCOUNTING_POLICY_VERSION,
  ACCOUNTING_REFUSAL_CODES,
  ATTEMPT_OUTCOMES,
  COMPLETENESS_VALUES,
  COUNT_MEASURES,
  DEFAULT_ACCOUNTING_BOUNDS,
  GAP_KINDS,
  MEASURES,
  RECONCILIATIONS,
  type AccountingResult,
  type Measure
} from '../usage-accounting/accounting-types';
import {
  ACCOUNTING_DIMENSIONS,
  DEFAULT_QUERY_LIMIT,
  DIMENSION_VALUE_PATTERNS,
  MAX_GROUP_BY_DIMENSIONS,
  MAX_QUERY_CURSOR_CHARS,
  MAX_QUERY_LIMIT,
  MAX_QUERY_ROOT_IDS,
  MAX_REPORTED_GAP_KINDS,
  type AccountingDimension,
  type AccountingQueryRequest,
  type ReadGapsRequest
} from '../usage-accounting/query-contract';
import { hasUnexpectedKeys } from './shared';

// FR-R6-F06 (FR-022, contracts/accounting-service.md "Query request") — the one validator the
// headless accounting reader and the sidebar read share, so the two surfaces accept exactly the
// same requests. A refusal names the field, never the value. Node-free: the webview may bundle it.

type Plain = Record<string, unknown>;

const QUERY_KEYS = [
  'from',
  'to',
  'groupBy',
  'filters',
  'measures',
  'asOfRevision',
  'includeLegacy',
  'limit',
  'cursor',
  'rootIds'
] as const;
const GAP_KEYS = ['limit', 'cursor'] as const;
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/;

function invalid<T>(field: string): AccountingResult<T> {
  return { ok: false, refusal: { code: 'invalid-query', detail: field } };
}

function isPlain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A `Z` instant whose calendar fields survive a round trip, as millisecond ISO text; else `undefined`. */
function normalizeUtcInstant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = UTC_INSTANT.exec(value);
  if (match === null) return undefined;
  const parsed = new Date(Date.parse(value));
  if (Number.isNaN(parsed.getTime())) return undefined;
  const iso = parsed.toISOString();
  return iso.slice(0, 19) === value.slice(0, 19) ? iso : undefined;
}

function isValidDay(value: string): boolean {
  return DIMENSION_VALUE_PATTERNS.utcDay.test(value) && normalizeUtcInstant(`${value}T00:00:00Z`) !== undefined;
}

function isFilterValue(dimension: AccountingDimension, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  switch (dimension) {
    case 'backend':
      return DIMENSION_VALUE_PATTERNS.backend.test(value);
    case 'model':
      return DIMENSION_VALUE_PATTERNS.model.test(value);
    case 'workflowRevision':
    case 'phaseId':
      return DIMENSION_VALUE_PATTERNS.identifier.test(value);
    case 'attemptOutcome':
      return (ATTEMPT_OUTCOMES as readonly string[]).includes(value);
    case 'utcDay':
      return isValidDay(value);
  }
}

function isDimension(value: unknown): value is AccountingDimension {
  return typeof value === 'string' && (ACCOUNTING_DIMENSIONS as readonly string[]).includes(value);
}

function isLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_QUERY_LIMIT;
}

function hasControlChar(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_QUERY_CURSOR_CHARS && !hasControlChar(value);
}

function validateGroupBy(value: unknown): readonly AccountingDimension[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_GROUP_BY_DIMENSIONS) return undefined;
  if (!value.every(isDimension)) return undefined;
  return new Set(value).size === value.length ? value : undefined;
}

type FilterResult = { readonly filters: Partial<Record<AccountingDimension, string>> } | { readonly field: string };

function validateFilters(value: unknown): FilterResult {
  if (!isPlain(value)) return { field: 'filters' };
  if (hasUnexpectedKeys(value, ACCOUNTING_DIMENSIONS)) return { field: 'filters' };
  const filters: Partial<Record<AccountingDimension, string>> = {};
  for (const dimension of ACCOUNTING_DIMENSIONS) {
    const raw = value[dimension];
    if (raw === undefined) continue;
    if (!isFilterValue(dimension, raw)) return { field: `filters.${dimension}` };
    filters[dimension] = raw as string;
  }
  return { filters };
}

function validateMeasures(value: unknown): readonly Measure[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MEASURES.length) return undefined;
  const known = value.every((item) => typeof item === 'string' && (MEASURES as readonly string[]).includes(item));
  if (!known || new Set(value).size !== value.length) return undefined;
  return value as Measure[];
}

/** FR-R6-F11: 1..64 unique root ids, each an identifier; else `undefined`. */
function validateRootIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUERY_ROOT_IDS) return undefined;
  const wellFormed = value.every((item) => typeof item === 'string' && DIMENSION_VALUE_PATTERNS.identifier.test(item));
  if (!wellFormed || new Set(value).size !== value.length) return undefined;
  return value as string[];
}

/** Validates and normalizes a query request; `limit` is always present in the result. */
export function validateAccountingQueryRequest(
  input: unknown
): AccountingResult<AccountingQueryRequest & { readonly limit: number }> {
  if (!isPlain(input) || hasUnexpectedKeys(input, QUERY_KEYS)) return invalid('request');
  const groupBy = validateGroupBy(input.groupBy);
  if (groupBy === undefined) return invalid('groupBy');

  const from = input.from === undefined ? undefined : normalizeUtcInstant(input.from);
  if (input.from !== undefined && from === undefined) return invalid('from');
  const to = input.to === undefined ? undefined : normalizeUtcInstant(input.to);
  if (input.to !== undefined && to === undefined) return invalid('to');
  if (from !== undefined && to !== undefined && Date.parse(to) <= Date.parse(from)) return invalid('to');

  let filters: Partial<Record<AccountingDimension, string>> | undefined;
  if (input.filters !== undefined) {
    const checked = validateFilters(input.filters);
    if ('field' in checked) return invalid(checked.field);
    filters = checked.filters;
  }
  const measures = input.measures === undefined ? undefined : validateMeasures(input.measures);
  if (input.measures !== undefined && measures === undefined) return invalid('measures');

  const revision = input.asOfRevision;
  if (revision !== undefined && !(typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 1)) {
    return invalid('asOfRevision');
  }
  if (input.includeLegacy !== undefined && typeof input.includeLegacy !== 'boolean') return invalid('includeLegacy');
  if (input.limit !== undefined && !isLimit(input.limit)) return invalid('limit');
  if (input.cursor !== undefined && !isCursor(input.cursor)) return invalid('cursor');
  const rootIds = input.rootIds === undefined ? undefined : validateRootIds(input.rootIds);
  if (input.rootIds !== undefined && rootIds === undefined) return invalid('rootIds');

  return {
    ok: true,
    value: {
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      groupBy,
      ...(filters !== undefined ? { filters } : {}),
      ...(measures !== undefined ? { measures } : {}),
      ...(revision !== undefined ? { asOfRevision: revision } : {}),
      ...(input.includeLegacy !== undefined ? { includeLegacy: input.includeLegacy } : {}),
      limit: input.limit ?? DEFAULT_QUERY_LIMIT,
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(rootIds !== undefined ? { rootIds } : {})
    }
  };
}

/** Validates a gap read; an absent request reads the first page at the default limit. */
export function validateReadGapsRequest(input: unknown): AccountingResult<ReadGapsRequest & { readonly limit: number }> {
  const request = input ?? {};
  if (!isPlain(request) || hasUnexpectedKeys(request, GAP_KEYS)) return invalid('request');
  if (request.limit !== undefined && !isLimit(request.limit)) return invalid('limit');
  if (request.cursor !== undefined && !isCursor(request.cursor)) return invalid('cursor');
  return {
    ok: true,
    value: {
      limit: request.limit ?? DEFAULT_QUERY_LIMIT,
      ...(request.cursor !== undefined ? { cursor: request.cursor } : {})
    }
  };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const OK_ENVELOPE_KEYS = ['ok', 'value'] as const;
const REFUSAL_ENVELOPE_KEYS = ['ok', 'refusal'] as const;
const REFUSAL_KEYS = ['code', 'detail'] as const;
const PAGE_KEYS = [
  'revision',
  'cutoffIngestSeq',
  'policyVersion',
  'calculationVersion',
  'rows',
  'legacy',
  'unattributedCount',
  'gaps',
  'nextCursor'
] as const;
const ROW_KEYS = ['key', 'attempts', 'roots', 'measures', 'omittedUnitCount'] as const;
const MEASURE_KEYS = [
  'measure',
  'unit',
  'total',
  'reportedTotal',
  'estimatedTotal',
  'completeness',
  'coverage'
] as const;
const COVERAGE_KEYS = ['known', 'denominator'] as const;
const GAP_SUMMARY_KEYS = ['kind', 'count'] as const;
const LEGACY_KEYS = [
  'runCount',
  'costMicros',
  'boundaryRunId',
  'boundaryTerminalUtc',
  'reconciliation',
  'detail'
] as const;

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const CREDIT_UNIT_PATTERN = /^[a-z][a-z0-9._-]{0,31}$/;
const INTEGER_TEXT_PATTERN = /^\d{1,20}$/;
const MICRO_DECIMAL_TEXT_PATTERN = /^\d{1,20}\.\d{6}$/;
const REFUSAL_DETAIL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_LEGACY_RUN_ID_CHARS = 256;
const MAX_ROW_MEASURES = MEASURES.length * DEFAULT_ACCOUNTING_BOUNDS.maxUnitsPerRowMeasure;

function isValidResponseUnit(measure: Measure, unit: unknown): boolean {
  if (typeof unit !== 'string') return false;
  if (COUNT_MEASURES.has(measure)) return unit === 'count';
  return measure === 'cost' ? CURRENCY_CODE_PATTERN.test(unit) : CREDIT_UNIT_PATTERN.test(unit);
}

function isValidMeasureTotal(value: unknown): boolean {
  if (!isPlain(value) || hasUnexpectedKeys(value, MEASURE_KEYS)) return false;
  const measure = value['measure'];
  if (typeof measure !== 'string' || !(MEASURES as readonly string[]).includes(measure)) return false;
  const typedMeasure = measure as Measure;
  if (!isValidResponseUnit(typedMeasure, value['unit'])) return false;
  const total = value['total'];
  if (typeof total !== 'string') return false;
  if (COUNT_MEASURES.has(typedMeasure)) {
    if (!INTEGER_TEXT_PATTERN.test(total)) return false;
  } else if (!MICRO_DECIMAL_TEXT_PATTERN.test(total)) {
    return false;
  }
  const reportedTotal = value['reportedTotal'];
  if (reportedTotal !== undefined) {
    if (typedMeasure !== 'cost' || typeof reportedTotal !== 'string' || !MICRO_DECIMAL_TEXT_PATTERN.test(reportedTotal)) {
      return false;
    }
  }
  const estimatedTotal = value['estimatedTotal'];
  if (estimatedTotal !== undefined) {
    if (typedMeasure !== 'cost' || typeof estimatedTotal !== 'string' || !MICRO_DECIMAL_TEXT_PATTERN.test(estimatedTotal)) {
      return false;
    }
  }
  const completeness = value['completeness'];
  if (typeof completeness !== 'string' || !(COMPLETENESS_VALUES as readonly string[]).includes(completeness)) {
    return false;
  }
  const coverage = value['coverage'];
  if (!isPlain(coverage) || hasUnexpectedKeys(coverage, COVERAGE_KEYS)) return false;
  const known = coverage['known'];
  const denominator = coverage['denominator'];
  return isCount(known) && isCount(denominator) && known <= denominator;
}

function isValidRowKey(value: unknown): boolean {
  if (!isPlain(value) || hasUnexpectedKeys(value, ACCOUNTING_DIMENSIONS)) return false;
  const keys = Object.keys(value);
  if (keys.length > MAX_GROUP_BY_DIMENSIONS) return false;
  for (const key of keys) {
    const raw = value[key];
    if (raw !== null && !isFilterValue(key as AccountingDimension, raw)) return false;
  }
  return true;
}

function isValidAccountingRow(value: unknown): boolean {
  if (!isPlain(value) || hasUnexpectedKeys(value, ROW_KEYS)) return false;
  if (!isValidRowKey(value['key'])) return false;
  const attempts = value['attempts'];
  const roots = value['roots'];
  if (!isCount(attempts) || !isCount(roots) || roots > attempts) return false;
  const measures = value['measures'];
  if (!Array.isArray(measures) || measures.length > MAX_ROW_MEASURES || !measures.every(isValidMeasureTotal)) {
    return false;
  }
  const omittedUnitCount = value['omittedUnitCount'];
  if (omittedUnitCount !== undefined) {
    if (typeof omittedUnitCount !== 'number' || !Number.isSafeInteger(omittedUnitCount) || omittedUnitCount < 1) {
      return false;
    }
  }
  return true;
}

function isValidGapSummary(value: unknown): boolean {
  if (!isPlain(value) || hasUnexpectedKeys(value, GAP_SUMMARY_KEYS)) return false;
  const kind = value['kind'];
  return (
    typeof kind === 'string' &&
    (GAP_KINDS as readonly string[]).includes(kind) &&
    isCount(value['count'])
  );
}

function isValidLegacyEpochSummary(value: unknown): boolean {
  if (!isPlain(value) || hasUnexpectedKeys(value, LEGACY_KEYS)) return false;
  if (!isCount(value['runCount'])) return false;
  const costMicros = value['costMicros'];
  if (typeof costMicros !== 'string' || !INTEGER_TEXT_PATTERN.test(costMicros)) return false;
  const boundaryRunId = value['boundaryRunId'];
  if (
    boundaryRunId !== null &&
    (typeof boundaryRunId !== 'string' ||
      boundaryRunId.length === 0 ||
      boundaryRunId.length > MAX_LEGACY_RUN_ID_CHARS ||
      hasControlChar(boundaryRunId))
  ) {
    return false;
  }
  const boundaryTerminalUtc = value['boundaryTerminalUtc'];
  if (boundaryTerminalUtc !== null && normalizeUtcInstant(boundaryTerminalUtc) === undefined) return false;
  const reconciliation = value['reconciliation'];
  if (
    reconciliation !== null &&
    (typeof reconciliation !== 'string' || !(RECONCILIATIONS as readonly string[]).includes(reconciliation))
  ) {
    return false;
  }
  return value['detail'] === 'unavailable';
}

/**
 * The webview's gate before it reads an accounting answer: validates the envelope, versions,
 * bounded cursor, every row/measure/gap, optional legacy summary, or a known refusal. Anything
 * else becomes the helper's `store-unavailable` failure (FR-R7-16 / 16-06).
 */
export function isValidReadUsageAccountingResponse(value: unknown): value is ReadUsageAccountingResponse {
  if (!isPlain(value)) return false;
  if (value['ok'] === true) {
    if (hasUnexpectedKeys(value, OK_ENVELOPE_KEYS)) return false;
    const page = value['value'];
    if (!isPlain(page) || hasUnexpectedKeys(page, PAGE_KEYS)) return false;
    const next = page['nextCursor'];
    const legacy = page['legacy'];
    const rows = page['rows'];
    const gaps = page['gaps'];
    return (
      page['policyVersion'] === ACCOUNTING_POLICY_VERSION &&
      page['calculationVersion'] === ACCOUNTING_CALCULATION_VERSION &&
      isCount(page['revision']) &&
      isCount(page['cutoffIngestSeq']) &&
      isCount(page['unattributedCount']) &&
      (next === undefined || isCursor(next)) &&
      Array.isArray(rows) &&
      rows.length <= MAX_QUERY_LIMIT &&
      rows.every(isValidAccountingRow) &&
      Array.isArray(gaps) &&
      gaps.length <= MAX_REPORTED_GAP_KINDS &&
      gaps.every(isValidGapSummary) &&
      (legacy === undefined || isValidLegacyEpochSummary(legacy))
    );
  }
  if (value['ok'] !== false || hasUnexpectedKeys(value, REFUSAL_ENVELOPE_KEYS)) return false;
  const refusal = value['refusal'];
  if (!isPlain(refusal) || hasUnexpectedKeys(refusal, REFUSAL_KEYS)) return false;
  const { code, detail } = refusal;
  return (
    typeof code === 'string' &&
    (ACCOUNTING_REFUSAL_CODES as readonly string[]).includes(code) &&
    (detail === undefined || (typeof detail === 'string' && REFUSAL_DETAIL_PATTERN.test(detail)))
  );
}
