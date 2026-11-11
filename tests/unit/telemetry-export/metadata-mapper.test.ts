// FR-R6-F14 T008 — mapping revision 1: one case per row of the per-measure table, the provider
// label, and the rule that no label leaves an instrument's allowlist (FR-003, FR-004, FR-006).
import { describe, expect, it } from 'vitest';

import { COVERAGE_OUTCOMES } from '../../../src/contracts/telemetry-export';
import { MEASURES } from '../../../src/contracts/usage-accounting/accounting-types';
import {
  ATTRIBUTE_KEYS,
  INSTRUMENT_IDS,
  MAPPING_REVISION_1,
  isMappedMeasure,
  providerNameOf
} from '../../../src/services/telemetry-export/mapping-revision';
import {
  createRecordMapper,
  mapRecord,
  type MappedObservation
} from '../../../src/services/telemetry-export/metadata-mapper';
import { correctionRecord, cost, measure, operationRecord, usageRecord } from '../../fixtures/telemetry-export/source-records';

const MAX_SAFE = '9007199254740991';
const OVER_MAX_SAFE = '9007199254740992';

function labelsOf(observation: MappedObservation | undefined): Record<string, string> {
  if (observation === undefined) throw new Error('expected an observation');
  return Object.fromEntries(observation.attributes);
}

function only(observations: readonly MappedObservation[]): MappedObservation {
  expect(observations).toHaveLength(1);
  const first = observations.at(0);
  if (first === undefined) throw new Error('expected one observation');
  return first;
}

describe('mapping revision 1: the definition', () => {
  it('names its revisions, protocol and temporality', () => {
    expect(MAPPING_REVISION_1).toMatchObject({
      mappingRevision: 1,
      sourceSchema: 1,
      semanticConventions: '1.37.0',
      protocolRevision: '1.7.0',
      protocol: 'otlp-http-json',
      temporality: 'delta'
    });
  });

  it('defines the seven instruments with their names, kinds and units', () => {
    const summary = INSTRUMENT_IDS.map((id) => {
      const definition = MAPPING_REVISION_1.instruments[id];
      return [definition.name, definition.kind, definition.unit, definition.divisor];
    });
    expect(summary).toEqual([
      ['gen_ai.client.token.usage', 'histogram', '{token}', 1],
      ['gen_ai.client.operation.duration', 'histogram', 's', 1000],
      ['schegent.usage.cache_tokens', 'sum', '{token}', 1],
      ['schegent.usage.cost', 'sum', null, 1000000],
      ['schegent.usage.token_adjustment', 'sum', '{token}', 1],
      ['schegent.usage.cost_adjustment', 'sum', null, 1000000],
      ['schegent.export.coverage', 'sum', '{outcome}', 1]
    ]);
  });

  it('uses the semantic-convention bucket boundaries for the two histograms', () => {
    const tokens = MAPPING_REVISION_1.instruments['token-usage'];
    const duration = MAPPING_REVISION_1.instruments['operation-duration'];
    expect(tokens).toMatchObject({
      bounds: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864]
    });
    expect(duration).toMatchObject({
      bounds: [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92]
    });
  });

  it('makes usage sums monotonic and adjustment sums not', () => {
    const monotonic = INSTRUMENT_IDS.flatMap((id) => {
      const definition = MAPPING_REVISION_1.instruments[id];
      return definition.kind === 'sum' ? [[id, definition.monotonic, definition.valueField]] : [];
    });
    expect(monotonic).toEqual([
      ['cache-tokens', true, 'asInt'],
      ['cost', true, 'asDouble'],
      ['token-adjustment', false, 'asInt'],
      ['cost-adjustment', false, 'asDouble'],
      ['coverage', true, 'asInt']
    ]);
  });

  it('routes five measures and leaves three unmapped', () => {
    expect(MEASURES.filter(isMappedMeasure)).toEqual([
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_creation_tokens',
      'cost'
    ]);
    expect(MEASURES.filter((name) => !isMappedMeasure(name))).toEqual(['credits', 'context_used', 'context_size']);
    expect(isMappedMeasure('toString')).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(MAPPING_REVISION_1)).toBe(true);
    expect(Object.isFrozen(MAPPING_REVISION_1.instruments)).toBe(true);
    expect(Object.isFrozen(MAPPING_REVISION_1.instruments['token-usage'].labels)).toBe(true);
  });
});

