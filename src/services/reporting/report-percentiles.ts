/**
 * FR-R6-F11 (FR-008) — duration distributions with nearest-rank percentiles.
 *
 * The p-th percentile of `n` known samples is the `ceil(p * n / 100)`-th smallest. Integer
 * percents keep that rank exact. An unknown sample (null) counts as missing and never enters the
 * percentiles; with no known sample every percentile is `unavailable`.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { Distribution, PercentileValue } from '../../contracts/reporting/report-rows';

export type DurationBasis = Distribution['basis'];

function nearestRank(sorted: readonly number[], percent: number): PercentileValue {
  if (sorted.length === 0) {
    return 'unavailable';
  }
  const rank = Math.max(1, Math.ceil((percent * sorted.length) / 100));
  return sorted.at(rank - 1) ?? 'unavailable';
}

/** The distribution of `samples`, where null is a member whose duration is not known. */
export function distributionOf(basis: DurationBasis, samples: readonly (number | null)[]): Distribution {
  const known = samples.filter((sample): sample is number => sample !== null).sort((left, right) => left - right);
  return Object.freeze({
    unit: 'ms',
    basis,
    samples: samples.length,
    known: known.length,
    missing: samples.length - known.length,
    p50: nearestRank(known, 50),
    p90: nearestRank(known, 90),
    p99: nearestRank(known, 99),
    method: 'nearest-rank'
  });
}
