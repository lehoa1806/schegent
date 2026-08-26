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

/** What a backend reports, so the bound knows which denomination applies. */
export type SpendDenomination = 'usd' | 'tokens';

export interface SpendObserved {
  /** Accumulated cost, when the backend reports one. */
  readonly costUsd: number | undefined;
  /** Accumulated tokens. Every backend reports these. */
  readonly totalTokens: number | undefined;
}

export interface SpendBoundConfig {
  /** The workspace default, or `null` for no bound. */
  readonly limitUsd: number | null;
  /** The token-denominated bound, for backends that report no cost. */
  readonly limitTokens: number | null;
}

export type SpendVerdict =
  | { readonly kind: 'within' }
  | { readonly kind: 'unmeasurable'; readonly reason: string }
  | {
      readonly kind: 'exceeded';
      readonly denomination: SpendDenomination;
      readonly observed: number;
      readonly limit: number;
    };

/**
 * Which denomination a backend's figures support.
 *
 * Cost when the backend reports it, tokens otherwise. Deliberately derived from the OBSERVATION
 * rather than from the backend name: a backend that starts reporting cost should get the cost bound
 * without a second edit here, and a `claude` invocation whose envelope happened to omit cost should
 * fall back rather than read as zero spend.
 */
export function denominationFor(observed: SpendObserved): SpendDenomination | null {
  if (typeof observed.costUsd === 'number') return 'usd';
  if (typeof observed.totalTokens === 'number') return 'tokens';
  return null;
}

/**
 * Whether this run has crossed its bound.
 *
 * `unmeasurable` is its own verdict rather than folded into `within`. A run whose spend cannot be
 * observed is not a run known to be inside its bound, and an operator who set a limit should be able
 * to tell "under budget" from "we cannot tell" — the second is a reason to look at why the backend
 * reports nothing, and reporting it as compliance would hide that.
 */
export function evaluateSpend(
  observed: SpendObserved,
  config: SpendBoundConfig
): SpendVerdict {
  const denomination = denominationFor(observed);
  if (denomination === null) {
    // No bound configured means nothing to be unmeasurable ABOUT — the common case, and it must not
    // produce a diagnostic on every phase.
    if (config.limitUsd === null && config.limitTokens === null) return { kind: 'within' };
    return {
      kind: 'unmeasurable',
      reason: 'the backend reported neither cost nor tokens for this run'
    };
  }

  if (denomination === 'usd') {
    if (config.limitUsd === null) return { kind: 'within' };
    const observedUsd = observed.costUsd as number;
    return observedUsd >= config.limitUsd
      ? { kind: 'exceeded', denomination: 'usd', observed: observedUsd, limit: config.limitUsd }
      : { kind: 'within' };
  }

  if (config.limitTokens === null) return { kind: 'within' };
  const observedTokens = observed.totalTokens as number;
  return observedTokens >= config.limitTokens
    ? {
        kind: 'exceeded',
        denomination: 'tokens',
        observed: observedTokens,
        limit: config.limitTokens
      }
    : { kind: 'within' };
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
 * The token fields a backend may report, summed into one figure.
 *
 * All four count against the bound. Cache reads are cheaper than fresh input and
 * are not free, and a bound that ignored them would be defeated by exactly the
 * workload that grows fastest — a long conversation re-reading a large cached
 * context. Absent fields contribute nothing rather than zero, so "the backend
 * reported no tokens" stays distinguishable from "the backend reported none".
 */
export const SPEND_TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens'
] as const;

/**
 * Fold one recorded invocation's usage into a run's cumulative total.
 *
 * Reads the AUDIT PAYLOAD rather than a parallel accumulator, because the payload
 * is the record an operator and `npm run audit:verify` will later read: a bound
 * enforced against a private tally could pause a run for spend the evidence does
 * not show, or fail to pause one the evidence does. `phase-end` is the entry that
 * carries usage; the cap-exhaustion addendum carries none and folds to a no-op.
 */
export function accumulateSpend(
  prev: SpendObserved,
  payload: Readonly<Record<string, unknown>>
): SpendObserved {
  const cost = payload.totalCostUsd;
  const costUsd =
    typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
      ? (prev.costUsd ?? 0) + cost
      : prev.costUsd;
  let totalTokens = prev.totalTokens;
  for (const field of SPEND_TOKEN_FIELDS) {
    const value = payload[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      totalTokens = (totalTokens ?? 0) + value;
    }
  }
  return { costUsd, totalTokens };
}

/** The zero a run starts from: nothing observed, which is not the same as zero spent. */
export const NO_SPEND_OBSERVED: SpendObserved = Object.freeze({
  costUsd: undefined,
  totalTokens: undefined
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
