// FR-R6-F14 T012 — the OTLP/HTTP JSON metrics request: its envelope, histogram and sum data
// points, ordering, 64-bit integers as decimal text, and a size estimate that is never below
// the encoded size (FR-003, FR-004, FR-006, FR-010).
import { describe, expect, it } from 'vitest';

import { OVERFLOW_ATTRIBUTES } from '../../../src/services/telemetry-export/cardinality-guard';
import {
  coverageObservation,
  createMetricsBatch,
  type BatchObservation,
  type MetricsBatch
} from '../../../src/services/telemetry-export/otlp-metrics-encoder';
import { mulberry32, pick } from '../../fixtures/seeded-rng';

const WINDOW = { startTimeMs: 1762840800000, timeMs: 1762840805000 };
const TOKEN_BOUNDS = [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864];

interface WirePoint {
  attributes: { key: string; value: Record<string, unknown> }[];
  startTimeUnixNano: string;
  timeUnixNano: string;
  count?: string;
  sum?: number;
  bucketCounts?: string[];
  explicitBounds?: number[];
  min?: number;
  max?: number;
  asInt?: string;
  asDouble?: number;
}

interface WireMetric {
  name: string;
  unit: string;
  histogram?: { aggregationTemporality: number; dataPoints: WirePoint[] };
  sum?: { aggregationTemporality: number; isMonotonic: boolean; dataPoints: WirePoint[] };
}

function textOf(batch: MetricsBatch, window = WINDOW): string {
  return Buffer.from(batch.encode(window)).toString('utf8');
}

function metricsOf(batch: MetricsBatch): WireMetric[] {
  const request = JSON.parse(textOf(batch)) as { resourceMetrics: { scopeMetrics: { metrics: WireMetric[] }[] }[] };
  const metrics = request.resourceMetrics.at(0)?.scopeMetrics.at(0)?.metrics;
  if (metrics === undefined) throw new Error('expected a metrics list');
  return metrics;
}

function pointsOf(metric: WireMetric | undefined): WirePoint[] {
  const points = metric?.histogram?.dataPoints ?? metric?.sum?.dataPoints;
  if (points === undefined) throw new Error('expected data points');
  return points;
}

function firstPoint(batch: MetricsBatch): WirePoint {
  const point = pointsOf(metricsOf(batch).at(0)).at(0);
  if (point === undefined) throw new Error('expected a data point');
  return point;
}

function tokens(value: number, type = 'input'): BatchObservation {
  return { instrument: 'token-usage', unit: '{token}', attributes: [['gen_ai.token.type', type]], value };
}

function duration(valueMs: number): BatchObservation {
  return { instrument: 'operation-duration', unit: 's', attributes: [], value: valueMs };
}

function batchOf(observations: readonly BatchObservation[]): MetricsBatch {
  const batch = createMetricsBatch();
  for (const observation of observations) expect(batch.add(observation)).toBe('added');
  return batch;
}

function bucketIndexOf(observation: BatchObservation): number {
  const counts = firstPoint(batchOf([observation])).bucketCounts ?? [];
  expect(counts).toHaveLength(15);
  return counts.indexOf('1');
}

