import type { PhaseBinding } from '../contracts/pipeline-definitions';
import type { BackendRunnerKind } from '../runner/backend-runner-factory';
import { DEFAULT_BACKEND } from '../runner/backend-runner-factory';
import type { WorkflowRunPipeline } from '../state/workflow-run';
import type { PhaseDef, PipelineDef } from './pipeline-config';
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
  const isBuiltIn = phase.sourceScope === 'built-in' || (
    phase.sourceScope === undefined &&
    ((BUILT_IN_PHASE_IDS as readonly string[]).includes(phase.id) || phase.id === 'done')
  );
  return Object.freeze({
    ...phase,
    version: phase.version ?? 1,
    runner: effectiveRunnerKindForPhase(phase, defaultRunner),
    sideEffects: phase.sideEffects ?? (isBuiltIn ? builtInSideEffects(phase.id) : 'unrestricted'),
    evidencePolicy:
      phase.evidencePolicy ?? (isBuiltIn ? builtInEvidencePolicy(phase.id) : 'required'),
    promptVersion: phase.promptVersion ?? (isBuiltIn ? 'builtin-v1' : 'custom-v1')
  });
}

/** An input binding nests its source endpoint, so freezing the row is not enough. */
function snapshotBinding(binding: PhaseBinding): PhaseBinding {
  return binding.kind === 'input'
    ? Object.freeze({ ...binding, source: Object.freeze({ ...binding.source }) })
    : Object.freeze({ ...binding });
}

/**
 * Freeze the complete resolved Pipeline contract for the lifetime of a Run
 * (FR-026, FR-027).
 *
 * Every nested array and object is copied rather than aliased: an operator
 * editing the catalog row afterwards must not be able to reach through a shared
 * reference into a Run that is already executing. `sourceScope` is deliberately
 * dropped — where a definition came from is catalog state, not part of the
 * executable contract, and it has no place in a persisted Run (FR-039).
 *
 * Each optional field is written only when the resolved definition carried it,
 * so a Pipeline that declares no ports produces exactly the pre-feature-082
 * shape and no `STATE_SCHEMA_VERSION` bump is needed (research R8).
 */
export function snapshotPipelineContract(
  pipeline: PipelineDef,
  phases: readonly PhaseDef[]
): WorkflowRunPipeline {
  return Object.freeze({
    id: pipeline.id,
    name: pipeline.name,
    phases: Object.freeze([...phases]),
    ...(pipeline.description !== undefined ? { description: pipeline.description } : {}),
    ...(pipeline.version !== undefined ? { version: pipeline.version } : {}),
    ...(pipeline.inputs !== undefined
      ? { inputs: Object.freeze(pipeline.inputs.map((port) => Object.freeze({ ...port }))) }
      : {}),
    ...(pipeline.outputs !== undefined
      ? { outputs: Object.freeze(pipeline.outputs.map((port) => Object.freeze({ ...port }))) }
      : {}),
    ...(pipeline.bindings !== undefined
      ? { bindings: Object.freeze(pipeline.bindings.map(snapshotBinding)) }
      : {}),
    ...(pipeline.executionDefaults !== undefined
      ? { executionDefaults: Object.freeze({ ...pipeline.executionDefaults }) }
      : {}),
    ...(pipeline.recommendedNext !== undefined
      ? { recommendedNext: Object.freeze([...pipeline.recommendedNext]) }
      : {})
  });
}

/** Resolve a phase backend while retaining protected built-in Git capability. */
export function effectiveRunnerKindForPhase(
  phase: PhaseDef | undefined,
  defaultRunner?: BackendRunnerKind
): BackendRunnerKind {
  if (phase?.runner !== undefined) return phase.runner;
  const isBuiltIn = phase?.sourceScope === 'built-in' || (
    phase !== undefined && phase.sourceScope === undefined &&
    (BUILT_IN_PHASE_IDS as readonly string[]).includes(phase.id)
  );
  if (phase && isBuiltIn && phaseRequiresGitMetadataWrite(phase.id)) return DEFAULT_BACKEND;
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
    next.sourceScope === 'built-in' &&
    phaseRequiresGitMetadataWrite(next.id)
      ? { ...next, runner: prior.runner }
      : next;
}
