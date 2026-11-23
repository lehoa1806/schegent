/**
 * FR-R6-F06 (T027, FR-022, contracts/accounting-service.md "Query request") — the request
 * validator the headless API and the sidebar share.
 */
import { describe, expect, it } from 'vitest';
import {
  isValidReadUsageAccountingResponse,
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
    expect(refusedField({ groupBy: [], cursor: 'cur\n1' })).toBe('cursor');
    expect(refusedField({ groupBy: [], cursor: 'cur\u00001' })).toBe('cursor');
    expect(refusedField({ groupBy: [], cursor: 'cur\u007f1' })).toBe('cursor');
    expect(refusedField({ groupBy: [], cursor: 'cur\u00851' })).toBe('cursor');
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
    expect(validateReadGapsRequest({ cursor: 'bad\ncursor' })).toEqual({
      ok: false,
      refusal: { code: 'invalid-query', detail: 'cursor' }
    });
    expect(validateReadGapsRequest({ other: 1 })).toEqual({ ok: false, refusal: { code: 'invalid-query', detail: 'request' } });
  });
});

describe('accounting query rootIds (FR-R6-F11 T008)', () => {
  it('accepts 1..64 unique root ids and keeps them in the normalized request', () => {
    const result = validateAccountingQueryRequest({ groupBy: [], rootIds: ['r-1', 'r-2'] });
    expect(result).toEqual({ ok: true, value: { groupBy: [], rootIds: ['r-1', 'r-2'], limit: 50 } });
    const full = Array.from({ length: 64 }, (_, index) => `r-${String(index)}`);
    expect(refusedField({ groupBy: [], rootIds: full })).toBeUndefined();
  });

  it('refuses an empty, oversized, duplicated or malformed root id list', () => {
    const tooMany = Array.from({ length: 65 }, (_, index) => `r-${String(index)}`);
    expect(refusedField({ groupBy: [], rootIds: [] })).toBe('rootIds');
    expect(refusedField({ groupBy: [], rootIds: tooMany })).toBe('rootIds');
    expect(refusedField({ groupBy: [], rootIds: ['r-1', 'r-1'] })).toBe('rootIds');
    expect(refusedField({ groupBy: [], rootIds: ['has space'] })).toBe('rootIds');
    expect(refusedField({ groupBy: [], rootIds: [7] })).toBe('rootIds');
    expect(refusedField({ groupBy: [], rootIds: 'r-1' })).toBe('rootIds');
  });
});