describe('the provider label', () => {
  it.each([
    ['claude', 'anthropic'],
    ['codex', 'openai'],
    ['agy', 'agy'],
    ['some-other-backend', 'some-other-backend'],
    ['constructor', 'constructor']
  ])('maps backend %s to provider %s', (backend, provider) => {
    expect(providerNameOf(backend)).toBe(provider);
  });
});

describe('mapRecord: usage', () => {
  it.each([
    ['input_tokens', 'input'],
    ['output_tokens', 'output']
  ] as const)('exports %s as one token-usage observation of type %s', (name, tokenType) => {
    const mapped = mapRecord(usageRecord({ measures: [measure({ measure: name, quantity: '512' })] }));
    const observation = only(mapped.observations);
    expect(observation).toMatchObject({ instrument: 'token-usage', unit: '{token}', value: 512 });
    expect(labelsOf(observation)).toEqual({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'model-large',
      'gen_ai.response.model': 'model-large-20260101',
      'gen_ai.token.type': tokenType,
      'schegent.backend': 'claude',
      'schegent.usage.completeness': 'known',
      'schegent.usage.provenance': 'provider-reported'
    });
    expect(mapped.coverage).toEqual(['exported']);
  });

  it.each([
    ['cache_read_tokens', 'read', 'subset-of-input'],
    ['cache_creation_tokens', 'creation', 'disjoint']
  ] as const)('exports %s on the cache-token sum as kind %s', (name, kind, relation) => {
    const mapped = mapRecord(usageRecord({ measures: [measure({ measure: name, quantity: '64', cacheRelation: relation })] }));
    const observation = only(mapped.observations);
    expect(observation).toMatchObject({ instrument: 'cache-tokens', unit: '{token}', value: 64 });
    expect(labelsOf(observation)).toMatchObject({
      'schegent.usage.cache_kind': kind,
      'schegent.usage.cache_relation': relation
    });
    expect(labelsOf(observation)).not.toHaveProperty(ATTRIBUTE_KEYS.operationName);
    expect(labelsOf(observation)).not.toHaveProperty(ATTRIBUTE_KEYS.tokenType);
    expect(mapped.coverage).toEqual(['exported']);
  });

  it('leaves the cache relation out when the source has none', () => {
    const mapped = mapRecord(usageRecord({ measures: [measure({ measure: 'cache_read_tokens', cacheRelation: null })] }));
    expect(labelsOf(only(mapped.observations))).not.toHaveProperty(ATTRIBUTE_KEYS.cacheRelation);
  });

  it('exports cost in micros under its currency code', () => {
    const mapped = mapRecord(usageRecord({ measures: [cost('1250000', 'USD'), cost('300000', 'EUR')] }));
    expect(mapped.observations.map((observation) => [observation.instrument, observation.unit, observation.value])).toEqual([
      ['cost', 'USD', 1250000],
      ['cost', 'EUR', 300000]
    ]);
    expect(mapped.coverage).toEqual(['exported', 'exported']);
  });

  it('labels an estimate and a partial value as such', () => {
    const mapped = mapRecord(usageRecord({ measures: [measure({ provenance: 'estimated', completeness: 'partial' })] }));
    expect(labelsOf(only(mapped.observations))).toMatchObject({
      'schegent.usage.provenance': 'estimated',
      'schegent.usage.completeness': 'partial'
    });
    expect(mapped.coverage).toEqual(['exported']);
  });

  it.each([
    ['a null quantity', measure({ quantity: null })],
    ['completeness unknown', measure({ completeness: 'unknown' })],
    ['a null cost', cost(null)]
  ])('exports nothing for %s and counts it missing', (_label, entry) => {
    expect(mapRecord(usageRecord({ measures: [entry] }))).toEqual({ observations: [], coverage: ['missing'] });
  });

  it('never turns a missing value into zero', () => {
    const mapped = mapRecord(usageRecord({ measures: [measure({ quantity: null }), measure({ quantity: '0' })] }));
    expect(mapped.observations.map((observation) => observation.value)).toEqual([0]);
    expect(mapped.coverage).toEqual(['missing', 'exported']);
  });

  it.each([
    ['credits', 'credits'],
    ['context_used', 'count'],
    ['context_size', 'count']
  ] as const)('exports nothing for %s and counts it unmapped', (name, unit) => {
    const withValue = mapRecord(usageRecord({ measures: [measure({ measure: name, unit })] }));
    const withoutValue = mapRecord(usageRecord({ measures: [measure({ measure: name, unit, quantity: null })] }));
    expect(withValue).toEqual({ observations: [], coverage: ['unmapped'] });
    expect(withoutValue).toEqual({ observations: [], coverage: ['unmapped'] });
  });

  it('exports the largest safe quantity and refuses the next one as out of range', () => {
    const largest = mapRecord(usageRecord({ measures: [measure({ quantity: MAX_SAFE })] }));
    expect(only(largest.observations).value).toBe(Number.MAX_SAFE_INTEGER);
    const over = mapRecord(usageRecord({ measures: [measure({ quantity: OVER_MAX_SAFE }), cost('9'.repeat(19))] }));
    expect(over).toEqual({ observations: [], coverage: ['out-of-range', 'out-of-range'] });
  });

  it('maps every measure of a record, in order, and an empty record to nothing', () => {
    const mapped = mapRecord(
      usageRecord({
        measures: [
          measure({ measure: 'input_tokens' }),
          measure({ measure: 'credits', unit: 'credits' }),
          measure({ measure: 'output_tokens', quantity: null }),
          cost('10')
        ]
      })
    );
    expect(mapped.observations.map((observation) => observation.instrument)).toEqual(['token-usage', 'cost']);
    expect(mapped.coverage).toEqual(['exported', 'unmapped', 'missing', 'exported']);
    expect(mapRecord(usageRecord({ measures: [] }))).toEqual({ observations: [], coverage: [] });
  });
});

