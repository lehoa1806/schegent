import type { RetryCapOutcome } from './process-definitions';

/**
 * FR-R3-157 — the ONE place that resolves what a Phase does at its retry cap.
 *
 * Two forms of the same decision now exist in authored pipelines and will keep
 * existing indefinitely: the deprecated boolean `forceContinueOnRetryCap` and the
 * three-valued `onRetryCap` that supersedes it (FR-006). Neither goes away — every
 * pipeline file already on disk keeps loading, unedited, forever.
 *
 * That is precisely why the resolution lives here rather than at the call site.
 * A second site would be individually correct and would disagree with this one only
 * on a Phase carrying both forms — the rarest input, and so the one that would ship.
 * `tests/lint/retry-cap-resolution-site.test.ts` pins the claim: this file is the
 * only non-test source file classified as a *reader* of the deprecated field, and
 * `controller/phase.ts` names it nowhere at all.
 *
 * The function is total. Every combination of the three inputs returns a member of
 * `RETRY_CAP_OUTCOMES`, and there is no throw path — a malformed definition is the
 * validator's problem, not the controller's, and a controller that threw here would
 * turn a bad pipeline file into a crashed Run rather than a failed Phase.
 *
 * WHY THIS SITS IN `contracts/` RATHER THAN `controller/` (T047/T048). It was
 * written in `controller/` on the reading that resolution is controller logic
 * (research.md D2). Then the phase editor needed the same answer: FR-016 asks the
 * control to show the outcome *in effect* and to say whether the phase states it,
 * and a phase carrying only the deprecated switch has an outcome that only this
 * precedence can name. There were exactly two ways to give the webview that answer
 * — copy the rule, or share it — and `webview-host-import-direction.test.ts`
 * refuses a value import from outside `contracts/`, so a copy was the only thing
 * that would have compiled where it sat. That copy is precisely the second reader
 * FR-007 forbids: individually correct, disagreeing with this one only on a phase
 * carrying both forms, and disagreeing in the direction where the editor tells an
 * operator the phase will do one thing while the controller does another.
 *
 * So the *reason* D2 gave for the placement survives intact and the placement does
 * not: nothing here is controller logic in the sense D2 meant — no state, no
 * dependency, no import but a type from the module next door. The gate that refused
 * the import says the remedy in its own failure text: "Move the value into
 * src/contracts/ (it is contract-shaped if both sides need it)." Both sides need
 * it. FR-007's claim gets stronger by the move, not weaker: one resolution site in
 * the product, rather than one resolution site in the host and a second in the
 * surface that no host-only search would have found.
 */

/**
 * The shape this resolver needs, and nothing more.
 *
 * Structural rather than a named import of one Phase type, because four different
 * carriers of a phase definition reach this function — the authored contract type,
 * the config mirror, the controller's own `PhaseDefLike`, and test literals — and
 * they agree on exactly these two fields. Widening the parameter to any one of them
 * would drag that type's whole surface into the controller for no gain.
 */
export interface RetryCapDefLike {
  /** Deprecated by `onRetryCap`; still authoritative when `onRetryCap` is absent. */
  readonly forceContinueOnRetryCap?: boolean;
  /** The stated outcome. Wins over both fallbacks below when present. */
  readonly onRetryCap?: RetryCapOutcome;
}

/**
 * Resolve the outcome for one Phase at its retry cap.
 *
 * Precedence, most specific first (contract C1.2):
 *
 *  1. the Phase's own `onRetryCap` — the only way to reach `'continue-degraded'`;
 *  2. the Phase's deprecated `forceContinueOnRetryCap` — `true` is `'continue'`,
 *     `false` is `'fail'`, which is what those values have always meant;
 *  3. the workspace default, under the same boolean mapping;
 *  4. `'fail'` — the behaviour of a workspace that has never configured any of this,
 *     preserved exactly (FR-005).
 *
 * A Phase that states anything at all wins over the workspace default, including
 * when it states the *opposite* of it. That is the point of a per-phase switch.
 *
 * @param phaseDef The Phase's definition, or `undefined` when the Phase carries none.
 * @param workspaceDefault The `schegent.retry.forceContinueOnCap` workspace setting.
 */
export function resolveRetryCapOutcome(
  phaseDef: RetryCapDefLike | undefined,
  workspaceDefault: boolean | undefined
): RetryCapOutcome {
  if (phaseDef?.onRetryCap !== undefined) {
    return phaseDef.onRetryCap;
  }
  if (phaseDef?.forceContinueOnRetryCap !== undefined) {
    return phaseDef.forceContinueOnRetryCap ? 'continue' : 'fail';
  }
  return workspaceDefault === true ? 'continue' : 'fail';
}

/**
 * Does this Phase state its own cap outcome, or inherit the workspace default?
 *
 * The companion to `resolveRetryCapOutcome`, and deliberately its neighbour: FR-016
 * asks the phase editor to show the outcome in effect *and* to say where it came
 * from, and the second half is not recoverable from the first. `'fail'` is both the
 * commonest stated outcome and the value an unconfigured workspace falls back to,
 * so the resolved answer alone cannot tell an operator whether changing the
 * workspace setting would move this phase.
 *
 * PRESENCE, NOT TRUTH. Either spelling counts, and `forceContinueOnRetryCap: false`
 * counts as loudly as `true`. Writing `false` is how an author holds one phase to
 * `'fail'` in a workspace whose default is `'continue'` — a truthiness check would
 * read that phase as inheriting, and would tell the author the workspace decides
 * something they had already decided themselves.
 *
 * The two functions are one answer read in two halves, so they stay together: this
 * is the boundary at which the deprecated field's meaning is interpreted, and
 * `tests/lint/retry-cap-resolution-site.test.ts` holds that boundary to one file.
 *
 * @param phaseDef The Phase's definition, or `undefined` when the Phase carries none.
 */
export function statesRetryCapOutcome(phaseDef: RetryCapDefLike | undefined): boolean {
  return phaseDef?.onRetryCap !== undefined || phaseDef?.forceContinueOnRetryCap !== undefined;
}