describe('isValidReadUsageAccountingResponse (FR-R7-16 16-06)', () => {
  function validResponse() {
    return {
      ok: true,
      value: {
        revision: 4,
        cutoffIngestSeq: 9,
        policyVersion: 1,
        calculationVersion: 1,
        rows: [
          {
            key: { backend: 'claude', model: null },
            attempts: 3,
            roots: 2,
            measures: [
              {
                measure: 'input_tokens',
                unit: 'count',
                total: '420',
                completeness: 'known',
                coverage: { known: 3, denominator: 3 }
              },
              {
                measure: 'cost',
                unit: 'USD',
                total: '1.250000',
                reportedTotal: '1.250000',
                estimatedTotal: '0.000000',
                completeness: 'partial',
                coverage: { known: 2, denominator: 3 }
              },
              {
                measure: 'credits',
                unit: 'acme.credits',
                total: '3.500000',
                completeness: 'conflicting',
                coverage: { known: 1, denominator: 3 }
              }
            ],
            omittedUnitCount: 5
          }
        ],
        legacy: {
          runCount: 2,
          costMicros: '500000',
          boundaryRunId: 'run-legacy-2',
          boundaryTerminalUtc: '2026-11-09T20:00:00.000Z',
          reconciliation: 'matched',
          detail: 'unavailable'
        },
        unattributedCount: 1,
        gaps: [{ kind: 'ingest-failed', count: 2 }],
        nextCursor: `2~4~${'a'.repeat(32)}~claude~`
      }
    };
  }

  it('accepts valid responses and refusals', () => {
    expect(isValidReadUsageAccountingResponse(validResponse())).toBe(true);
    expect(isValidReadUsageAccountingResponse({ ok: false, refusal: { code: 'invalid-query', detail: 'cursor' } })).toBe(true);
    expect(
      isValidReadUsageAccountingResponse({ ok: false, refusal: { code: 'invalid-query', detail: 'filters.backend' } })
    ).toBe(true);
    expect(
      isValidReadUsageAccountingResponse({
        ok: false,
        refusal: { code: 'store-unavailable', detail: 'legacy-rollup-unreadable' }
      })
    ).toBe(true);
    expect(
      isValidReadUsageAccountingResponse({ ok: false, refusal: { code: 'invalid-counter', detail: 'input_tokens' } })
    ).toBe(true);
    expect(
      isValidReadUsageAccountingResponse({ ok: false, refusal: { code: 'invalid-query', detail: 'a'.repeat(64) } })
    ).toBe(true);
    expect(isValidReadUsageAccountingResponse({ ok: false, refusal: { code: 'store-unavailable' } })).toBe(true);

    // Exact upper bounds for rows (200), gaps (20), and measures (256) remain valid.
    const base = validResponse();
    const minimalRow = { key: {}, attempts: 1, roots: 1, measures: [] };
    const minimalMeasure = {
      measure: 'input_tokens',
      unit: 'count',
      total: '1',
      completeness: 'known',
      coverage: { known: 1, denominator: 1 }
    };
    expect(
      isValidReadUsageAccountingResponse({
        ok: true,
        value: {
          ...base.value,
          rows: Array.from({ length: 200 }, () => minimalRow),
          gaps: Array.from({ length: 20 }, () => ({ kind: 'ingest-failed', count: 1 }))
        }
      })
    ).toBe(true);
    expect(
      isValidReadUsageAccountingResponse({
        ok: true,
        value: {
          ...base.value,
          rows: [{ ...minimalRow, measures: Array.from({ length: 256 }, () => minimalMeasure) }]
        }
      })
    ).toBe(true);
  });

  it('rejects malformed versions, cursors, rows, measures, gaps, legacy summaries, and unexpected keys', () => {
    const base = validResponse();
    const minimalRow = { key: {}, attempts: 1, roots: 1, measures: [] };
    const minimalMeasure = {
      measure: 'input_tokens',
      unit: 'count',
      total: '1',
      completeness: 'known',
      coverage: { known: 1, denominator: 1 }
    };
    const cases: readonly unknown[] = [
      { ...base, extra: 1 },
      { ok: true, value: { ...base.value, policyVersion: 2 } },
      { ok: true, value: { ...base.value, calculationVersion: undefined } },
      { ok: true, value: { ...base.value, nextCursor: '' } },
      { ok: true, value: { ...base.value, nextCursor: 'a'.repeat(513) } },
      { ok: true, value: { ...base.value, nextCursor: `2~4~${'a'.repeat(32)}~claude\n` } },
      { ok: true, value: { ...base.value, nextCursor: `2~4~${'a'.repeat(32)}~claude\u0000` } },
      { ok: true, value: { ...base.value, nextCursor: `2~4~${'a'.repeat(32)}~claude\u007f` } },
      { ok: true, value: { ...base.value, nextCursor: `2~4~${'a'.repeat(32)}~claude\u009f` } },
      { ok: true, value: { ...base.value, rows: Array.from({ length: 201 }, () => minimalRow) } },
      { ok: true, value: { ...base.value, gaps: Array.from({ length: 21 }, () => ({ kind: 'ingest-failed', count: 1 })) } },
      {
        ok: true,
        value: {
          ...base.value,
          rows: [{ ...minimalRow, measures: Array.from({ length: 257 }, () => minimalMeasure) }]
        }
      },
      { ok: false, refusal: { code: 'invalid-query', detail: '' } },
      { ok: false, refusal: { code: 'invalid-query', detail: 'd'.repeat(65) } },
      { ok: false, refusal: { code: 'invalid-query', detail: 'cursor\n' } },
      { ok: false, refusal: { code: 'invalid-query', detail: 'cursor\u0000' } },
      { ok: false, refusal: { code: 'invalid-query', detail: 'bad detail' } },
      { ok: false, refusal: { code: 'invalid-query', detail: '../etc/passwd' } },
      { ok: false, refusal: { code: 'invalid-query', detail: '<script>' } },
      { ok: true, value: { ...base.value, rows: [{ ...base.value.rows[0], roots: 4 }] } },
      { ok: true, value: { ...base.value, rows: [{ ...base.value.rows[0], omittedUnitCount: 0 }] } },
      { ok: true, value: { ...base.value, rows: [{ ...base.value.rows[0], omittedUnitCount: 1.5 }] } },
      { ok: true, value: { ...base.value, rows: [{ ...base.value.rows[0], key: { utcDay: '2026-02-30' } }] } },
      {
        ok: true,
        value: {
          ...base.value,
          rows: [
            {
              ...base.value.rows[0],
              measures: [
                {
                  measure: 'cost',
                  unit: 'usd',
                  total: '1.000000',
                  completeness: 'known',
                  coverage: { known: 1, denominator: 1 }
                }
              ]
            }
          ]
        }
      },
      {
        ok: true,
        value: {
          ...base.value,
          rows: [
            {
              ...base.value.rows[0],
              measures: [
                {
                  measure: 'input_tokens',
                  unit: 'count',
                  total: '10',
                  reportedTotal: '0.000000',
                  completeness: 'known',
                  coverage: { known: 1, denominator: 1 }
                }
              ]
            }
          ]
        }
      },
      { ok: true, value: { ...base.value, gaps: [{ kind: 'bogus', count: 1 }] } },
      { ok: true, value: { ...base.value, gaps: [{ kind: 'ingest-failed', count: -1 }] } },
      { ok: true, value: { ...base.value, legacy: { ...base.value.legacy, reconciliation: 'other' } } },
      { ok: true, value: { ...base.value, legacy: { ...base.value.legacy, boundaryTerminalUtc: 'not-a-date' } } },
      { ok: true, value: { ...base.value, legacy: { ...base.value.legacy, boundaryRunId: 'bad\u0000id' } } }
    ];
    for (const candidate of cases) {
      expect(isValidReadUsageAccountingResponse(candidate)).toBe(false);
    }
  });
});
