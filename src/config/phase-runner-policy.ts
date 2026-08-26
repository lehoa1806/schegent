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
