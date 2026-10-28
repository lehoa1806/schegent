// FR-R3-112 (FR-119..FR-123) — the bound this product did not have.
//
// THE GAP. Every autonomy bound here was time- or count-shaped: iteration cap 10, retry cap 5, idle
// 5400 s, absolute 21600 s. **Nothing bounded spend.** Cost was recorded — `metrics-rollup.ts`
// accumulates `costUsd` and validates non-negativity — and `grep -rni "maxCost|costLimit|spendLimit|
// tokenBudget" src` returned zero: no code path in controller or services ever read it to refuse,
// pause or warn. Invocation counts stop correlating with spend once context grows, so a pathological
// run burns budget at full speed inside every existing cap. `FR-R3-098` made tokens visible for all
// three backends, which is what makes the bound implementable now.
//
// TWO DENOMINATIONS, because the backends report different things. `claude` reports cost; `codex`
// and `agy` report tokens and no cost at all (`FR-R3-098` left cost ABSENT there rather than derived,
// which was the right call — a derived price is a guess about someone else's rate card). A bound that
// only worked on `claude` would be the S7 half-wired shape this round keeps finding, so the bound is
// token-denominated where cost is unavailable and the disclosure says which applies where.
//
// PAUSE, NEVER FAIL. Crossing the bound produces the existing operator-resumable pause with a new
// cause. No terminal transition: an operator returning to a paused run has lost time, to a failed one
// possibly work. That asymmetry is the whole reason this is a pause.
//
// DEFAULT UNSET. A shipped default would pause existing operators' runs on upgrade — a bound arriving
// as a surprise mid-run is worse than no bound. The mechanism exists, is documented, and is derived
// into the operator disclosure; its default is "no bound", and the disclosure says so.

import type { SpendDenomination } from '../contracts/backend-spend-denomination';
import { readPhaseEndUsage, totalTokens } from './usage-reader';

/**
 * What a backend reports, so the bound knows which denomination applies. Re-exported from the
 * contract that owns the answer (`SPEND_DENOMINATION_BY_BACKEND`), so there is one union and one
 * table, not a second one here.
 */
export type { SpendDenomination };

/**
 * FR-R4-F02 (data-model §7) — why a Run's total is a lower bound and not the whole of its spend.
 * `evicted` is the watcher's own (a Run whose tally was dropped to stay under `MAX_TRACKED_RUNS` and
 * was seen again); the other five are the restart replay's.
 */
export type IncompleteReason =
  | 'budget'
  | 'archive-missing'
  | 'read-failed'
  | 'damaged-row'
  | 'unknown-row-schema'
  | 'evicted';

export type SpendCompleteness =
  | { readonly kind: 'complete' }
  | { readonly kind: 'incomplete'; readonly reason: IncompleteReason };

/**
 * FR-R4-F02 (data-model §7; contract S2 G5) — one Run's spend so far. Renamed from `SpendObserved`
 * because it now says two more things the bound has to act on: whether the total is the whole of
 * the Run's spend, and which rows it has already counted, so a row seen twice (by the seed and by
 * the live notice) changes nothing.
 */
export interface RunSpendTotal {
  /** Accumulated cost, when the backend reports one. `undefined`: never observed. */
  readonly costUsd: number | undefined;
  /** Accumulated tokens, when any token field was observed. `undefined`: never observed. */
  readonly totalTokens: number | undefined;
  readonly completeness: SpendCompleteness;
  /** Provenance and de-duplication: the ids of the `phase-end` rows folded into this total. */
  readonly countedRowIds: ReadonlySet<string>;
}

export interface SpendBoundConfig {
  /** The workspace default, or `null` for no bound. */
  readonly limitUsd: number | null;
  /** The token-denominated bound, for backends that report no cost. */
  readonly limitTokens: number | null;
}

/**
 * FR-R4-F02 (data-model §8) — the verdict of one evaluation. `unmeasurable` and `incomplete` are
 * their own verdicts and are never folded into `within`: an operator who set a limit has to be able
 * to tell "under budget" from "we cannot tell", and the second is a reason to look at why the
 * backend reports nothing or the history is partial, which compliance would hide.
 */
export type SpendVerdict =
  | { readonly kind: 'no-applicable-bound' }
  | { readonly kind: 'within' }
  | {
      readonly kind: 'exceeded';
      readonly denomination: SpendDenomination;
      readonly observed: number;
      readonly limit: number;
    }
  | {
      readonly kind: 'unmeasurable';
      readonly denomination: SpendDenomination;
      readonly reason: 'value-absent';
    }
  | {
      readonly kind: 'incomplete';
      readonly denomination: SpendDenomination;
      readonly reason: IncompleteReason;
    };

