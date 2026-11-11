// FR-R6-F14 T006 — the source-record boundary: what parses, what is refused, and what can
// never be queued because the shape does not name it (FR-003, FR-007, FR-008).
import { describe, expect, it } from 'vitest';

import { TELEMETRY_EXPORT_BOUNDS, type ExportSourceRecord } from '../../../src/contracts/telemetry-export';
import { parseSourceRecord } from '../../../src/services/telemetry-export/source-record';

const BASE = {
  sourceSchema: 1,
  sourceId: 'usage-0001',
  sourceRevision: 0,
  backend: 'claude',
  modelRequested: 'model-large',
  modelReported: 'model-large-20260101'
};

const MEASURE = {
  measure: 'input_tokens',
  quantity: '1024',
  unit: 'count',
  completeness: 'known',
  provenance: 'provider-reported',
  cacheRelation: null
};

const USAGE = { ...BASE, kind: 'usage', measures: [MEASURE] };
const OPERATION = { ...BASE, kind: 'operation', sourceId: 'attempt-0001', durationMs: 1500, outcome: 'succeeded' };
const CORRECTION = {
  ...BASE,
  kind: 'correction',
  sourceId: 'usage-0001',
  sourceRevision: 1,
  correction: { measure: 'output_tokens', unit: 'count', previousQuantity: '10', replacementQuantity: '12' }
};

function recordOf(value: unknown): ExportSourceRecord {
  const parsed = parseSourceRecord(value);
  if (parsed.kind !== 'record') throw new Error(`expected a record, got ${parsed.kind}`);
  return parsed.record;
}

function kindOf(value: unknown): string {
  return parseSourceRecord(value).kind;
}

describe('parseSourceRecord: what parses', () => {
  it('parses a usage record', () => {
    expect(recordOf(USAGE)).toEqual(USAGE);
  });

  it('parses an operation record', () => {
    expect(recordOf(OPERATION)).toEqual(OPERATION);
    expect(recordOf({ ...OPERATION, durationMs: null })).toMatchObject({ durationMs: null });
    expect(recordOf({ ...OPERATION, durationMs: 0.5 })).toMatchObject({ durationMs: 0.5 });
  });

  it('parses a correction record', () => {
    expect(recordOf(CORRECTION)).toEqual(CORRECTION);
    const unquantified = { ...CORRECTION, correction: { ...CORRECTION.correction, previousQuantity: null } };
    expect(recordOf(unquantified)).toEqual(unquantified);
  });

  it('reads absent models and an absent cache relation as null', () => {
    const withoutModels = { sourceSchema: 1, sourceId: 'usage-0001', sourceRevision: 0, backend: 'claude' };
    const withoutRelation = { measure: 'input_tokens', quantity: '1', unit: 'count', completeness: 'known', provenance: 'derived' };
    const record = recordOf({ ...withoutModels, kind: 'usage', measures: [withoutRelation] });
    expect(record).toMatchObject({ modelRequested: null, modelReported: null, measures: [{ cacheRelation: null }] });
  });

  it('accepts every measure with its unit, a null quantity and an empty measure list', () => {
    const measures = [
      { ...MEASURE, measure: 'output_tokens' },
      { ...MEASURE, measure: 'cache_read_tokens', cacheRelation: 'subset-of-input' },
      { ...MEASURE, measure: 'cache_creation_tokens', cacheRelation: 'disjoint' },
      { ...MEASURE, measure: 'cost', unit: 'USD', quantity: '1250000' },
      { ...MEASURE, measure: 'credits', unit: 'credits' },
      { ...MEASURE, measure: 'context_used' },
      { ...MEASURE, measure: 'context_size', quantity: null, completeness: 'unknown' }
    ];
    expect(recordOf({ ...USAGE, measures })).toMatchObject({ measures });
    expect(recordOf({ ...USAGE, measures: [] })).toMatchObject({ measures: [] });
  });

  it('accepts the longest decimal text and the largest measure count', () => {
    const nineteenDigits = '9'.repeat(19);
    expect(recordOf({ ...USAGE, measures: [{ ...MEASURE, quantity: nineteenDigits }] })).toMatchObject({
      measures: [{ quantity: nineteenDigits }]
    });
    const full = Array.from({ length: TELEMETRY_EXPORT_BOUNDS.measuresPerRecordMax }, () => MEASURE);
    expect(full).toHaveLength(16);
    expect(kindOf({ ...USAGE, measures: full })).toBe('record');
  });

  it('returns a frozen copy, not the value it was given', () => {
    const input = { ...USAGE, measures: [{ ...MEASURE }] };
    const record = recordOf(input);
    expect(record).not.toBe(input);
    expect(Object.isFrozen(record)).toBe(true);
    input.measures.splice(0, 1, { ...MEASURE, quantity: '7' });
    expect(record).toMatchObject({ measures: [{ quantity: '1024' }] });
  });
});

describe('parseSourceRecord: the schema', () => {
  it.each([0, 2, 99])('counts source schema %d as unsupported', (sourceSchema) => {
    expect(parseSourceRecord({ ...USAGE, sourceSchema })).toEqual({ kind: 'unsupported-schema' });
  });

  it('reports an unsupported schema even when the rest of the record would not parse', () => {
    expect(kindOf({ sourceSchema: 2, anything: true })).toBe('unsupported-schema');
  });

  it.each([undefined, null, '1', 1.5, Number.NaN])('refuses a schema of %s as invalid', (sourceSchema) => {
    expect(kindOf({ ...USAGE, sourceSchema })).toBe('invalid');
  });
});

