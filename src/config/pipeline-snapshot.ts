import type { BackendRunnerKind } from '../runner/backend-runner-factory';
import { DEFAULT_BACKEND } from '../runner/backend-runner-factory';
import type { PhaseDef } from './pipeline-config';
import {
  builtInEvidencePolicy,
  builtInSideEffects,
  phaseRequiresGitMetadataWrite
} from './phase-runner-policy';
import { BUILT_IN_PHASE_IDS } from './pipeline-config';

/** Freeze one phase with its effective backend persisted for the run lifetime. */
export function snapshotPhaseDef(
  phase: PhaseDef,
  defaultRunner?: BackendRunnerKind
): PhaseDef {
  const isBuiltIn = (BUILT_IN_PHASE_IDS as readonly string[]).includes(phase.id) || phase.id === 'done';
  return Object.freeze({
    ...phase,
    runner: effectiveRunnerKindForPhase(phase, defaultRunner),
    sideEffects: phase.sideEffects ?? (isBuiltIn ? builtInSideEffects(phase.id) : 'unrestricted'),
    evidencePolicy:
      phase.evidencePolicy ?? (isBuiltIn ? builtInEvidencePolicy(phase.id) : 'required'),
    promptVersion: phase.promptVersion ?? (isBuiltIn ? 'builtin-v1' : 'custom-v1')
  });
}

/** Resolve a phase backend while retaining protected built-in Git capability. */
export function effectiveRunnerKindForPhase(
  phase: PhaseDef | undefined,
  defaultRunner?: BackendRunnerKind
): BackendRunnerKind {
  if (phase?.runner !== undefined) return phase.runner;
  if (phase && phaseRequiresGitMetadataWrite(phase.id)) return DEFAULT_BACKEND;
  return defaultRunner ?? DEFAULT_BACKEND;
}

/** Pin a stable default while migrating a run created before Feature 074. */
export function resolvePinnedRunnerKind(
  persisted: BackendRunnerKind | undefined,
  sessionOwner: BackendRunnerKind | undefined,
  configured: BackendRunnerKind | undefined
): BackendRunnerKind {
  return persisted ?? sessionOwner ?? configured ?? DEFAULT_BACKEND;
}

/** Preserve a protected built-in's pinned runner across legacy layered overrides. */
export function mergePhaseRunnerPolicy(
  prior: PhaseDef | undefined,
  next: PhaseDef
): PhaseDef {
  return next.runner === undefined &&
    prior?.runner !== undefined &&
    phaseRequiresGitMetadataWrite(next.id)
      ? { ...next, runner: prior.runner }
      : next;
}
