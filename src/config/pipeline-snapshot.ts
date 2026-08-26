import type { PhaseBinding } from '../contracts/pipeline-definitions';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import { DEFAULT_BACKEND } from '../contracts/backend-kinds';
import type { WorkflowRunPipeline } from '../state/workflow-run';
import type { PhaseDef, PipelineDef } from './pipeline-config';
import { writesGitMetadata } from './phase-runner-policy';

/**
 * Freeze one phase with its effective backend persisted for the run lifetime.
 *
 * Feature 098 T017 — the freeze asks what the Phase DECLARED, and falls back to
 * two literals. It used to ask which id this is, and answer from two lists: the
 * `isBuiltIn` derivation for scope, and `builtInSideEffects` /
 * `builtInEvidencePolicy` underneath it. A Phase the operator imported is by
 * definition not on either list, so it was frozen `unrestricted` whatever it
 * declared — the least contained class, assigned by omission. `workspace` is the
 * default now (FR-005), and the `unrestricted` branch disappearing is the
 * security improvement (data-model.md §2.2).
 *
 * The defaults are written out here rather than derived, because with no
 * built-in layer there is no second value left to choose between.
 */
export function snapshotPhaseDef(
  phase: PhaseDef,
  defaultRunner?: BackendRunnerKind
): PhaseDef {
  return Object.freeze({
    ...phase,
    version: phase.version ?? 1,
    runner: effectiveRunnerKindForPhase(phase, defaultRunner),
    sideEffects: phase.sideEffects ?? 'workspace',
    // FR-R3-086 — the declared capability set is frozen with the plan. Omission
    // stays omission rather than being defaulted to the full set here: the
    // enforcement plan reads an absent set as DEFAULT_CAPABILITY_SET, and
    // writing the full list into every snapshot would make an untouched phase's
    // frozen contract change shape for no behavioural reason.
    capabilities: phase.capabilities === undefined ? undefined : Object.freeze([...phase.capabilities]),
    evidencePolicy: phase.evidencePolicy ?? 'required',
    promptVersion: phase.promptVersion ?? 'custom-v1'
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
 * reference into a Run that is already executing. Every field is named rather
 * than spread, so catalog state cannot leak into a persisted Run (FR-039) — the
 * rule that used to be stated as "`sourceScope` is deliberately dropped", before
 * Feature 099 deleted that field with the layer tier (FR-042).
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

/**
 * Resolve a phase backend while retaining Git capability for a Phase that
 * declares it needs one.
 *
 * Feature 098 T018 — keyed on the declared class rather than on scope plus an id
 * list. The protection is the same and its reach is wider: an imported Phase
 * declaring `git` now keeps it, where before only the five listed built-in ids
 * did. `undefined` declares nothing and takes the configured default, so a Phase
 * that said nothing is unaffected.
 */
export function effectiveRunnerKindForPhase(
  phase: PhaseDef | undefined,
  defaultRunner?: BackendRunnerKind
): BackendRunnerKind {
  if (phase?.runner !== undefined) return phase.runner;
  if (phase !== undefined && writesGitMetadata(phase.sideEffects)) return DEFAULT_BACKEND;
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

// Feature 099 (T489, FR-042) — `mergePhaseRunnerPolicy` stood here. It carried a
// Git-declaring Phase's pinned runner forward when a *higher-precedence layer*
// redeclared the same id without one, and its only caller was `mergeCatalog`'s
// three-layer Phase loop. With one layer nothing redeclares anything: the
// resolved definition is the only definition, and its `runner` is whatever it
// declares. Deleted rather than kept as an identity function — a merge helper
// with nothing to merge is a claim that layers still exist.
