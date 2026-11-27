/**
 * FR-R6-F06 (T010, FR-003, FR-004, NFR-005) — exact counts and money, never a float.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_EXACT_QUANTITY,
  formatMicros,
  isCreditUnit,
  isCurrencyCode,
  parseCount,
  parseDecimalMicros,
  parseSumText
} from '../../../src/services/usage-accounting/exact-quantities';

const TWO_POW_63 = 2n ** 63n;

describe('exact quantities (T010)', () => {
  it('accepts counts from 0 to 2^63 - 1 in every input form', () => {
    expect(parseCount(0)).toBe(0n);
    expect(parseCount('0')).toBe(0n);
    expect(parseCount(TWO_POW_63 - 1n)).toBe(MAX_EXACT_QUANTITY);
    expect(parseCount((TWO_POW_63 - 1n).toString())).toBe(MAX_EXACT_QUANTITY);
    expect(parseCount(1234)).toBe(1234n);
  });

  it.each([
    ['-1', -1],
    ['1.5', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['2^63', TWO_POW_63],
    ['2^63 as text', TWO_POW_63.toString()],
    ['negative bigint', -3n],
    ['text with a sign', '+4'],
    ['text with a fraction', '4.0'],
    ['an unsafe float', 2 ** 60],
    ['a boolean', true],
    ['an empty string', '']
  ])('refuses %s', (_label, value) => {
    expect(parseCount(value)).toBeUndefined();
  });

  it('converts money text to micro-units and keeps the reported scale', () => {
    expect(parseDecimalMicros('0.000001')).toEqual({ micros: 1n, reportedScale: 6 });
    expect(parseDecimalMicros('12.5')).toEqual({ micros: 12_500_000n, reportedScale: 1 });
    expect(parseDecimalMicros('7')).toEqual({ micros: 7_000_000n, reportedScale: 0 });
  });

  it.each(['1.0000001', '-1', '1e3', '', ' 1', '1.', '.5'])('refuses money text %j', (text) => {
    expect(parseDecimalMicros(text)).toBeUndefined();
  });

  it('refuses money whose micro-units exceed 2^63 - 1', () => {
    expect(parseDecimalMicros('9223372036854.775807')).toEqual({ micros: MAX_EXACT_QUANTITY, reportedScale: 6 });
    expect(parseDecimalMicros('9223372036854.775808')).toBeUndefined();
  });

  it('validates currency codes and credit units', () => {
    expect(isCurrencyCode('USD')).toBe(true);
    for (const bad of ['usd', 'US', 'USDT', 'U$D', '']) expect(isCurrencyCode(bad), bad).toBe(false);
    expect(isCreditUnit('acu')).toBe(true);
    expect(isCreditUnit('credits.v2')).toBe(true);
    for (const bad of ['Acu', '1acu', 'a b', '', 'a'.repeat(33)]) expect(isCreditUnit(bad), bad).toBe(false);
  });

  it('formats micro-units with six digits', () => {
    expect(formatMicros(12_500_000n)).toBe('12.500000');
    expect(formatMicros(1n)).toBe('0.000001');
    expect(formatMicros(0n)).toBe('0.000000');
    expect(formatMicros(MAX_EXACT_QUANTITY)).toBe('9223372036854.775807');
  });

  it('round-trips SQL sum text through BigInt', () => {
    expect(parseSumText('9223372036854775807')).toBe(MAX_EXACT_QUANTITY);
    expect(parseSumText(null)).toBe(0n);
    expect(parseSumText('42')).toBe(42n);
    expect(() => parseSumText('1.5e3')).toThrow(/not an exact integer/);
  });
});