describe('mapRecord: operations', () => {
  it('exports a duration in milliseconds on the duration histogram', () => {
    const mapped = mapRecord(operationRecord({ durationMs: 1500 }));
    const observation = only(mapped.observations);
    expect(observation).toMatchObject({ instrument: 'operation-duration', unit: 's', value: 1500 });
    expect(labelsOf(observation)).toEqual({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'model-large',
      'gen_ai.response.model': 'model-large-20260101',
      'schegent.backend': 'claude',
      'schegent.operation.outcome': 'succeeded'
    });
    expect(mapped.coverage).toEqual(['exported']);
  });

  it.each(['failed', 'cancelled', 'interrupted'] as const)('sets error.type for the outcome %s', (outcome) => {
    const labels = labelsOf(only(mapRecord(operationRecord({ outcome })).observations));
    expect(labels).toMatchObject({ 'error.type': outcome, 'schegent.operation.outcome': outcome });
  });

  it.each(['succeeded', 'superseded', 'unknown'] as const)('sets no error.type for the outcome %s', (outcome) => {
    const labels = labelsOf(only(mapRecord(operationRecord({ outcome })).observations));
    expect(labels).not.toHaveProperty('error.type');
    expect(labels).toMatchObject({ 'schegent.operation.outcome': outcome });
  });

  it('counts an operation without a duration as missing', () => {
    expect(mapRecord(operationRecord({ durationMs: null }))).toEqual({ observations: [], coverage: ['missing'] });
  });

  it('exports a zero duration and refuses one past the safe range', () => {
    expect(only(mapRecord(operationRecord({ durationMs: 0 })).observations).value).toBe(0);
    expect(mapRecord(operationRecord({ durationMs: 1e300 }))).toEqual({ observations: [], coverage: ['out-of-range'] });
  });
});