describe('the request envelope', () => {
  it('matches the request in the contract document', () => {
    const batch = batchOf([tokens(512), tokens(1024)]);
    expect(JSON.parse(textOf(batch))).toEqual({
      resourceMetrics: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'schegent' } }] },
          scopeMetrics: [
            {
              scope: {
                name: 'schegent.telemetry-export',
                version: '1',
                attributes: [
                  { key: 'schegent.export.mapping_revision', value: { stringValue: '1' } },
                  { key: 'schegent.export.source_schema', value: { stringValue: '1' } }
                ]
              },
              schemaUrl: 'https://opentelemetry.io/schemas/1.37.0',
              metrics: [
                {
                  name: 'gen_ai.client.token.usage',
                  unit: '{token}',
                  histogram: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: [{ key: 'gen_ai.token.type', value: { stringValue: 'input' } }],
                        startTimeUnixNano: '1762840800000000000',
                        timeUnixNano: '1762840805000000000',
                        count: '2',
                        sum: 1536,
                        bucketCounts: ['0', '0', '0', '0', '0', '2', '0', '0', '0', '0', '0', '0', '0', '0', '0'],
                        explicitBounds: TOKEN_BOUNDS,
                        min: 512,
                        max: 1024
                      }
                    ]
                  }
                }
              ]
            }
          ]
        }
      ]
    });
  });

  it('is compact JSON with its keys in the documented order', () => {
    const text = textOf(batchOf([tokens(512)]));
    expect(JSON.stringify(JSON.parse(text))).toBe(text);
    expect(text.indexOf('"scope"')).toBeLessThan(text.indexOf('"schemaUrl"'));
    expect(text.indexOf('"schemaUrl"')).toBeLessThan(text.indexOf('"metrics"'));
    expect(text.indexOf('"name"', text.indexOf('"metrics"'))).toBeLessThan(text.indexOf('"histogram"'));
  });

  it('adds a well-formed service version and leaves out any other', () => {
    const withVersion = createMetricsBatch({ serviceVersion: '0.2.0' });
    expect(textOf(withVersion)).toContain('{"key":"service.version","value":{"stringValue":"0.2.0"}}');
    for (const version of ['', 'a b', '/Users/someone/build', 'x'.repeat(65)]) {
      expect(textOf(createMetricsBatch({ serviceVersion: version }))).not.toContain('service.version');
    }
    expect(textOf(createMetricsBatch())).not.toContain('service.version');
  });

  it('starts empty and stops being empty at the first observation', () => {
    const batch = createMetricsBatch();
    expect(batch.isEmpty()).toBe(true);
    expect(metricsOf(batch)).toEqual([]);
    batch.add(coverageObservation('missing'));
    expect(batch.isEmpty()).toBe(false);
  });

  it('writes the window as nanoseconds in decimal text, and a bad clock value as zero', () => {
    const batch = batchOf([tokens(1)]);
    expect(firstPoint(batch)).toMatchObject({ startTimeUnixNano: '1762840800000000000', timeUnixNano: '1762840805000000000' });
    const bad = JSON.parse(textOf(batch, { startTimeMs: Number.NaN, timeMs: -5 })) as unknown;
    expect(JSON.stringify(bad)).toContain('"startTimeUnixNano":"0","timeUnixNano":"0"');
    const fractional = textOf(batch, { startTimeMs: 1.9, timeMs: Number.POSITIVE_INFINITY });
    expect(fractional).toContain('"startTimeUnixNano":"1000000","timeUnixNano":"0"');
  });
});

describe('histogram data points', () => {
  it.each([
    [0, 0],
    [1, 0],
    [2, 1],
    [4, 1],
    [5, 2],
    [1024, 5],
    [1025, 6],
    [67108864, 13],
    [67108865, 14],
    [Number.MAX_SAFE_INTEGER, 14]
  ])('puts a token count of %d in bucket %d', (value, bucket) => {
    expect(bucketIndexOf(tokens(value))).toBe(bucket);
  });

  it.each([
    [0, 0],
    [10, 0],
    [10.5, 1],
    [20, 1],
    [1280, 7],
    [1281, 8],
    [81920, 13],
    [81921, 14]
  ])('puts a duration of %d ms in bucket %d', (valueMs, bucket) => {
    expect(bucketIndexOf(duration(valueMs))).toBe(bucket);
  });

  it('writes a duration in seconds', () => {
    const point = firstPoint(batchOf([duration(1500), duration(250)]));
    expect(point).toMatchObject({ count: '2', sum: 1.75, min: 0.25, max: 1.5 });
    expect(point.explicitBounds).toEqual([0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92]);
  });

  it('keeps one data point per attribute set', () => {
    const batch = batchOf([tokens(1, 'input'), tokens(2, 'output'), tokens(3, 'input')]);
    const points = pointsOf(metricsOf(batch).at(0));
    expect(points.map((point) => [point.attributes.at(0)?.value.stringValue, point.count, point.sum])).toEqual([
      ['input', '2', 4],
      ['output', '1', 2]
    ]);
  });

  it('writes counts and bucket counts as decimal text and the sum as a number', () => {
    const point = firstPoint(batchOf([tokens(7)]));
    expect(typeof point.count).toBe('string');
    expect((point.bucketCounts ?? []).every((count) => /^[0-9]+$/.test(count))).toBe(true);
    expect(typeof point.sum).toBe('number');
  });
});

