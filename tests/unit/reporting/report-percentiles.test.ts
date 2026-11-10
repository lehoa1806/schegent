// FR-R6-F11 T011 — nearest-rank duration distributions (FR-008).
//
// WHAT THIS PINS:
//   - p50, p90 and p99 are the nearest-rank values: the ceil(p * n / 100)-th smallest sample;
//   - an empty known population gives `unavailable`;
//   - an unknown sample is excluded from the percentiles and counted as missing.

import { describe, expect, it } from 'vitest';
import { distributionOf } from '../../../src/services/reporting/report-percentiles';

function range(from: number, to: number, step = 1): number[] {
  const values: number[] = [];
  for (let value = from; value <= to; value += step) {
    values.push(value);
  }
  return values;
}

describe('FR-R6-F11 T011 — report percentiles', () => {
  it.each<[string, readonly number[], number, number, number]>([
    ['n = 1', [42], 42, 42, 42],
    ['n = 2', [20, 10], 10, 20, 20],
    ['n = 10', range(10, 100, 10).reverse(), 50, 90, 100],
    ['n = 101', range(0, 100), 50, 90, 99]
  ])('%s gives hand-computed nearest-rank values', (_name, samples, p50, p90, p99) => {
    const distribution = distributionOf('root-wall-clock', samples);
    expect(distribution).toEqual({
      unit: 'ms',
      basis: 'root-wall-clock',
      samples: samples.length,
      known: samples.length,
      missing: 0,
      p50,
      p90,
      p99,
      method: 'nearest-rank'
    });
  });

  it('gives unavailable for an empty population', () => {
    expect(distributionOf('attempt-own', [])).toEqual({
      unit: 'ms',
      basis: 'attempt-own',
      samples: 0,
      known: 0,
      missing: 0,
      p50: 'unavailable',
      p90: 'unavailable',
      p99: 'unavailable',
      method: 'nearest-rank'
    });
  });

  it('excludes unknown samples and counts them as missing', () => {
    const distribution = distributionOf('root-wall-clock', [null, 30, null, 10, 20]);
    expect(distribution).toMatchObject({ samples: 5, known: 3, missing: 2, p50: 20, p90: 30, p99: 30 });
    expect(distributionOf('root-wall-clock', [null, null])).toMatchObject({
      samples: 2,
      known: 0,
      missing: 2,
      p50: 'unavailable'
    });
  });

  it('does not reorder the caller array', () => {
    const samples = [3, 1, 2];
    distributionOf('attempt-own', samples);
    expect(samples).toEqual([3, 1, 2]);
  });
});