describe('mapRecord: corrections', () => {
  it('exports the signed difference on the token adjustment instrument', () => {
    const mapped = mapRecord(correctionRecord({ previousQuantity: '10', replacementQuantity: '12' }));
    const observation = only(mapped.observations);
    expect(observation).toMatchObject({ instrument: 'token-adjustment', unit: '{token}', value: 2 });
    expect(labelsOf(observation)).toEqual({
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'model-large',
      'gen_ai.response.model': 'model-large-20260101',
      'schegent.backend': 'claude',
      'schegent.usage.measure': 'output_tokens'
    });
    expect(mapped.coverage).toEqual(['correction']);
  });

  it('exports a downward correction as a negative difference', () => {
    const mapped = mapRecord(correctionRecord({ measure: 'cache_read_tokens', previousQuantity: '500', replacementQuantity: '120' }));
    expect(only(mapped.observations)).toMatchObject({ instrument: 'token-adjustment', value: -380 });
  });

  it('exports a cost correction in micros under its currency', () => {
    const mapped = mapRecord(correctionRecord({ measure: 'cost', unit: 'USD', previousQuantity: '2000000', replacementQuantity: '1500000' }));
    expect(only(mapped.observations)).toMatchObject({ instrument: 'cost-adjustment', unit: 'USD', value: -500000 });
    expect(mapped.coverage).toEqual(['correction']);
  });

  it.each([
    ['no previous quantity', { previousQuantity: null }],
    ['no replacement quantity', { replacementQuantity: null }],
    ['an unmapped measure', { measure: 'credits', unit: 'credits' }],
    ['an unmapped count measure', { measure: 'context_used' }]
  ] as const)('counts a correction with %s as unquantified', (_label, correction) => {
    expect(mapRecord(correctionRecord(correction))).toEqual({ observations: [], coverage: ['correction-unquantified'] });
  });

  it('refuses a correction whose quantity is past the safe range', () => {
    const mapped = mapRecord(correctionRecord({ previousQuantity: '1', replacementQuantity: OVER_MAX_SAFE }));
    expect(mapped).toEqual({ observations: [], coverage: ['out-of-range'] });
  });
});