describe('sum data points', () => {
  it('writes cache tokens as an integer in decimal text on a monotonic delta sum', () => {
    const batch = batchOf([
      { instrument: 'cache-tokens', unit: '{token}', attributes: [['schegent.usage.cache_kind', 'read']], value: 64 },
      { instrument: 'cache-tokens', unit: '{token}', attributes: [['schegent.usage.cache_kind', 'read']], value: 36 }
    ]);
    expect(metricsOf(batch)).toEqual([
      {
        name: 'schegent.usage.cache_tokens',
        unit: '{token}',
        sum: {
          aggregationTemporality: 1,
          isMonotonic: true,
          dataPoints: [
            {
              attributes: [{ key: 'schegent.usage.cache_kind', value: { stringValue: 'read' } }],
              startTimeUnixNano: '1762840800000000000',
              timeUnixNano: '1762840805000000000',
              asInt: '100'
            }
          ]
        }
      }
    ]);
  });

  it('writes cost in units of its currency, one metric entry per currency', () => {
    const batch = batchOf([
      { instrument: 'cost', unit: 'USD', attributes: [], value: 1250000 },
      { instrument: 'cost', unit: 'EUR', attributes: [], value: 300000 },
      { instrument: 'cost', unit: 'USD', attributes: [], value: 250000 }
    ]);
    const metrics = metricsOf(batch);
    expect(metrics.map((metric) => [metric.name, metric.unit, pointsOf(metric).at(0)?.asDouble])).toEqual([
      ['schegent.usage.cost', 'EUR', 0.3],
      ['schegent.usage.cost', 'USD', 1.5]
    ]);
    expect(metrics.every((metric) => metric.sum?.isMonotonic === true)).toBe(true);
  });

  it('writes adjustments signed, on sums that are not monotonic', () => {
    const batch = batchOf([
      { instrument: 'token-adjustment', unit: '{token}', attributes: [['schegent.usage.measure', 'output_tokens']], value: -380 },
      { instrument: 'cost-adjustment', unit: 'USD', attributes: [['schegent.usage.measure', 'cost']], value: -500000 }
    ]);
    const metrics = metricsOf(batch);
    expect(metrics.map((metric) => [metric.name, metric.sum?.isMonotonic])).toEqual([
      ['schegent.usage.cost_adjustment', false],
      ['schegent.usage.token_adjustment', false]
    ]);
    expect(pointsOf(metrics.at(0)).at(0)).toMatchObject({ asDouble: -0.5 });
    expect(pointsOf(metrics.at(1)).at(0)).toMatchObject({ asInt: '-380' });
  });

  it('counts coverage outcomes on their own instrument', () => {
    const batch = batchOf([coverageObservation('missing'), coverageObservation('exported'), coverageObservation('missing')]);
    const metric = metricsOf(batch).at(0);
    expect(metric).toMatchObject({ name: 'schegent.export.coverage', unit: '{outcome}', sum: { isMonotonic: true } });
    expect(pointsOf(metric).map((point) => [point.attributes.at(0)?.value.stringValue, point.asInt])).toEqual([
      ['exported', '1'],
      ['missing', '2']
    ]);
    expect(pointsOf(metric).at(0)?.attributes.at(0)?.key).toBe('schegent.export.outcome');
  });

  it('writes the overflow set as one boolean attribute', () => {
    const batch = batchOf([{ instrument: 'cost', unit: 'USD', attributes: OVERFLOW_ATTRIBUTES, value: 1000000 }]);
    expect(firstPoint(batch).attributes).toEqual([{ key: 'otel.metric.overflow', value: { boolValue: true } }]);
  });
});

describe('ordering', () => {
  const OBSERVATIONS: readonly BatchObservation[] = [
    tokens(5, 'output'),
    { instrument: 'cost', unit: 'USD', attributes: [['schegent.backend', 'codex']], value: 10 },
    duration(40),
    tokens(9, 'input'),
    { instrument: 'cost', unit: 'EUR', attributes: [['schegent.backend', 'claude']], value: 20 },
    { instrument: 'cost', unit: 'USD', attributes: [['schegent.backend', 'claude']], value: 30 },
    coverageObservation('exported')
  ];

  it('sorts metrics by name then unit, and points by attribute set', () => {
    const metrics = metricsOf(batchOf(OBSERVATIONS));
    expect(metrics.map((metric) => `${metric.name} ${metric.unit}`)).toEqual([
      'gen_ai.client.operation.duration s',
      'gen_ai.client.token.usage {token}',
      'schegent.export.coverage {outcome}',
      'schegent.usage.cost EUR',
      'schegent.usage.cost USD'
    ]);
    expect(pointsOf(metrics.at(4)).map((point) => point.attributes.at(0)?.value.stringValue)).toEqual(['claude', 'codex']);
    expect(pointsOf(metrics.at(1)).map((point) => point.attributes.at(0)?.value.stringValue)).toEqual(['input', 'output']);
  });

  it('encodes the same bytes whatever order the observations arrived in', () => {
    const expected = textOf(batchOf(OBSERVATIONS));
    const rng = mulberry32(313);
    for (let round = 0; round < 20; round += 1) {
      const shuffled = [...OBSERVATIONS].sort(() => rng() - 0.5);
      expect(textOf(batchOf(shuffled))).toBe(expected);
    }
  });

  it('encodes the same bytes twice', () => {
    const batch = batchOf(OBSERVATIONS);
    expect(textOf(batch)).toBe(textOf(batch));
  });
});

