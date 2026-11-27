import { availabilityPhrase } from '../../../../src/contracts/change-review';
import type { UsageRow } from '../../../../src/contracts/reporting/report-rows';

function hasPositiveEstimate(value: string | undefined): boolean {
  return value !== undefined && !/^0(?:\.0+)?$/.test(value);
}

/**
 * Formats a reporting usage measure without substituting numeric `0` for unknown
 * zero-coverage entries, keeping reported and estimated lanes visibly separated.
 */
export function fmtUsageMeasure(m: UsageRow['measures'][number]): string {
  if (m.completeness === 'unknown' && m.coverage.known === 0) {
    return hasPositiveEstimate(m.estimatedTotal)
      ? `${m.measure}: ${availabilityPhrase('unknown')} [estimated ${m.estimatedTotal} ${m.unit}] (${m.completeness})`
      : `${m.measure}: ${availabilityPhrase('unknown')} (${m.completeness})`;
  }
  const lanes: string[] = [];
  if (m.reportedTotal !== undefined) lanes.push(`reported ${m.reportedTotal}`);
  if (m.estimatedTotal !== undefined) lanes.push(`estimated ${m.estimatedTotal}`);
  const split = lanes.length > 0 ? ` [${lanes.join(', ')}]` : '';
  return `${m.measure}: ${m.total} ${m.unit}${split} (${m.completeness})`;
}

