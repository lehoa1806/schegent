import type { BackendRunnerKind } from '../runner/backend-runner-factory';

/** Built-in phases whose instructions create commits or change branches. */
export const GIT_METADATA_WRITE_PHASE_IDS: ReadonlySet<string> = new Set([
  'speckit-specify',
  'specify-brainstorm',
  'superpowers-implement',
  'finalize',
  'superpowers-review-close'
]);

export function phaseRequiresGitMetadataWrite(phaseId: string): boolean {
  return GIT_METADATA_WRITE_PHASE_IDS.has(phaseId);
}

export function phaseRunnerPolicyError(
  phaseId: string,
  runner: BackendRunnerKind | undefined
): string | null {
  if (!phaseRequiresGitMetadataWrite(phaseId)) return null;
  if (runner === 'claude' || runner === 'agy') return null;
  return `Phase '${phaseId}' must explicitly use a Git-capable runner (claude or agy); Codex workspace-write keeps .git read-only`;
}

export function assertPhaseRunnerPolicy(
  phaseId: string,
  runner: BackendRunnerKind
): void {
  const error = phaseRunnerPolicyError(phaseId, runner);
  if (error !== null) throw new Error(error);
}
