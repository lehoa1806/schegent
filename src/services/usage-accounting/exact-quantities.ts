/**
 * FR-R6-F06 (FR-003, FR-004, NFR-005, research R6) — exact counts and money.
 *
 * Counts are integers in 0..2^63 - 1. Money and credits are micro-units at a fixed scale of 6,
 * parsed from decimal text with the F02 `MONETARY_DECIMAL_PATTERN`. Nothing here goes through
 * a JavaScript float, so totals stay exact.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { MONETARY_DECIMAL_PATTERN } from '../../contracts/shared-memory-storage/identity-and-observations';

export const MAX_EXACT_QUANTITY = 2n ** 63n - 1n;
export const MONEY_SCALE = 6;

const MICROS_PER_UNIT = 10n ** BigInt(MONEY_SCALE);
const UNSIGNED_INTEGER_TEXT = /^\d{1,19}$/;
const SUM_TEXT = /^-?\d{1,20}$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;
const CREDIT_UNIT = /^[a-z][a-z0-9._-]{0,31}$/;

function inRange(value: bigint): bigint | undefined {
  return value >= 0n && value <= MAX_EXACT_QUANTITY ? value : undefined;
}

/** An exact count, or `undefined` for a negative, fractional, non-numeric or out-of-range value. */
export function parseCount(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return inRange(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return undefined;
    return inRange(BigInt(value));
  }
  if (typeof value === 'string' && UNSIGNED_INTEGER_TEXT.test(value)) return inRange(BigInt(value));
  return undefined;
}

export interface DecimalMicros {
  readonly micros: bigint;
  /** The fractional digits the source reported, 0..6, kept for display only. */
  readonly reportedScale: number;
}

/** Decimal money or credit text as micro-units, or `undefined` when it is not exact at scale 6. */
export function parseDecimalMicros(text: unknown): DecimalMicros | undefined {
  if (typeof text !== 'string' || !MONETARY_DECIMAL_PATTERN.test(text)) return undefined;
  const [whole = '0', fraction = ''] = text.split('.');
  const micros = BigInt(whole) * MICROS_PER_UNIT + BigInt(fraction.padEnd(MONEY_SCALE, '0'));
  const bounded = inRange(micros);
  return bounded === undefined ? undefined : { micros: bounded, reportedScale: fraction.length };
}

export function isCurrencyCode(unit: string): boolean {
  return CURRENCY_CODE.test(unit);
}

export function isCreditUnit(unit: string): boolean {
  return CREDIT_UNIT.test(unit);
}

/** Micro-units as decimal text with exactly six fractional digits. */
export function formatMicros(micros: bigint): string {
  const negative = micros < 0n;
  const magnitude = negative ? -micros : micros;
  const whole = magnitude / MICROS_PER_UNIT;
  const fraction = (magnitude % MICROS_PER_UNIT).toString().padStart(MONEY_SCALE, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

/**
 * The text of `CAST(SUM(quantity) AS TEXT)` as an exact integer. `NULL` (no rows) is zero.
 * Throws on anything else: SQLite raises its own error on integer overflow, so a non-integer
 * here means the query summed something other than an INTEGER column.
 */
export function parseSumText(text: string | null | undefined): bigint {
  if (text === null || text === undefined) return 0n;
  if (!SUM_TEXT.test(text)) throw new Error('sum is not an exact integer');
  return BigInt(text);
}
