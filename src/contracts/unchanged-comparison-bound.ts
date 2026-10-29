import type { RetryCapOutcome } from './process-definitions';

/**
 * FR-R4-F17 (feature 245, contract S4) — the ONE rule behind
 * `schegent.loop.maxUnchangedComparisons`.
 *
 * The host already counts consecutive comparisons in which the figures a Phase's retry condition reads
 * did not change (`PhaseRetryEvaluator`, feature 194). This bound turns that count into a decision: a
 * looping Phase whose count reaches the bound fails before its iteration cap, with the cause
 * `judged_metrics_unchanged`. It ships off (`0`), so a workspace that never sets it behaves exactly as
 * it did before.
 *
 * Three questions are answered here, and they stay together so execution and the limits view cannot
 * disagree. What a setting value means (`normalizeMaxUnchangedComparisons`); whether the bound stops a
 * loop at this decision (`stopsOnUnchangedMetrics`); what the per-Run limits view shows
 * (`unchangedComparisonBoundState`). The second and third apply the same "does the cap outcome fail"
 * test, so a Phase that continues at its cap is never failed by the bound and is never shown as if it
 * would be.
 *
 * Leaf module: no `vscode`, no I/O, no state, and no import but the type `RetryCapOutcome`. The
 * settings schema reads `MAX_UNCHANGED_COMPARISONS` from here, so the schema and the predicate cannot
 * drift, and the webview-facing limits projection imports the state type.
 */

/** The largest accepted value: one under the default iteration cap, so the bound can always fire first. */
export const MAX_UNCHANGED_COMPARISONS = 49;

/**
 * FR-002: an integer from 0 to 49 is itself; anything else reads as 0, which disables the bound. A
 * string, a fraction, a negative number, `NaN`, an infinity and a value above the maximum are all 0.
 * Never throws: an out-of-range value in a layer must not fail a Run, only leave the bound off.
 */
export function normalizeMaxUnchangedComparisons(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return 0;
  return raw >= 0 && raw <= MAX_UNCHANGED_COMPARISONS ? raw : 0;
}

/**
 * Does the bound stop the loop at this decision? Asked only after the retry condition evaluated truthy
 * and the iteration was found below the cap; those two facts are positional in `transition()`, not
 * inputs here.
 *
 * True exactly when the normalized bound is at least 1, the cap outcome fails (an absent outcome has
 * always meant fail), and the evaluator reported a count at or above the bound. A count above the bound
 * stops too: lowering the setting mid-loop must take effect at the next decision.
 */
export function stopsOnUnchangedMetrics(input: {
  readonly bound: unknown;
  readonly capOutcome: RetryCapOutcome | undefined;
  readonly stalledCount: number | undefined;
}): boolean {
  const bound = normalizeMaxUnchangedComparisons(input.bound);
  if (bound < 1) return false;
  if (!failsAtCap(input.capOutcome)) return false;
  return input.stalledCount !== undefined && input.stalledCount >= bound;
}

/** FR-022: what the limits view shows for the bound. */
export type UnchangedComparisonBoundState =
  | 'active'
  | 'disabled'
  | 'inert-cap-outcome'
  | 'inert-no-retry-condition';

/**
 * What the limits view shows, from the same rule `stopsOnUnchangedMetrics` applies. First match wins:
 * a normalized value of 0 is `disabled`; a Phase with no non-blank retry condition is
 * `inert-no-retry-condition` (the stop sits inside the retry-condition branch, so it cannot apply);
 * a resolved cap outcome other than fail is `inert-cap-outcome`; otherwise `active`.
 */
export function unchangedComparisonBoundState(input: {
  readonly bound: unknown;
  readonly capOutcome: RetryCapOutcome;
  readonly retryCondition: string | undefined;
}): UnchangedComparisonBoundState {
  if (normalizeMaxUnchangedComparisons(input.bound) === 0) return 'disabled';
  if (input.retryCondition === undefined || input.retryCondition.trim().length === 0) {
    return 'inert-no-retry-condition';
  }
  return failsAtCap(input.capOutcome) ? 'active' : 'inert-cap-outcome';
}

/** The one "fails at the cap" test both exported decisions apply. */
function failsAtCap(capOutcome: RetryCapOutcome | undefined): boolean {
  return capOutcome === undefined || capOutcome === 'fail';
}