describe('the safe range', () => {
  it('refuses an observation that would take a sum past the largest safe integer', () => {
    const batch = batchOf([{ instrument: 'cache-tokens', unit: '{token}', attributes: [], value: Number.MAX_SAFE_INTEGER }]);
    const before = textOf(batch);
    expect(batch.add({ instrument: 'cache-tokens', unit: '{token}', attributes: [], value: 1 })).toBe('out-of-range');
    expect(textOf(batch)).toBe(before);
    expect(firstPoint(batch).asInt).toBe('9007199254740991');
  });

  it('applies the same rule to a histogram sum and to a negative adjustment', () => {
    const histogram = batchOf([tokens(Number.MAX_SAFE_INTEGER)]);
    expect(histogram.add(tokens(1))).toBe('out-of-range');
    expect(firstPoint(histogram)).toMatchObject({ count: '1' });
    const adjustment = batchOf([{ instrument: 'token-adjustment', unit: '{token}', attributes: [], value: -Number.MAX_SAFE_INTEGER }]);
    expect(adjustment.add({ instrument: 'token-adjustment', unit: '{token}', attributes: [], value: -1 })).toBe('out-of-range');
    expect(adjustment.add({ instrument: 'token-adjustment', unit: '{token}', attributes: [], value: 5 })).toBe('added');
  });

  it('refuses a value that is not a finite number, and a negative one on a usage instrument', () => {
    const batch = createMetricsBatch();
    expect(batch.add(tokens(Number.NaN))).toBe('out-of-range');
    expect(batch.add(tokens(Number.POSITIVE_INFINITY))).toBe('out-of-range');
    expect(batch.add(tokens(-1))).toBe('out-of-range');
    expect(batch.add(duration(-1))).toBe('out-of-range');
    expect(batch.isEmpty()).toBe(true);
  });
});

describe('the size estimate', () => {
  const UNITS = ['USD', 'EUR', 'JPY'];
  const LABELS = ['a', 'model-large-20260101', 'x'.repeat(128), 'claude'];

  const ANY_SCALE = [10, 1e6, 1e12, 9e15];
  /** Small enough that no sum in a test of a few hundred observations leaves the safe range. */
  const SMALL_SCALE = [10, 1e6, 1e9];

  function randomObservation(rng: () => number, scales: readonly number[] = ANY_SCALE): BatchObservation {
    const label: BatchObservation['attributes'] = [
      ['gen_ai.request.model', pick(rng, LABELS)],
      ['schegent.backend', pick(rng, LABELS)]
    ];
    const value = Math.floor(rng() * pick(rng, scales));
    return pick<BatchObservation>(rng, [
      { instrument: 'token-usage', unit: '{token}', attributes: label, value },
      { instrument: 'operation-duration', unit: 's', attributes: label, value: value / 3 },
      { instrument: 'cache-tokens', unit: '{token}', attributes: label, value },
      { instrument: 'cost', unit: pick(rng, UNITS), attributes: label, value },
      { instrument: 'token-adjustment', unit: '{token}', attributes: label, value: -value },
      { instrument: 'cost-adjustment', unit: pick(rng, UNITS), attributes: label, value: -value },
      { instrument: 'cost', unit: 'USD', attributes: OVERFLOW_ATTRIBUTES, value },
      coverageObservation(pick(rng, ['exported', 'missing', 'overflow'] as const))
    ]);
  }

  it('is never below the encoded size, across 200 seeded batches', () => {
    const rng = mulberry32(31314);
    const window = { startTimeMs: Number.MAX_SAFE_INTEGER, timeMs: Number.MAX_SAFE_INTEGER };
    for (let round = 0; round < 200; round += 1) {
      const batch = createMetricsBatch({ serviceVersion: '10.20.30-rc.1' });
      const size = Math.floor(rng() * 120);
      for (let index = 0; index < size; index += 1) batch.add(randomObservation(rng));
      const encoded = batch.encode(window).byteLength;
      expect(batch.estimatedBytes(), `round ${round}`).toBeGreaterThanOrEqual(encoded);
    }
  });

  it('grows by exactly what it said it would', () => {
    const rng = mulberry32(99);
    const batch = createMetricsBatch();
    for (let round = 0; round < 60; round += 1) {
      const group = Array.from({ length: 1 + Math.floor(rng() * 6) }, () => randomObservation(rng, SMALL_SCALE));
      const before = batch.estimatedBytes();
      const growth = batch.growthOf(group);
      const added = group.map((observation) => batch.add(observation));
      expect(added.every((result) => result === 'added')).toBe(true);
      expect(batch.estimatedBytes() - before).toBe(growth);
    }
  });

  it('does not grow when an observation joins a data point that exists', () => {
    const batch = batchOf([tokens(1)]);
    const before = batch.estimatedBytes();
    expect(batch.growthOf([tokens(2), tokens(3)])).toBe(0);
    batch.add(tokens(2));
    expect(batch.estimatedBytes()).toBe(before);
  });

  it('counts the escaping of a label value', () => {
    const quoted: BatchObservation = { instrument: 'cost', unit: 'USD', attributes: [['schegent.backend', '"'.repeat(200)]], value: 1 };
    const batch = batchOf([quoted]);
    expect(batch.estimatedBytes()).toBeGreaterThanOrEqual(batch.encode(WINDOW).byteLength);
  });
});

