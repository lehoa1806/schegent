// FR-R4-F02 (spec 240, US3; contract S1 G1 to G3; data-model §6; FR-027) — one validated reader of
// the usage a `phase-end` row carries.
//
// At `5d700407` three readers each read the usage keys their own way, and the spend bound's read
// the flat keys only, while the writer's projection nests them under `metrics`. A bound read the
// FLAT key, found nothing, and reported every real run "unmeasurable" without ever pausing one.
// This reader reads nested first and flat second, keeps ABSENT apart from ZERO, rejects numbers
// that cannot be usage, and invents nothing: no price table, no conversion, no default 0.
import { describe, expect, it } from 'vitest';
import {
  readPhaseEndUsage,
  totalTokens,
  type PhaseEndUsage,
  type UsageValue
} from '../../../src/services/usage-reader';

const present = (value: number): UsageValue => ({ kind: 'present', value });
const ABSENT: UsageValue = { kind: 'absent' };
const REJECTED: UsageValue = { kind: 'rejected' };

const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens'
] as const;

describe('readPhaseEndUsage — where a value is read from (G1)', () => {
  it('reads the nested metrics object', () => {
    const usage = readPhaseEndUsage({ metrics: { totalCostUsd: 1.5, inputTokens: 100, outputTokens: 20 } });
    expect(usage.costUsd).toEqual(present(1.5));
    expect(usage.inputTokens).toEqual(present(100));
    expect(usage.outputTokens).toEqual(present(20));
    expect(usage.cacheCreationInputTokens).toEqual(ABSENT);
    expect(usage.cacheReadInputTokens).toEqual(ABSENT);
  });

  it('falls back to the flat legacy keys', () => {
    const usage = readPhaseEndUsage({ totalCostUsd: 2, inputTokens: 7, cacheReadInputTokens: 3 });
    expect(usage.costUsd).toEqual(present(2));
    expect(usage.inputTokens).toEqual(present(7));
    expect(usage.cacheReadInputTokens).toEqual(present(3));
  });

  it('reads each field on its own: nested for one, flat for another', () => {
    const usage = readPhaseEndUsage({ metrics: { totalCostUsd: 1 }, inputTokens: 9 });
    expect(usage.costUsd).toEqual(present(1));
    expect(usage.inputTokens).toEqual(present(9));
  });

  it('nested wins when both hold a number', () => {
    const usage = readPhaseEndUsage({ metrics: { totalCostUsd: 2, inputTokens: 10 }, totalCostUsd: 5, inputTokens: 99 });
    expect(usage.costUsd).toEqual(present(2));
    expect(usage.inputTokens).toEqual(present(10));
  });

  it('a nested number that is rejected still wins over a valid flat one: nested decides, never falls through', () => {
    const usage = readPhaseEndUsage({ metrics: { totalCostUsd: -1 }, totalCostUsd: 3 });
    expect(usage.costUsd).toEqual(REJECTED);
  });

  it('a nested value that is not a number lets the flat one answer', () => {
    const usage = readPhaseEndUsage({ metrics: { totalCostUsd: '4' }, totalCostUsd: 3 });
    expect(usage.costUsd).toEqual(present(3));
  });

  it('a metrics value that is not an object is ignored', () => {
    expect(readPhaseEndUsage({ metrics: 'oops', totalCostUsd: 3 }).costUsd).toEqual(present(3));
    expect(readPhaseEndUsage({ metrics: null, totalCostUsd: 3 }).costUsd).toEqual(present(3));
    expect(readPhaseEndUsage({ metrics: [1, 2], totalCostUsd: 3 }).costUsd).toEqual(present(3));
  });
});

describe('readPhaseEndUsage — absent is not zero, and bad numbers are rejected (G1, G3)', () => {
  it('a missing field is absent, and nothing is invented for it', () => {
    const usage = readPhaseEndUsage({});
    for (const value of Object.values(usage)) expect(value).toEqual(ABSENT);
  });

  it('zero is present zero, a known amount and not a missing one', () => {
    const usage = readPhaseEndUsage({ metrics: { totalCostUsd: 0, inputTokens: 0 } });
    expect(usage.costUsd).toEqual(present(0));
    expect(usage.inputTokens).toEqual(present(0));
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY]
  ])('a %s number is rejected', (_name, value) => {
    expect(readPhaseEndUsage({ metrics: { totalCostUsd: value } }).costUsd).toEqual(REJECTED);
    expect(readPhaseEndUsage({ inputTokens: value }).inputTokens).toEqual(REJECTED);
  });

  it.each([
    ['a numeric string', '12'],
    ['a boolean', true],
    ['null', null],
    ['an object', { value: 1 }],
    ['an array', [1]]
  ])('%s is absent, not coerced', (_name, value) => {
    expect(readPhaseEndUsage({ totalCostUsd: value }).costUsd).toEqual(ABSENT);
    expect(readPhaseEndUsage({ metrics: { outputTokens: value } }).outputTokens).toEqual(ABSENT);
  });

  it('a costless cap-exhaustion addendum yields nothing present', () => {
    const usage = readPhaseEndUsage({ outcome: 'failed', cause: 'cap_exhausted', metrics: {} });
    for (const value of Object.values(usage)) expect(value).toEqual(ABSENT);
    expect(totalTokens(usage)).toBeUndefined();
  });
});

describe('totalTokens (G2)', () => {
  it('sums the present token fields', () => {
    const usage = readPhaseEndUsage({
      metrics: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 5, cacheReadInputTokens: 1 }
    });
    expect(totalTokens(usage)).toBe(126);
  });

  it('is undefined when no token field is present, never 0', () => {
    expect(totalTokens(readPhaseEndUsage({ metrics: { totalCostUsd: 3 } }))).toBeUndefined();
    expect(totalTokens(readPhaseEndUsage({}))).toBeUndefined();
  });

  it('counts a present zero as present: the total is 0, not undefined', () => {
    expect(totalTokens(readPhaseEndUsage({ metrics: { inputTokens: 0 } }))).toBe(0);
  });

  it('a rejected field contributes nothing and does not make the others unusable', () => {
    const usage = readPhaseEndUsage({ metrics: { inputTokens: 10, outputTokens: -5 } });
    expect(usage.outputTokens).toEqual(REJECTED);
    expect(totalTokens(usage)).toBe(10);
  });

  it('is undefined when the only token fields are rejected', () => {
    expect(totalTokens(readPhaseEndUsage({ metrics: { inputTokens: Number.NaN } }))).toBeUndefined();
  });

  it('covers exactly the four token fields', () => {
    const usage: PhaseEndUsage = readPhaseEndUsage(
      Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 1]))
    );
    expect(totalTokens(usage)).toBe(TOKEN_FIELDS.length);
  });
});
