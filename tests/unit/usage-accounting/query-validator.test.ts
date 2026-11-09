/**
 * FR-R6-F06 (T027, FR-022, contracts/accounting-service.md "Query request") — the request
 * validator the headless API and the sidebar share.
 */
import { describe, expect, it } from 'vitest';
import {
  validateAccountingQueryRequest,
  validateReadGapsRequest
} from '../../../src/contracts/validators/usage-accounting';

function refusedField(input: unknown): string | undefined {
  const result = validateAccountingQueryRequest(input);
  if (result.ok) return undefined;
  expect(result.refusal.code).toBe('invalid-query');
  return result.refusal.detail;
}

describe('accounting query validator (T027)', () => {
  it('accepts a minimal request and applies the default limit', () => {
    const result = validateAccountingQueryRequest({ groupBy: [] });
    expect(result).toEqual({ ok: true, value: { groupBy: [], limit: 50 } });
  });

  it('accepts a full request and normalizes the instants to millisecond UTC', () => {
    const result = validateAccountingQueryRequest({
      from: '2026-11-01T00:00:00Z',
      to: '2026-11-02T00:00:00.000Z',
      groupBy: ['backend', 'model', 'utcDay'],
      filters: { backend: 'claude', attemptOutcome: 'succeeded', utcDay: '2026-11-01' },
      measures: ['input_tokens', 'cost'],
      asOfRevision: 3,
      includeLegacy: true,
      limit: 200,
      cursor: 'abc'
    });
    expect(result.ok && result.value.from).toBe('2026-11-01T00:00:00.000Z');
    expect(result.ok && result.value.limit).toBe(200);
  });

  it('requires to after from, both UTC instants', () => {
    expect(refusedField({ groupBy: [], from: '2026-11-02T00:00:00Z', to: '2026-11-02T00:00:00Z' })).toBe('to');
    expect(refusedField({ groupBy: [], from: '2026-11-02T00:00:00+02:00' })).toBe('from');
    expect(refusedField({ groupBy: [], to: 'yesterday' })).toBe('to');
    expect(refusedField({ groupBy: [], from: '2026-02-30T00:00:00Z' })).toBe('from');
  });

  it('allows 0..3 unique known groupBy dimensions', () => {
    expect(refusedField({ groupBy: ['backend', 'model', 'phaseId', 'utcDay'] })).toBe('groupBy');
    expect(refusedField({ groupBy: ['backend', 'backend'] })).toBe('groupBy');
    expect(refusedField({ groupBy: ['prompt'] })).toBe('groupBy');
    expect(refusedField({})).toBe('groupBy');
  });

  it('checks each filter value against its closed pattern', () => {
    expect(refusedField({ groupBy: [], filters: { model: 'gpt 4' } })).toBe('filters.model');
    expect(refusedField({ groupBy: [], filters: { phaseId: '../etc' } })).toBe('filters.phaseId');
    expect(refusedField({ groupBy: [], filters: { attemptOutcome: 'won' } })).toBe('filters.attemptOutcome');
    expect(refusedField({ groupBy: [], filters: { utcDay: '2026-11-1' } })).toBe('filters.utcDay');
    expect(refusedField({ groupBy: [], filters: { prompt: 'x' } })).toBe('filters');
    expect(refusedField({ groupBy: [], filters: { backend: 'b'.repeat(65) } })).toBe('filters.backend');
  });

  it('bounds limit, cursor, revision and measures, and refuses unknown keys', () => {
    expect(refusedField({ groupBy: [], limit: 201 })).toBe('limit');
    expect(refusedField({ groupBy: [], limit: 0 })).toBe('limit');
    expect(refusedField({ groupBy: [], limit: 1.5 })).toBe('limit');
    expect(refusedField({ groupBy: [], cursor: 'c'.repeat(513) })).toBe('cursor');
    expect(refusedField({ groupBy: [], asOfRevision: 0 })).toBe('asOfRevision');
    expect(refusedField({ groupBy: [], measures: ['dollars'] })).toBe('measures');
    expect(refusedField({ groupBy: [], includeLegacy: 'yes' })).toBe('includeLegacy');
    expect(refusedField({ groupBy: [], sql: 'DROP' })).toBe('request');
    expect(refusedField(null)).toBe('request');
  });
});

describe('gap read validator (T027)', () => {
  it('defaults the limit and bounds it', () => {
    expect(validateReadGapsRequest(undefined)).toEqual({ ok: true, value: { limit: 50 } });
    expect(validateReadGapsRequest({ limit: 200, cursor: 'x' })).toEqual({ ok: true, value: { limit: 200, cursor: 'x' } });
    expect(validateReadGapsRequest({ limit: 201 })).toEqual({ ok: false, refusal: { code: 'invalid-query', detail: 'limit' } });
    expect(validateReadGapsRequest({ other: 1 })).toEqual({ ok: false, refusal: { code: 'invalid-query', detail: 'request' } });
  });
});
