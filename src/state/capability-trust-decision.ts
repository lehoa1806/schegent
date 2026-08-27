// FR-R3-126 (FR-004) — the trust ladder, as a pure function.
//
// WHY IT MOVED. The ladder was inline in `capability-trust-resolver.ts`, which
// imports `vscode` at module scope. That made the decision unreachable from
// anything that must not depend on the editor API — in particular from
// `tests/lint/documented-defaults-are-executable.test.ts`, which feeds the worked
// examples written in `docs/reference/settings.md` through the resolver that owns
// them. A gate whose dependency graph reaches `vscode` can fail for reasons that
// have nothing to do with what it checks.
//
// The argument for the shape is this codebase's own, from
// `judgeBackendContainment`'s docblock: "a pure function ... so the decision is
// testable without a workspace, a CLI, or a spawn — and so both the admission
// check and the spawn-time check read the same answer instead of each
// implementing it."
//
// NOTHING ABOUT THE LADDER CHANGED. `capability-trust-resolver.ts` reads
// `vscode.workspace.isTrusted` and `inspect()` and calls this; the ordering, the
// deny-precedence and `SILENT_DEFAULT` are as `FR-R3-108` left them. The 16-row
// matrix in `tests/unit/state/capability-trust-resolver.test.ts` was re-pointed at
// this function rather than duplicated: two ladder tables would be a trust
// control with two answers.

export interface CapabilityTrustInputs {
  /** `vscode.workspace.isTrusted`, read by the caller. */
  readonly isTrusted: boolean;
  /** `inspect().workspaceValue` for this capability's setting. */
  readonly workspaceValue: unknown;
  /** `inspect().globalValue` for this capability's setting. */
  readonly globalValue: unknown;
}

/**
 * What a capability resolves to when NEITHER scope has an opinion.
 *
 * FR-R3-108 forced this into the open rather than leaving it as a bare
 * `return true` at the bottom of a ladder. It stays **allow**, and the reasoning
 * is recorded because the review's framing — a control named "trust", default-on
 * and workspace-overridable — argues for deny:
 *
 *   - Workspace trust is already the outer gate, so the remaining exposure needs
 *     BOTH a trusted-but-hostile workspace AND operator silence. The inversion
 *     FR-R3-108 fixed is the part that was actually broken, and it is fixed
 *     regardless of this default.
 *   - Flipping it would stop custom phases loading for every existing operator on
 *     upgrade, and custom phases are what this product runs. That is a first-run
 *     behaviour change for everyone, to close a case an explicit `false` already
 *     closes.
 *
 * The manifest keeps `null` as its declared default, which is NOT the same as
 * leaving this implicit: `null` is a documented third state meaning "follow
 * Workspace Trust", and it is what lets `getResolvedScope` distinguish "nobody
 * spoke" from "someone said yes". Replacing it with `true` would erase that
 * distinction in a trust control.
 *
 * The flip to deny remains available as an operator-facing decision. Taking it
 * would carry a migration story with it — an operator whose phases stop loading
 * must be told why, by name, in the refusal — which is why it is not taken in
 * passing.
 */
export const SILENT_DEFAULT = true;

/** Only the literal booleans short-circuit a layer (invariant I-3). */
export function isExplicitBoolean(value: unknown): value is boolean {
  return value === true || value === false;
}

/**
 * The four-step ladder.
 *
 *   1. untrusted workspace                  -> deny (the ceiling, invariant I-2)
 *   2. an explicit `false` at EITHER scope   -> deny
 *   3. an explicit `true` at either scope    -> allow, workspace first
 *   4. silent at both                        -> `SILENT_DEFAULT`
 *
 * FR-R3-108 — step 2 is ordered before step 3 deliberately, and the ordering IS
 * the rule: checking the VALUES this way makes it "any deny wins", where checking
 * the SCOPES in order would make it "the first scope with an opinion wins" —
 * which is what shipped in feature 059 and let a repository's checked-in `true`
 * defeat an operator's explicit `false`.
 */
export function resolveCapabilityDecision(inputs: CapabilityTrustInputs): boolean {
  if (inputs.isTrusted !== true) return false;
  const { workspaceValue, globalValue } = inputs;
  if (globalValue === false || workspaceValue === false) return false;
  if (isExplicitBoolean(workspaceValue)) return workspaceValue;
  if (isExplicitBoolean(globalValue)) return globalValue;
  return SILENT_DEFAULT;
}