describe('parseSourceRecord: what is refused', () => {
  it.each([[null], [undefined], [7], ['record'], [[]], [[USAGE]]])('refuses the non-record %j', (value) => {
    expect(kindOf(value)).toBe('invalid');
  });

  it.each([
    ['an unknown kind', { kind: 'trace' }],
    ['a missing kind', { kind: undefined }],
    ['an identifier with a space', { sourceId: 'usage 1' }],
    ['an identifier with a path separator', { sourceId: 'runs/usage-1' }],
    ['an identifier over 128 characters', { sourceId: 'a'.repeat(129) }],
    ['a negative revision', { sourceRevision: -1 }],
    ['a fractional revision', { sourceRevision: 0.5 }],
    ['a text revision', { sourceRevision: '0' }],
    ['a backend that is not text', { backend: 7 }],
    ['a missing backend', { backend: undefined }],
    ['a model that is not text', { modelRequested: 7 }],
    ['a reported model that is not text', { modelReported: {} }],
    ['measures that are not a list', { measures: MEASURE }],
    ['a measure that is not an object', { measures: ['input_tokens'] }]
  ])('refuses %s', (_label, overrides) => {
    expect(kindOf({ ...USAGE, ...overrides })).toBe('invalid');
  });

  it.each([
    ['a number', 1024],
    ['a negative number', '-1'],
    ['a decimal point', '1.5'],
    ['an exponent', '1e3'],
    ['a leading zero', '01'],
    ['a sign', '+1'],
    ['a space', ' 1'],
    ['an empty string', ''],
    ['twenty digits', '1'.repeat(20)],
    ['hexadecimal', '0x10'],
    ['an absent quantity', undefined]
  ])('refuses a quantity that is %s', (_label, quantity) => {
    expect(kindOf({ ...USAGE, measures: [{ ...MEASURE, quantity }] })).toBe('invalid');
  });

  it.each([
    ['an unknown measure', { measure: 'reasoning_tokens' }],
    ['an unknown completeness', { completeness: 'guessed' }],
    ['the completeness the ledger never offers', { completeness: 'conflicting' }],
    ['an unknown provenance', { provenance: 'invented' }],
    ['an unknown cache relation', { cacheRelation: 'overlapping' }],
    ['a token unit other than count', { unit: 'tokens' }],
    ['a cost unit that is not a currency code', { measure: 'cost', unit: 'usd' }],
    ['a cost unit of count', { measure: 'cost', unit: 'count' }],
    ['a credit unit with a space', { measure: 'credits', unit: 'my credits' }]
  ])('refuses a measure with %s', (_label, overrides) => {
    expect(kindOf({ ...USAGE, measures: [{ ...MEASURE, ...overrides }] })).toBe('invalid');
  });

  it('refuses more than 16 measures', () => {
    const tooMany = Array.from({ length: TELEMETRY_EXPORT_BOUNDS.measuresPerRecordMax + 1 }, () => MEASURE);
    expect(kindOf({ ...USAGE, measures: tooMany })).toBe('invalid');
  });

  it.each([
    ['a negative duration', { durationMs: -1 }],
    ['an infinite duration', { durationMs: Number.POSITIVE_INFINITY }],
    ['a duration that is not a number', { durationMs: Number.NaN }],
    ['a text duration', { durationMs: '1500' }],
    ['an absent duration', { durationMs: undefined }],
    ['an unknown outcome', { outcome: 'timed-out' }]
  ])('refuses an operation with %s', (_label, overrides) => {
    expect(kindOf({ ...OPERATION, ...overrides })).toBe('invalid');
  });

  it.each([
    ['no correction', { correction: undefined }],
    ['an unknown measure', { correction: { ...CORRECTION.correction, measure: 'reasoning_tokens' } }],
    ['a bad unit', { correction: { ...CORRECTION.correction, unit: 'tokens' } }],
    ['a signed quantity', { correction: { ...CORRECTION.correction, replacementQuantity: '-2' } }],
    ['an absent quantity', { correction: { ...CORRECTION.correction, previousQuantity: undefined } }]
  ])('refuses a correction with %s', (_label, overrides) => {
    expect(kindOf({ ...CORRECTION, ...overrides })).toBe('invalid');
  });

  it('never throws on a hostile value', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('getter');
        }
      }
    );
    expect(kindOf(hostile)).toBe('invalid');
  });
});

describe('parseSourceRecord: what the shape does not name', () => {
  const UNNAMED = {
    workspaceId: 'ws-marker',
    rootPath: '/Users/someone/project-marker',
    runId: 'run-marker',
    attemptId: 'attempt-marker',
    providerSessionId: 'session-marker',
    phaseId: 'phase-marker',
    workflowRevision: 'workflow-marker',
    prompt: 'prompt-marker',
    path: 'src/path-marker.ts',
    toolArguments: { command: 'argument-marker' }
  };

  it.each([
    ['usage', { ...USAGE, ...UNNAMED, measures: [{ ...MEASURE, note: 'measure-marker', path: 'x-marker' }] }],
    ['operation', { ...OPERATION, ...UNNAMED, error: { message: 'error-marker' } }],
    ['correction', { ...CORRECTION, ...UNNAMED, correction: { ...CORRECTION.correction, reason: 'reason-marker' } }]
  ])('drops every unnamed field of a %s record', (_kind, value) => {
    const record = recordOf(value);
    expect(JSON.stringify(record)).not.toContain('marker');
    for (const key of Object.keys(UNNAMED)) expect(record).not.toHaveProperty(key);
  });
});
