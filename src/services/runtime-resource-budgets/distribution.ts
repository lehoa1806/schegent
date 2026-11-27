/**
 * FR-R6-F03 — Steady-state distribution calculator and sample sufficiency verifier
 * (FR-003, SC-002).
 *
 * Zero `vscode` imports.
 */

import { SAMPLE_SUFFICIENCY } from '../../contracts/runtime-resource-budgets/budget-targets';
import type { Distribution } from '../../contracts/runtime-resource-budgets/qualification-record';

export interface ComputeDistributionInput {
  readonly metric: string;
  readonly runId: string;
  readonly values: readonly number[];
  readonly warmUpCount?: number;
  readonly unit: 'ms' | 'bytes' | 'ratio' | 'count';
  readonly budgetKind?: 'aggregate' | 'component';
}

export interface SampleSufficiencyReport {
  readonly sufficient: boolean;
  readonly metric: string;
  readonly runCount: number;
  readonly requiredRuns: number;
  readonly requiredSteadyStateSamples: number;
  readonly requiredWarmUpSamples: number;
  readonly failures: readonly string[];
}

function nearestRankPercentile(sorted: readonly number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((percentile / 100) * sorted.length) - 1;
  const index = Math.max(0, Math.min(sorted.length - 1, rank));
  return sorted[index]!;
}

/**
 * Compute a distribution from raw samples after excluding the initial `warmUpCount`
 * samples. Uses nearest-rank percentiles (p50, p95, p99) and records `derivation: 'measured'`.
 */
export function computeDistribution(input: ComputeDistributionInput): Distribution {
  const warmUpCount = input.warmUpCount ?? SAMPLE_SUFFICIENCY.minWarmUpSamples;
  if (warmUpCount < 0 || !Number.isInteger(warmUpCount)) {
    throw new Error(`warmUpCount must be a non-negative integer; got ${warmUpCount}`);
  }
  const steadyState = input.values.slice(warmUpCount);
  const sorted = [...steadyState].sort((a, b) => a - b);
  const p50 = nearestRankPercentile(sorted, 50);
  const p95 = nearestRankPercentile(sorted, 95);
  const p99 = nearestRankPercentile(sorted, 99);
  const max = sorted.length > 0 ? sorted[sorted.length - 1]! : 0;

  return {
    metric: input.metric,
    runId: input.runId,
    rawCount: input.values.length,
    warmUpCount,
    p50,
    p95,
    p99,
    max,
    unit: input.unit,
    derivation: 'measured',
    ...(input.budgetKind !== undefined ? { budgetKind: input.budgetKind } : {})
  };
}

/**
 * Verify SC-002 sample sufficiency across isolated runs of a metric:
 * at least 3 runs, each with >= 20 warm-up samples and >= 200 steady-state samples.
 */
export function checkSampleSufficiency(
  distributions: readonly Distribution[],
  requirements: {
    readonly minSteadyStateSamples?: number;
    readonly minWarmUpSamples?: number;
    readonly minIsolatedRuns?: number;
  } = SAMPLE_SUFFICIENCY
): SampleSufficiencyReport {
  const requiredSteadyStateSamples =
    requirements.minSteadyStateSamples ?? SAMPLE_SUFFICIENCY.minSteadyStateSamples;
  const requiredWarmUpSamples =
    requirements.minWarmUpSamples ?? SAMPLE_SUFFICIENCY.minWarmUpSamples;
  const requiredRuns = requirements.minIsolatedRuns ?? SAMPLE_SUFFICIENCY.minIsolatedRuns;

  const metric = distributions[0]?.metric ?? 'unknown';
  const failures: string[] = [];

  const distinctRuns = new Set(distributions.map((d) => d.runId));
  if (distinctRuns.size < requiredRuns) {
    failures.push(
      `Metric '${metric}' has ${distinctRuns.size} isolated run(s); requires at least ${requiredRuns}.`
    );
  }

  for (const dist of distributions) {
    if (dist.warmUpCount < requiredWarmUpSamples) {
      failures.push(
        `Run '${dist.runId}' warmUpCount (${dist.warmUpCount}) is below ${requiredWarmUpSamples}.`
      );
    }
    const steadyCount = dist.rawCount - dist.warmUpCount;
    if (steadyCount < requiredSteadyStateSamples) {
      failures.push(
        `Run '${dist.runId}' steady-state sample count (${steadyCount}) is below ${requiredSteadyStateSamples}.`
      );
    }
  }

  return {
    sufficient: failures.length === 0,
    metric,
    runCount: distinctRuns.size,
    requiredRuns,
    requiredSteadyStateSamples,
    requiredWarmUpSamples,
    failures
  };
}

