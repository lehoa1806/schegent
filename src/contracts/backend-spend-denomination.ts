// FR-R3-144 (T036, FR-009) — which spend bound is in force for which backend.
//
// WHY THIS IS A CONTRACT AND NOT A CONSTANT IN THE TAB
//
// Two surfaces need this answer and one of them is the webview. The settings tab
// must offer the USD bound under a backend that reports a cost and the token bound
// under one that does not, because offering both is how an operator comes to set a
// dollar bound on `codex` and believe they have bounded it — the manifest's own
// description says the dollar bound "applies to backends that report a cost", and
// nothing enforced that on the surface. `src/contracts/` is where a value the
// webview may import lives (`tests/lint/webview-host-import-direction.test.ts`
// forbids a value import from `src/services/`), so the answer lives here.
//
// The second surface is `services/autonomy-bounds-disclosure.ts`, which rendered
// the same three-row table from a list written by hand beside it. That list is now
// a projection of this one. Two hand-kept copies of "which backend reports a cost"
// was the arrangement this whole item exists to remove; adding a third would have
// been an odd way to close it.
//
// WHAT THIS IS NOT
//
// It is not the enforcement. `services/spend-bound.ts` decides at runtime from what
// the invocation actually reported — a cost if there is one, tokens otherwise — and
// that stays the authority on whether a run is over its bound. This module answers
// only the STATIC question a surface has to answer before a run exists: which bound
// an operator configuring this backend should be given. A backend that begins
// reporting a cost is one edit here, and the tab changes with it.

import type { BackendRunnerKind } from './backend-kinds';

/** What a backend's spend is measured in, for the purpose of bounding it. */
export type SpendDenomination = 'usd' | 'tokens';

/**
 * Every backend's denomination, as a `Record` so a fourth `BackendRunnerKind`
 * member is a compile error here until someone has answered this question for it.
 *
 * `claude` reports `total_cost_usd`; `codex` and `agy` report tokens and no cost,
 * because FR-R3-098 left cost ABSENT there rather than derived from a rate card
 * nobody published.
 */
export const SPEND_DENOMINATION_BY_BACKEND: Readonly<
  Record<BackendRunnerKind, SpendDenomination>
> = Object.freeze({
  claude: 'usd',
  codex: 'tokens',
  agy: 'tokens'
});

export function spendDenominationOf(kind: BackendRunnerKind): SpendDenomination {
  return SPEND_DENOMINATION_BY_BACKEND[kind];
}

/**
 * The setting each denomination is configured through, by wire key.
 *
 * Carried here rather than at the two call sites because a surface that offers the
 * right control under the wrong key is the same defect as offering the wrong
 * control, and this is the one place both facts are stated together.
 */
export const SPEND_BOUND_KEY_BY_DENOMINATION: Readonly<Record<SpendDenomination, string>> =
  Object.freeze({
    usd: 'spend.maxUsdPerRun',
    tokens: 'spend.maxTokensPerRun'
  });
