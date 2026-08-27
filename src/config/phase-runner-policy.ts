// Feature 098 T018 — the Git-runner rule asks what the Phase does, not what it
// is called.
//
// This module used to hold `GIT_METADATA_WRITE_PHASE_IDS`, a set of five ids,
// and a rule that read: if the Phase is one of these five, its runner must be
// Git-capable. Two things were wrong with that once the built-in layer goes
// away. A Phase that genuinely writes Git metadata under any other id was
// unprotected — the rule could not see it, so an operator's imported commit
// Phase would run under a Codex workspace-write sandbox with `.git` read-only
// and fail mid-run. And the five ids stopped meaning anything, because nothing
// ships them any more.
//
// There is deliberately **no replacement id list** (FR-008). The declared
// containment class is the whole input, so an id carries no authority here and
// a Phase named `finalize` is admitted or refused on exactly the same terms as
// one named anything else.

import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { PhaseHostVerification } from '../contracts/process-definitions';
import type { PhaseSideEffects } from './pipeline-config';

/**
 * Whether a Phase's declared containment class includes writing Git metadata.
 *
 * `undefined` is not `git`: an undeclared Phase takes the `workspace` default at
 * the freeze (FR-005), and answering `true` for it here would refuse every
 * Codex-run Phase that simply said nothing.
 */
export function writesGitMetadata(sideEffects: PhaseSideEffects | undefined): boolean {
  return sideEffects === 'git';
}

export function phaseRunnerPolicyError(
  phaseId: string,
  sideEffects: PhaseSideEffects | undefined,
  runner: BackendRunnerKind | undefined
): string | null {
  if (!writesGitMetadata(sideEffects)) return null;
  if (runner === 'claude' || runner === 'agy') return null;
  return `Phase '${phaseId}' must explicitly use a Git-capable runner (claude or agy); Codex workspace-write keeps .git read-only`;
}

export function assertPhaseRunnerPolicy(
  phaseId: string,
  sideEffects: PhaseSideEffects | undefined,
  runner: BackendRunnerKind
): void {
  const error = phaseRunnerPolicyError(phaseId, sideEffects, runner);
  if (error !== null) throw new Error(error);
}

// ---------------------------------------------------------------------------
// FR-R3-117 — the verdict basis, and why omission changed meaning.
// ---------------------------------------------------------------------------
//
// FR-R3-058 built the mechanism that stops a Phase advancing on its own account
// and shipped it OPT-IN: `hostVerification: 'exit-code'` is judged on the
// process's exit status, and a clean termination token cannot override a
// non-zero exit or a timeout. A Phase that declared nothing was judged on the
// model's own report — so a failed build, a failed test run or a crashed tool
// reported success, which the threat model stated in its own words.
//
// That default is now inverted for the Phases whose claims are load-bearing.
//
// WHY THE TRIGGER READS THE RESOLVED VALUE. `FR-R3-117` phrased it as "any Phase
// that DECLARES `sideEffects`". Against this codebase that is not well defined:
// `sideEffects` is optional on the wire and `snapshotPhaseDef` resolves omission
// to `'workspace'` (FR-005), so every Phase has a resolved value and none can be
// said to have declared nothing by the time anything reads it. Reading wire
// presence would make the verdict depend on whether an author typed a field
// whose omission already means something. So the trigger is the RESOLVED class.
//
// THE BLAST RADIUS, STATED RATHER THAN DISCOVERED. Because `'workspace'` is the
// resolved default, most existing Phases become exit-code-judged. That is the
// intent — those are exactly the Phases whose claims matter — and it is why
// RELEASE.md records this as breaking and names the opt-out.

/**
 * Is this Phase's claim load-bearing — does it touch anything, or promise an
 * output?
 *
 * `'none'` is the only class that is not. A Phase declaring `'none'` neither
 * writes the workspace nor Git nor anything outside, so its report is advisory
 * and judging it on exit status would break purely-advisory Phases for no gain.
 */
export function claimIsLoadBearing(
  sideEffects: PhaseSideEffects | undefined,
  producesOutput = false
): boolean {
  return (sideEffects ?? 'workspace') !== 'none' || producesOutput;
}

/**
 * The verdict basis for a Phase, resolved.
 *
 * Omission means the default this computes. Explicit `'model-token'` is the
 * OPT-OUT — the only way to get self-report on a load-bearing Phase — and needs
 * no new enum value, because the closed set already holds both members.
 */
export function resolveHostVerification(
  declared: PhaseHostVerification | undefined,
  sideEffects: PhaseSideEffects | undefined,
  producesOutput = false
): PhaseHostVerification {
  if (declared !== undefined) return declared;
  return claimIsLoadBearing(sideEffects, producesOutput) ? 'exit-code' : 'model-token';
}
