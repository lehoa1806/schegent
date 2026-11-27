/**
 * FR-R6-F06 (T035, FR-006, research R3) — what the parser did with a session baseline when it
 * read Claude's cumulative cost.
 *
 * - `subtracted`: a baseline existed and the cumulative figure was at or above it, so the cost
 *   is this invocation's share;
 * - `below-baseline`: the cumulative figure fell below the baseline, so the counter was reset
 *   and the figure cannot be attributed;
 * - `absent`: no baseline was known.
 *
 * One closed set, read by the parser that writes it, the audit projection that persists it and
 * the accounting service that interprets it.
 */
export const COST_BASELINE_MARKERS = Object.freeze(['subtracted', 'below-baseline', 'absent'] as const);
export type CostBaselineMarker = (typeof COST_BASELINE_MARKERS)[number];

/** A marker from the closed set; anything else is `null`. */
export function costBaselineOf(value: unknown): CostBaselineMarker | null {
  return typeof value === 'string' && (COST_BASELINE_MARKERS as readonly string[]).includes(value)
    ? (value as CostBaselineMarker)
    : null;
}
