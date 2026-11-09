import { CMD_READ_USAGE_ACCOUNTING, type ReadUsageAccountingResponse, type SidebarCommand } from '../sidebar-ipc';
import {
  ACCOUNTING_REFUSAL_CODES,
  ATTEMPT_OUTCOMES,
  MEASURES,
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
  type AccountingDimension,
  type AccountingQueryRequest,
  type ReadGapsRequest
} from '../usage-accounting/query-contract';
import { type IpcValidationResult, fail, hasUnexpectedKeys, ok as ipcOk } from './shared';

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
  'cursor'
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

function isCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_QUERY_CURSOR_CHARS;
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
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {})
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

const READ_COMMAND_KEYS = ['query'] as const;

/**
 * The sidebar's accounting read envelope: a `query` and nothing else. The query itself is left
 * to the shared validator on the host, so an invalid query gets the same `invalid-query` result
 * the headless API returns (clarification 6), not an envelope rejection.
 */
export function validateReadUsageAccounting(obj: Plain, correlationId: string): IpcValidationResult {
  const context = { type: CMD_READ_USAGE_ACCOUNTING, correlationId };
  const payload = obj['payload'];
  if (!isPlain(payload)) return fail('missing-payload', context);
  if (hasUnexpectedKeys(payload, READ_COMMAND_KEYS)) return fail('unexpected-payload-fields', context);
  if (!Object.hasOwn(payload, 'query')) return fail('missing-query', context);
  return ipcOk({ ...context, payload: { query: payload['query'] } } as SidebarCommand);
}

function isCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The webview's gate before it reads an accounting answer: the result envelope, a known refusal
 * code, and the page fields a reader relies on. Anything else becomes the helper's failure.
 */
export function isValidReadUsageAccountingResponse(value: unknown): value is ReadUsageAccountingResponse {
  if (!isPlain(value)) return false;
  if (value['ok'] === true) {
    const page = value['value'];
    if (!isPlain(page)) return false;
    const next = page['nextCursor'];
    return (
      isCount(page['revision']) &&
      isCount(page['cutoffIngestSeq']) &&
      isCount(page['unattributedCount']) &&
      Array.isArray(page['rows']) &&
      Array.isArray(page['gaps']) &&
      (next === undefined || typeof next === 'string')
    );
  }
  if (value['ok'] !== false || !isPlain(value['refusal'])) return false;
  const { code, detail } = value['refusal'];
  return (
    typeof code === 'string' &&
    (ACCOUNTING_REFUSAL_CODES as readonly string[]).includes(code) &&
    (detail === undefined || typeof detail === 'string')
  );
}
