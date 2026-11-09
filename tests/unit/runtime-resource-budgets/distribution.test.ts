import { describe, expect, it } from 'vitest';
import {
  checkSampleSufficiency,
  computeDistribution
} from '../../../src/services/runtime-resource-budgets/distribution';

describe('distribution and sample sufficiency (T005, T007)', () => {
  it('excludes warm-up samples and computes nearest-rank p50, p95, p99, and max', () => {
    const warmUp = Array.from({ length: 20 }, () => 9_999);
    const steady = Array.from({ length: 200 }, (_, idx) => idx + 1); // 1..200
    const dist = computeDistribution({
      metric: 'mutation-ack-ms',
      runId: 'run-1',
      values: [...warmUp, ...steady],
      warmUpCount: 20,
      unit: 'ms',
      budgetKind: 'aggregate'
    });

    expect(dist.rawCount).toBe(220);
    expect(dist.warmUpCount).toBe(20);
    expect(dist.p50).toBe(100);
    expect(dist.p95).toBe(190);
    expect(dist.p99).toBe(198);
    expect(dist.max).toBe(200);
    expect(dist.derivation).toBe('measured');
    expect(dist.budgetKind).toBe('aggregate');
  });

  it('passes sample sufficiency when 3 isolated runs each have >= 20 warm-up and >= 200 steady samples', () => {
    const values = Array.from({ length: 220 }, (_, i) => i + 1);
    const runs = ['run-1', 'run-2', 'run-3'].map((runId) =>
      computeDistribution({
        metric: 'event-loop-delay-ms',
        runId,
        values,
        warmUpCount: 20,
        unit: 'ms'
      })
    );

    const report = checkSampleSufficiency(runs);
    expect(report.sufficient).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it('reports insufficiency when runs, warm-up, or steady-state counts fall short', () => {
    const shortRun = computeDistribution({
      metric: 'event-loop-delay-ms',
      runId: 'run-1',
      values: Array.from({ length: 100 }, () => 1),
      warmUpCount: 10,
      unit: 'ms'
    });

    const report = checkSampleSufficiency([shortRun]);
    expect(report.sufficient).toBe(false);
    expect(report.failures.length).toBe(3);
  });
});

