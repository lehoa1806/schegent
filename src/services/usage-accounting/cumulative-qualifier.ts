/**
 * FR-R6-F06 (T033, FR-006, research R3) — when a session-cumulative counter may become a
 * per-invocation figure.
 *
 * A cumulative cost becomes an invocation delta only when a qualified baseline was subtracted
 * from it. The figure is then `derived`. Otherwise it stays unknown: `cumulative-reset` when the
 * counter fell below its baseline, `unattributed-session-baseline` when there was no baseline at
 * all. Each unknown reason here is also a gap kind, counted when the observation is stored, so a
 * reader sees how much cost could not be attributed.
 *
 * The qualifier decides provenance only. The quantity itself comes from the usage reader, which
 * rejects a negative or non-finite value before this code is reached, so no path here yields a
 * negative quantity.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { GapKind } from '../../contracts/usage-accounting/accounting-types';
import type { CostBaselineMarker } from '../../contracts/usage-accounting/cost-baseline';

export { COST_BASELINE_MARKERS, type CostBaselineMarker, costBaselineOf } from '../../contracts/usage-accounting/cost-baseline';

export type CumulativeUnknownReason = 'cumulative-reset' | 'unattributed-session-baseline';

export type CumulativeQualification =
  | { readonly known: true; readonly provenance: 'derived' }
  | { readonly known: false; readonly reason: CumulativeUnknownReason };

/** The unknown reasons above, each of which is counted as a gap of the same name. */
export const CUMULATIVE_GAP_KINDS: ReadonlySet<GapKind> = new Set<GapKind>(['cumulative-reset', 'unattributed-session-baseline']);

const KNOWN: CumulativeQualification = Object.freeze({ known: true, provenance: 'derived' });
const RESET: CumulativeQualification = Object.freeze({ known: false, reason: 'cumulative-reset' });
const NO_BASELINE: CumulativeQualification = Object.freeze({ known: false, reason: 'unattributed-session-baseline' });

/** A Claude session-cumulative cost, by the parser's baseline marker. */
export function qualifyCumulativeCost(marker: CostBaselineMarker | null): CumulativeQualification {
  if (marker === 'subtracted') return KNOWN;
  if (marker === 'below-baseline') return RESET;
  return NO_BASELINE;
}

/** An ACP session-cumulative cost: known only against a qualified session baseline. */
export function qualifyAcpSessionCost(hasQualifiedSessionBaseline: boolean): CumulativeQualification {
  return hasQualifiedSessionBaseline ? KNOWN : NO_BASELINE;
}

/** The gap a stored unknown measure counts, if its reason is one of the cumulative reasons. */
export function cumulativeGapOf(unknownReason: string | null | undefined): GapKind | undefined {
  if (unknownReason === null || unknownReason === undefined) return undefined;
  return CUMULATIVE_GAP_KINDS.has(unknownReason as GapKind) ? (unknownReason as GapKind) : undefined;
}
