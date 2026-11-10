/**
 * FR-R6-F11 (FR-003; data-model "Cursor") — the opaque page cursor.
 *
 * A cursor is the base64url of `{"v":1,"r":reportId,"d":digest16,"o":offset}`, at most 256
 * characters. It resolves only when the text is canonical base64url of JSON with exactly those
 * keys, `r` is a live report (otherwise `expired`), `d` is that report's query digest prefix, and
 * `o` is an integer offset of one of its rows. Every other defect is `invalid-cursor`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { MAX_CURSOR_CHARS } from '../../contracts/reporting/report-query';
import { reportExpired, reportOk, reportRefused, type ReportResult } from '../../contracts/reporting/report-outcomes';
import { DIMENSION_VALUE_PATTERNS } from '../../contracts/usage-accounting/query-contract';

const CURSOR_VERSION = 1;
const DIGEST_PREFIX_CHARS = 16;
const CURSOR_KEYS: readonly string[] = ['v', 'r', 'd', 'o'];
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DIGEST_PREFIX = /^[0-9a-f]{16}$/;

/** What a cursor is checked against: the live report it names. */
export interface CursorTarget {
  readonly queryDigest: string;
  readonly rowCount: number;
}

export interface ResolvedCursor {
  readonly reportId: string;
  readonly offset: number;
}

interface DecodedCursor {
  readonly reportId: string;
  readonly digestPrefix: string;
  readonly offset: number;
}

const INVALID = reportRefused('invalid-cursor');

/** Encodes the cursor of the page starting at `offset`. */
export function encodeReportCursor(reportId: string, queryDigest: string, offset: number): string {
  const json = JSON.stringify({ v: CURSOR_VERSION, r: reportId, d: queryDigest.slice(0, DIGEST_PREFIX_CHARS), o: offset });
  const cursor = Buffer.from(json, 'utf8').toString('base64url');
  if (cursor.length > MAX_CURSOR_CHARS) {
    throw new RangeError('report cursor exceeds its length bound');
  }
  return cursor;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function decode(input: unknown): DecodedCursor | undefined {
  if (typeof input !== 'string' || input.length > MAX_CURSOR_CHARS || !BASE64URL.test(input)) {
    return undefined;
  }
  const bytes = Buffer.from(input, 'base64url');
  if (bytes.toString('base64url') !== input) {
    return undefined;
  }
  const value = parseJson(bytes.toString('utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== CURSOR_KEYS.length || !keys.every((key) => CURSOR_KEYS.includes(key))) {
    return undefined;
  }
  const { v, r, d, o } = record;
  const wellFormed =
    v === CURSOR_VERSION &&
    typeof r === 'string' &&
    DIMENSION_VALUE_PATTERNS.identifier.test(r) &&
    typeof d === 'string' &&
    DIGEST_PREFIX.test(d) &&
    typeof o === 'number' &&
    Number.isSafeInteger(o) &&
    o >= 0;
  return wellFormed ? { reportId: r, digestPrefix: d, offset: o } : undefined;
}

/** Resolves a cursor against the live reports `lookup` knows. */
export function resolveReportCursor(
  input: unknown,
  lookup: (reportId: string) => CursorTarget | undefined
): ReportResult<ResolvedCursor> {
  const decoded = decode(input);
  if (decoded === undefined) {
    return INVALID;
  }
  const target = lookup(decoded.reportId);
  if (target === undefined) {
    return reportExpired();
  }
  if (target.queryDigest.slice(0, DIGEST_PREFIX_CHARS) !== decoded.digestPrefix || decoded.offset >= target.rowCount) {
    return INVALID;
  }
  return reportOk({ reportId: decoded.reportId, offset: decoded.offset });
}