describe('mapRecord: labels', () => {
  it.each([
    ['a path', '/Users/someone/project'],
    ['a value with a space', 'my backend'],
    ['an empty value', ''],
    ['a value over 256 bytes', 'a'.repeat(300)]
  ])('leaves out a backend that is %s, and the provider with it', (_label, backend) => {
    const mapped = mapRecord(usageRecord({ backend }));
    const labels = labelsOf(only(mapped.observations));
    expect(labels).not.toHaveProperty('schegent.backend');
    expect(labels).not.toHaveProperty('gen_ai.provider.name');
    expect(mapped.coverage).toEqual(['excluded-dimension', 'exported']);
    expect(JSON.stringify(mapped)).not.toContain(backend === '' ? 'no-such-text' : backend);
  });

  it('leaves out a model that fails the dimension rule and still exports the measure', () => {
    const mapped = mapRecord(usageRecord({ modelRequested: 'model with spaces', modelReported: '../escape' }));
    const observation = only(mapped.observations);
    expect(observation.value).toBe(1024);
    expect(labelsOf(observation)).not.toHaveProperty('gen_ai.request.model');
    expect(labelsOf(observation)).not.toHaveProperty('gen_ai.response.model');
    expect(mapped.coverage).toEqual(['excluded-dimension', 'excluded-dimension', 'exported']);
  });

  it('leaves out an absent model without counting it', () => {
    const mapped = mapRecord(operationRecord({ modelRequested: null, modelReported: null }));
    const labels = labelsOf(only(mapped.observations));
    expect(labels).not.toHaveProperty('gen_ai.request.model');
    expect(labels).not.toHaveProperty('gen_ai.response.model');
    expect(mapped.coverage).toEqual(['exported']);
  });

  it('counts an excluded label once per record, whatever the number of measures', () => {
    const mapped = mapRecord(usageRecord({ backend: 'bad backend', measures: [measure(), measure({ measure: 'output_tokens' })] }));
    expect(mapped.coverage).toEqual(['excluded-dimension', 'exported', 'exported']);
  });

  it('keeps every observation inside its instrument allowlist, sorted by key', () => {
    const records = [
      usageRecord({
        measures: [
          measure(),
          measure({ measure: 'output_tokens', provenance: 'derived' }),
          measure({ measure: 'cache_read_tokens', cacheRelation: 'unknown' }),
          measure({ measure: 'cache_creation_tokens' }),
          cost('5')
        ]
      }),
      operationRecord({ outcome: 'failed' }),
      correctionRecord(),
      correctionRecord({ measure: 'cost', unit: 'EUR' })
    ];
    const observations = records.flatMap((record) => mapRecord(record).observations);
    expect(observations).toHaveLength(8);
    for (const observation of observations) {
      const allowed = MAPPING_REVISION_1.instruments[observation.instrument].labels;
      const keys = observation.attributes.map(([key]) => key);
      expect(keys.filter((key) => !allowed.includes(key))).toEqual([]);
      expect(keys).toEqual([...keys].sort());
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('reports only outcomes from the closed coverage list', () => {
    const outcomes = [usageRecord({ backend: 'x y', measures: [measure({ quantity: null })] }), correctionRecord({ previousQuantity: null })]
      .flatMap((record) => mapRecord(record).coverage);
    expect(outcomes.filter((outcome) => !COVERAGE_OUTCOMES.includes(outcome))).toEqual([]);
  });
});

describe('createRecordMapper: the same mapping, with each attribute list built once', () => {
  const VARIETY = [
    usageRecord({
      measures: [
        measure(),
        measure({ measure: 'output_tokens', provenance: 'estimated' }),
        measure({ measure: 'cache_read_tokens', cacheRelation: 'subset-of-input' }),
        measure({ measure: 'cache_creation_tokens', completeness: 'partial' }),
        measure({ quantity: null }),
        cost('5'),
        cost('7', 'EUR')
      ]
    }),
    usageRecord({ backend: 'codex', modelRequested: null, measures: [measure(), cost(OVER_MAX_SAFE)] }),
    usageRecord({ backend: 'x y', modelReported: '/home/someone/model', measures: [measure()] }),
    operationRecord(),
    operationRecord({ outcome: 'failed' }),
    operationRecord({ durationMs: null }),
    correctionRecord(),
    correctionRecord({ measure: 'cost', unit: 'EUR' }),
    correctionRecord({ previousQuantity: null })
  ];

  it('maps every record exactly as mapRecord does, the first time and again', () => {
    const map = createRecordMapper();
    for (const record of [...VARIETY, ...VARIETY]) expect(map(record)).toEqual(mapRecord(record));
  });

  it('gives records with the same labels one frozen list per label choice', () => {
    const map = createRecordMapper();
    const first = only(map(usageRecord({ sourceId: 'usage-a' })).observations);
    const second = only(map(usageRecord({ sourceId: 'usage-b' })).observations);
    expect(second.attributes).toBe(first.attributes);
    expect(Object.isFrozen(first.attributes)).toBe(true);
    expect(first.attributes.every((attribute) => Object.isFrozen(attribute))).toBe(true);
    const operation = only(map(operationRecord({ sourceId: 'attempt-a' })).observations);
    expect(only(map(operationRecord({ sourceId: 'attempt-b' })).observations).attributes).toBe(operation.attributes);
    const correction = only(map(correctionRecord()).observations);
    expect(only(map(correctionRecord({}, { sourceRevision: 2 })).observations).attributes).toBe(correction.attributes);
  });

  it('builds a separate list for each label choice and each label set', () => {
    const map = createRecordMapper();
    const reported = only(map(usageRecord()).observations);
    const estimated = only(map(usageRecord({ measures: [measure({ provenance: 'estimated' })] })).observations);
    const otherModel = only(map(usageRecord({ modelRequested: 'model-small' })).observations);
    expect(labelsOf(estimated)[ATTRIBUTE_KEYS.provenance]).toBe('estimated');
    expect(labelsOf(reported)[ATTRIBUTE_KEYS.provenance]).toBe('provider-reported');
    expect(labelsOf(otherModel)[ATTRIBUTE_KEYS.requestModel]).toBe('model-small');
    expect(labelsOf(reported)[ATTRIBUTE_KEYS.requestModel]).toBe('model-large');
  });

  it('keeps mapping correctly past the number of label sets it holds', () => {
    const map = createRecordMapper();
    const records = Array.from({ length: 600 }, (_unused, index) => usageRecord({ modelRequested: `model-${String(index)}` }));
    for (const record of [...records, ...records]) expect(map(record)).toEqual(mapRecord(record));
  });

  it('holds 256 label sets and starts again at the next one', () => {
    const map = createRecordMapper();
    const other = (index: number) => usageRecord({ modelRequested: `model-${String(index)}` });
    const first = only(map(usageRecord()).observations).attributes;
    for (let index = 0; index < 255; index += 1) map(other(index));
    // 256 label sets are held, the first among them.
    expect(only(map(usageRecord()).observations).attributes).toBe(first);
    map(other(255));
    // The 257th emptied the store, so the first label set is built again.
    const rebuilt = only(map(usageRecord()).observations).attributes;
    expect(rebuilt).toEqual(first);
    expect(rebuilt).not.toBe(first);
  });

  it('holds 64 lists for one label set and builds any further one each time', () => {
    const map = createRecordMapper();
    const choices = (['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'] as const).flatMap((name) =>
      (['provider-reported', 'derived', 'estimated'] as const).flatMap((provenance) =>
        (['known', 'partial'] as const).flatMap((completeness) =>
          ([null, 'subset-of-input', 'disjoint', 'unknown'] as const).map((cacheRelation) =>
            usageRecord({ measures: [measure({ measure: name, provenance, completeness, cacheRelation })] })
          )
        )
      )
    );
    expect(choices.length).toBeGreaterThan(64);
    const listOf = (index: number) => {
      const record = choices.at(index);
      if (record === undefined) throw new Error('expected a label choice');
      return only(map(record).observations).attributes;
    };
    const held = Array.from({ length: 64 }, (_unused, index) => listOf(index));
    expect(listOf(63)).toBe(held.at(63));
    const beyond = listOf(64);
    expect(listOf(64)).toEqual(beyond);
    expect(listOf(64)).not.toBe(beyond);
    // The lists held before stay shared.
    expect(listOf(0)).toBe(held.at(0));
  });

  it('does not share the list of a record whose label field was left out', () => {
    const map = createRecordMapper();
    const excluded = usageRecord({ backend: 'x y' });
    const first = map(excluded);
    const second = map(excluded);
    expect(first).toEqual(mapRecord(excluded));
    expect(second).toEqual(first);
    expect(only(second.observations).attributes).not.toBe(only(first.observations).attributes);
  });

  it('maps a record with a label field longer than any label can be', () => {
    const map = createRecordMapper();
    const long = usageRecord({ modelRequested: 'm'.repeat(5000) });
    expect(map(long)).toEqual(mapRecord(long));
    expect(map(long).coverage).toEqual(['excluded-dimension', 'exported']);
  });

  it('keeps separate mappers apart', () => {
    const first = only(createRecordMapper()(usageRecord()).observations);
    const second = only(createRecordMapper()(usageRecord()).observations);
    expect(second.attributes).toEqual(first.attributes);
    expect(second.attributes).not.toBe(first.attributes);
  });
});
