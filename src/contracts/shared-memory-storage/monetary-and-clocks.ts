/**
 * FR-R6-F02 — Shared memory and storage contracts: exact same-currency monetary
 * summation and acceptedSeq ordering with monotonic/wall-clock durations
 * (FR-004, FR-006, SC-004, SC-005).
 *
 * Zero `vscode` imports (SC-009, docs/hard-rules.md rule 13).
 */

import { buildSharedContractRefusal, type StorageBoundaryOutcome } from './inventories';
import {
  MONETARY_DECIMAL_PATTERN,
  type MonetaryObservationValue
} from './identity-and-observations';

export function sumMonetaryObservations(
  values: readonly (MonetaryObservationValue | null | undefined)[]
): StorageBoundaryOutcome<{ readonly totalDecimal: string; readonly currency: string }> {
  const present = values.filter((v): v is MonetaryObservationValue => v !== null && v !== undefined);
  if (present.length === 0) {
    return buildSharedContractRefusal(
      'invalid-observation',
      'no-monetary-values-present',
      'Absent monetary values cannot be coerced to zero.'
    );
  }
  const first = present[0]!;
  if (first.unitKind === 'nonmonetary-credits') {
    return buildSharedContractRefusal(
      'invalid-observation',
      'nonmonetary-credits-not-currency',
      `Nonmonetary unit '${first.unit}' cannot be summed or relabeled as currency.`,
      'unit'
    );
  }
  let scaledMicros = 0n;
  for (const item of present) {
    if (item.unitKind !== 'currency' || item.unit !== first.unit) {
      return buildSharedContractRefusal(
        'invalid-observation',
        'cross-currency-or-unit-mismatch',
        `Cannot sum '${item.unit}' (${item.unitKind}) with '${first.unit}'; cross-currency totals are out of scope.`,
        'unit'
      );
    }
    if (typeof item.amountDecimal !== 'string' || !MONETARY_DECIMAL_PATTERN.test(item.amountDecimal)) {
      return buildSharedContractRefusal(
        'invalid-observation',
        'malformed-monetary-value',
        'Monetary amounts must be non-negative exact decimals with at most 6 fractional digits.',
        'amountDecimal'
      );
    }
    const [wholePart = '0', fracPart = ''] = item.amountDecimal.split('.');
    const paddedFrac = (fracPart + '000000').slice(0, 6);
    scaledMicros += BigInt(wholePart) * 1_000_000n + BigInt(paddedFrac);
  }
  const whole = scaledMicros / 1_000_000n;
  const frac = (scaledMicros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return {
    status: 'accepted',
    value: {
      totalDecimal: frac.length > 0 ? `${whole.toString()}.${frac}` : whole.toString(),
      currency: first.unit
    }
  };
}

export interface TransitionTimingInput {
  readonly transitionId: string;
  readonly acceptedSeq: number;
  readonly startedAtUtc: string;
  readonly endedAtUtc: string;
  readonly startMonotonicMs?: number | undefined;
  readonly endMonotonicMs?: number | undefined;
  readonly acrossRestart?: boolean | undefined;
}

export interface EvaluatedTransitionTiming {
  readonly transitionId: string;
  readonly acceptedSeq: number;
  readonly elapsedMs: number;
  readonly timingQuality:
    | 'monotonic-exact'
    | 'wall-clock-skew-clamped'
    | 'cross-restart-wall-clock'
    | 'wall-clock-derived';
}

export function evaluateTransitionOrderingAndDuration(
  transitions: readonly TransitionTimingInput[]
): readonly EvaluatedTransitionTiming[] {
  const ordered = [...transitions].sort((a, b) => a.acceptedSeq - b.acceptedSeq);
  return ordered.map((t) => {
    if (
      t.acrossRestart !== true &&
      typeof t.startMonotonicMs === 'number' &&
      typeof t.endMonotonicMs === 'number' &&
      t.endMonotonicMs >= t.startMonotonicMs
    ) {
      return {
        transitionId: t.transitionId,
        acceptedSeq: t.acceptedSeq,
        elapsedMs: t.endMonotonicMs - t.startMonotonicMs,
        timingQuality: 'monotonic-exact'
      };
    }
    const startMs = Date.parse(t.startedAtUtc);
    const endMs = Date.parse(t.endedAtUtc);
    const rawDelta = endMs - startMs;
    if (!Number.isFinite(rawDelta) || rawDelta < 0) {
      return {
        transitionId: t.transitionId,
        acceptedSeq: t.acceptedSeq,
        elapsedMs: 0,
        timingQuality: 'wall-clock-skew-clamped'
      };
    }
    return {
      transitionId: t.transitionId,
      acceptedSeq: t.acceptedSeq,
      elapsedMs: rawDelta,
      timingQuality: t.acrossRestart === true ? 'cross-restart-wall-clock' : 'wall-clock-derived'
    };
  });
}