describe('an attribute list met before', () => {
  const BACKEND = 'schegent.backend';

  function costOf(attributes: BatchObservation['attributes']): BatchObservation {
    return { instrument: 'cost', unit: 'USD', attributes, value: 1 };
  }

  function backendsOf(batch: MetricsBatch): unknown[] {
    return pointsOf(metricsOf(batch).at(0)).map((point) => point.attributes.at(0)?.value.stringValue ?? null);
  }

  it('puts a frozen list and an equal list that is not frozen in one data point', () => {
    const frozen = Object.freeze([Object.freeze([BACKEND, 'claude'] as const)]);
    const batch = batchOf([costOf(frozen), costOf([[BACKEND, 'claude']]), costOf(frozen)]);
    expect(backendsOf(batch)).toEqual(['claude']);
    expect(pointsOf(metricsOf(batch).at(0)).at(0)?.asDouble ?? null).toBe(0.000003);
  });

  it('gives one frozen list the same data point in a later batch', () => {
    const frozen = Object.freeze([Object.freeze([BACKEND, 'claude'] as const)]);
    expect(textOf(batchOf([costOf(frozen)]))).toBe(textOf(batchOf([costOf([[BACKEND, 'claude']])])));
    expect(textOf(batchOf([costOf(frozen)]))).toBe(textOf(batchOf([costOf(frozen)])));
  });

  it('reads a list again when the list can still change', () => {
    const list: [string, string][] = [[BACKEND, 'claude']];
    const batch = batchOf([costOf(list)]);
    list.splice(0, 1, [BACKEND, 'codex']);
    expect(batch.growthOf([costOf(list)])).toBeGreaterThan(0);
    expect(batch.add(costOf(list))).toBe('added');
    expect(backendsOf(batch)).toEqual(['claude', 'codex']);
  });

  it('reads a frozen list again when one of its entries can still change', () => {
    const entry: [string, string] = [BACKEND, 'claude'];
    const list = Object.freeze([entry]);
    const batch = batchOf([costOf(list)]);
    entry.splice(1, 1, 'codex');
    expect(batch.add(costOf(list))).toBe('added');
    expect(backendsOf(batch)).toEqual(['claude', 'codex']);
  });

  it('hands out one frozen observation per coverage outcome', () => {
    const missing = coverageObservation('missing');
    expect(coverageObservation('missing')).toBe(missing);
    expect(coverageObservation('overflow')).not.toBe(missing);
    expect(Object.isFrozen(missing)).toBe(true);
    expect(Object.isFrozen(missing.attributes)).toBe(true);
    expect(missing).toEqual({ instrument: 'coverage', unit: '{outcome}', attributes: [['schegent.export.outcome', 'missing']], value: 1 });
  });
});