/**
 * Whether this run has crossed its bound, in the denomination of the phase that just ended.
 *
 * THE DENOMINATION IS GIVEN, NOT DERIVED. It used to be read off the figures (cost if the backend
 * reported one, tokens otherwise), which made a `claude` Run that happened to report tokens only
 * look token-bounded and a `codex` Run that reported a cost look dollar-bounded. The caller now
 * names it from the ended phase's backend (`spendDenominationOf(effectiveRunnerKindForPhase(...))`),
 * and a figure in the other denomination is never read.
 *
 * The rows of data-model §8, in order:
 *   - no limit in that denomination: `no-applicable-bound`;
 *   - a limit and no value in that denomination: `unmeasurable`;
 *   - at or above the limit, complete or not: `exceeded` (a lower bound at or over the limit is a
 *     measured crossing);
 *   - below the limit and incomplete: `incomplete`, never `within`;
 *   - below the limit and complete: `within`.
 */
export function evaluateSpend(
  total: RunSpendTotal,
  bound: SpendBoundConfig,
  denomination: SpendDenomination
): SpendVerdict {
  const limit = denomination === 'usd' ? bound.limitUsd : bound.limitTokens;
  if (limit === null) return { kind: 'no-applicable-bound' };
  const observed = denomination === 'usd' ? total.costUsd : total.totalTokens;
  if (observed === undefined) {
    return { kind: 'unmeasurable', denomination, reason: 'value-absent' };
  }
  if (observed >= limit) return { kind: 'exceeded', denomination, observed, limit };
  if (total.completeness.kind === 'incomplete') {
    return { kind: 'incomplete', denomination, reason: total.completeness.reason };
  }
  return { kind: 'within' };
}

/**
 * The operator-facing sentence for a paused run.
 *
 * Names the bound AND the measured spend, because "paused: spend limit" without a number leaves an
 * operator unable to decide whether to raise the limit or investigate the run.
 */
export function spendPauseMessage(verdict: Extract<SpendVerdict, { kind: 'exceeded' }>): string {
  const observed =
    verdict.denomination === 'usd'
      ? `$${verdict.observed.toFixed(2)}`
      : `${verdict.observed.toLocaleString('en-US')} tokens`;
  const limit =
    verdict.denomination === 'usd'
      ? `$${verdict.limit.toFixed(2)}`
      : `${verdict.limit.toLocaleString('en-US')} tokens`;
  return (
    `Schegent paused this run: it has spent ${observed}, reaching its bound of ${limit}. ` +
    'Nothing was cancelled — resume it to continue, or raise the bound in settings.'
  );
}

/**
 * Fold one recorded invocation's usage into a run's cumulative total, once per row.
 *
 * Reads the AUDIT PAYLOAD rather than a parallel accumulator, because the payload is the record an
 * operator and `npm run audit:verify` will later read: a bound enforced against a private tally
 * could pause a run for spend the evidence does not show, or fail to pause one the evidence does.
 * `phase-end` is the entry that carries usage; the cap-exhaustion addendum carries none and folds
 * to a no-op.
 *
 * The usage comes through `readPhaseEndUsage`, the one validated reader (contract S1): nested
 * first, flat second, absent never zero. A row id already counted changes nothing (contract S2
 * G5), which is what makes a row the seed and the live notice both deliver count once.
 */
export function accumulateSpend(
  prev: RunSpendTotal,
  payload: Readonly<Record<string, unknown>>,
  rowId: string
): RunSpendTotal {
  if (prev.countedRowIds.has(rowId)) return prev;
  const usage = readPhaseEndUsage(payload);
  const rowTokens = totalTokens(usage);
  const costUsd =
    usage.costUsd.kind === 'present' ? (prev.costUsd ?? 0) + usage.costUsd.value : prev.costUsd;
  const tokens = rowTokens === undefined ? prev.totalTokens : (prev.totalTokens ?? 0) + rowTokens;
  return {
    costUsd,
    totalTokens: tokens,
    completeness: prev.completeness,
    countedRowIds: new Set([...prev.countedRowIds, rowId])
  };
}

/** The zero a run starts from: nothing observed, which is not the same as zero spent. */
export const NO_SPEND_OBSERVED: RunSpendTotal = Object.freeze({
  costUsd: undefined,
  totalTokens: undefined,
  completeness: Object.freeze({ kind: 'complete' as const }),
  countedRowIds: new Set<string>()
});

/** What a Phase may declare, structurally, so callers need no catalog import. */
export interface SpendBoundOverride {
  readonly spendBoundUsd?: number | undefined;
  readonly spendBoundTokens?: number | undefined;
}

/**
 * The bound in force, with the authored per-phase value overriding the workspace
 * default.
 *
 * ORDINARY CONFIG PRECEDENCE, per denomination independently. A phase that
 * declares only a token bound keeps the workspace dollar bound: the alternative —
 * one declared field clearing the other denomination — would let a phase silently
 * remove a bound the operator set, which is the shape of every defect this round
 * has been closing. Same precedence as `effectivePhaseTimeoutMs`, and stated the
 * same way, because an operator who has learned one authored bound has learned
 * them all.
 */
export function effectiveSpendBound(
  workspace: SpendBoundConfig,
  phase?: SpendBoundOverride | undefined
): SpendBoundConfig {
  return {
    limitUsd: phase?.spendBoundUsd ?? workspace.limitUsd,
    limitTokens: phase?.spendBoundTokens ?? workspace.limitTokens
  };
}
