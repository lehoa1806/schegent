import { createHash } from 'node:crypto';
import type { PhaseBinding } from '../contracts/pipeline-definitions';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import { DEFAULT_BACKEND } from '../contracts/backend-kinds';
import { freezeResultContract } from '../contracts/decision-results';
import type { EvidencePolicyOrigin, PhaseDefinition } from '../contracts/process-definitions';
import type { FrozenWorkflowClosure } from '../contracts/run-request';
import type {
  WorkflowDefinition,
  WorkflowFieldError
} from '../contracts/workflow-definitions';
import type { WorkflowRunPipeline } from '../state/workflow-run';
import type { PhaseDef, PipelineDef } from './pipeline-config';
import { resolveHostVerification, writesGitMetadata } from './phase-runner-policy';
import { resolveWorkflowClosure } from './workflow-closure-resolver';

/**
 * Where a frozen policy value came from. An origin the Phase already carries wins, so a re-freeze
 * never reads the value an earlier freeze filled in as a declaration; otherwise the value itself
 * says -- present means the author wrote it, absent means the freeze is about to supply it.
 */
function declarationOrigin(
  carried: EvidencePolicyOrigin | undefined,
  declared: unknown
): EvidencePolicyOrigin {
  return carried ?? (declared === undefined ? 'default' : 'phase-definition');
}

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
  defaultRunner?: BackendRunnerKind,
  /**
   * FR-R3-117 — does a pipeline binding take an output from this Phase position?
   * Output bindings live on the PipelineDef and are addressed by phase index, so
   * a bare PhaseDef cannot see them; the caller that holds the pipeline passes it.
   * Defaulting to `false` is safe: the only Phase whose answer it changes is one
   * that explicitly declared `sideEffects: 'none'` AND is bound to an output,
   * which is a contradiction in the authoring rather than a common shape.
   */
  producesOutput = false
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
    ...(phase.resultContract !== undefined
      ? { resultContract: freezeResultContract(phase.resultContract) }
      : {}),
    evidencePolicy: phase.evidencePolicy ?? 'required',
    // FR-R3-096 — the provenance the value alone cannot carry. `?? 'required'`
    // above has filled in every Phase that declared nothing since the field
    // existed, so the stored value cannot distinguish an author who asked for
    // enforcement from an author who said nothing. This can, and the parser
    // enforces only on `'phase-definition'`.
    //
    // Carried forward when already present rather than recomputed: re-freezing a
    // snapshot would see the DEFAULTED `'required'` above as a declaration and
    // silently grant teeth to a Phase that never asked for them. No caller does
    // that today — all three pass catalog definitions — and the guard costs one
    // `??`, where the failure it prevents is a Phase that stops advancing for
    // reasons nobody authored.
    evidencePolicyDeclaredAt: declarationOrigin(
      phase.evidencePolicyDeclaredAt,
      phase.evidencePolicy
    ),
    // FR-R3-117 — the verdict basis, frozen with the rest of the plan rather than
    // recomputed at read time. A Run's frozen plan must not change meaning if the
    // resolution rule later changes; that is the same "never retargeted in flight"
    // rule the capability set already states.
    hostVerification: resolveHostVerification(
      phase.hostVerification,
      phase.sideEffects,
      producesOutput
    ),
    // Carried forward when present, exactly as `evidencePolicyDeclaredAt` above and
    // for the reason its comment gives -- re-freezing must not read the resolver's
    // own output as a declaration. Here the consequence is sharper: a defaulted
    // `'model-token'` misread as an opt-out leaves a load-bearing Phase judged on
    // its own account, which is the whole defect FR-R3-117 exists to close.
    hostVerificationDeclaredAt: declarationOrigin(
      phase.hostVerificationDeclaredAt,
      phase.hostVerification
    ),
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

function deepCloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepCloneAndFreeze(item))) as unknown as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested !== undefined) {
      copy[key] = deepCloneAndFreeze(nested);
    }
  }
  return Object.freeze(copy) as T;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * FR-R5-F02 — compute a deterministic SHA-256 content digest for a frozen
 * Workflow or Phase definition.
 */
export function computeDefinitionDigest(definition: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(definition)).digest('hex')}`;
}

/**
 * FR-R5-F02 — freeze one PhaseDefinition for a composable Workflow closure.
 */
export function snapshotPhaseDefinition(
  phase: PhaseDefinition,
  defaultRunner?: BackendRunnerKind
): PhaseDefinition {
  const effectiveRunner =
    phase.runner !== undefined
      ? phase.runner
      : writesGitMetadata(phase.sideEffects)
        ? DEFAULT_BACKEND
        : (defaultRunner ?? DEFAULT_BACKEND);
  return deepCloneAndFreeze({
    ...phase,
    version: phase.version ?? 1,
    runner: effectiveRunner,
    sideEffects: phase.sideEffects ?? 'workspace',
    evidencePolicy: phase.evidencePolicy ?? 'required',
    // FR-R3-096 / FR-R3-117 — the value is filled in above, so the stored value can no longer
    // say whether the author asked for it. A Workflow run freezes each Phase a second time when
    // its node run is built (`synthesizePhasePipelineSnapshot` -> `snapshotPhaseDef`), and that
    // freeze reads a value with no origin as a declaration: an omitted `evidencePolicy` would be
    // held to `required` and a resolved `model-token` read as an opt-out nobody made.
    evidencePolicyDeclaredAt: declarationOrigin(
      phase.evidencePolicyDeclaredAt,
      phase.evidencePolicy
    ),
    hostVerification: resolveHostVerification(phase.hostVerification, phase.sideEffects, false),
    hostVerificationDeclaredAt: declarationOrigin(
      phase.hostVerificationDeclaredAt,
      phase.hostVerification
    )
  });
}

/**
 * FR-R5-F02 — freeze one WorkflowDefinition for a composable Workflow closure.
 * Preserves `executionDefaults` in the frozen snapshot for provenance while
 * keeping it strictly advisory.
 */
export function snapshotWorkflowDefinition(workflow: WorkflowDefinition): WorkflowDefinition {
  return deepCloneAndFreeze({
    workflowId: workflow.workflowId,
    name: workflow.name,
    version: workflow.version,
    nodes: workflow.nodes,
    connections: workflow.connections,
    startNodeIds: workflow.startNodeIds,
    ...(workflow.description !== undefined ? { description: workflow.description } : {}),
    ...(workflow.inputs !== undefined ? { inputs: workflow.inputs } : {}),
    ...(workflow.outputs !== undefined ? { outputs: workflow.outputs } : {}),
    ...(workflow.bindings !== undefined ? { bindings: workflow.bindings } : {}),
    ...(workflow.executionDefaults !== undefined
      ? { executionDefaults: { ...workflow.executionDefaults } }
      : {}),
    ...(workflow.recommendedNext !== undefined
      ? { recommendedNext: [...workflow.recommendedNext] }
      : {})
  });
}

export interface CreateFrozenWorkflowClosureInput {
  readonly rootWorkflow: WorkflowDefinition;
  readonly entryNodeId?: string;
  readonly effectiveWorkflows?: readonly WorkflowDefinition[];
  readonly effectivePhases?: readonly PhaseDefinition[];
  readonly invalidWorkflows?: ReadonlyMap<string, string>;
  readonly invalidPhases?: ReadonlyMap<string, string>;
  readonly defaultRunnerKind?: BackendRunnerKind;
}

export type CreateFrozenWorkflowClosureResult =
  | {
      readonly ok: true;
      readonly closure: FrozenWorkflowClosure;
    }
  | {
      readonly ok: false;
      readonly code: 'invalid-entry-node' | 'workflow-closure-invalid';
      readonly message: string;
      readonly errors: readonly WorkflowFieldError[];
    };

/**
 * FR-R5-F02 — resolve, bound-check, and deep-freeze the complete transitive
 * closure of a composable Workflow before admission.
 */
export function createFrozenWorkflowClosure(
  input: CreateFrozenWorkflowClosureInput
): CreateFrozenWorkflowClosureResult {
  const rootNodeIds = new Set(input.rootWorkflow.nodes.map((node) => node.nodeId));
  const resolvedEntryNodeId = input.entryNodeId ?? input.rootWorkflow.startNodeIds[0];

  if (
    resolvedEntryNodeId === undefined ||
    resolvedEntryNodeId.trim().length === 0 ||
    !input.rootWorkflow.startNodeIds.includes(resolvedEntryNodeId) ||
    !rootNodeIds.has(resolvedEntryNodeId)
  ) {
    return {
      ok: false,
      code: 'invalid-entry-node',
      message: `Entry node '${String(resolvedEntryNodeId ?? '')}' is not in root Workflow '${input.rootWorkflow.workflowId}' startNodeIds.`,
      errors: [
        {
          workflowId: input.rootWorkflow.workflowId,
          field: 'entryNodeId',
          code: 'start-node-not-found',
          message: `Entry node '${String(resolvedEntryNodeId ?? '')}' is not a declared start node of '${input.rootWorkflow.workflowId}'.`
        }
      ]
    };
  }

  const allWorkflows = [
    input.rootWorkflow,
    ...(input.effectiveWorkflows ?? []).filter(
      (wf) => wf.workflowId !== input.rootWorkflow.workflowId
    )
  ];
  const allPhases = input.effectivePhases ?? [];

  const closureResult = resolveWorkflowClosure(input.rootWorkflow, {
    effectiveWorkflows: allWorkflows,
    effectivePhases: allPhases,
    ...(input.invalidWorkflows !== undefined
      ? { invalidWorkflows: input.invalidWorkflows }
      : {}),
    ...(input.invalidPhases !== undefined ? { invalidPhases: input.invalidPhases } : {})
  });

  if (!closureResult.ok) {
    return {
      ok: false,
      code: 'workflow-closure-invalid',
      message:
        closureResult.errors[0]?.message ??
        `Workflow '${input.rootWorkflow.workflowId}' closure validation failed.`,
      errors: closureResult.errors
    };
  }

  const workflowsByIdSource = new Map(allWorkflows.map((wf) => [wf.workflowId, wf]));
  const phasesByIdSource = new Map(allPhases.map((phase) => [phase.phaseId, phase]));

  const workflowsById: Record<string, WorkflowDefinition> = {};
  const phasesById: Record<string, PhaseDefinition> = {};
  const definitionDigestsById: Record<string, string> = {};

  const reachableWorkflowIds = new Set<string>([
    input.rootWorkflow.workflowId,
    ...closureResult.referencedWorkflowIds
  ]);

  for (const wfId of reachableWorkflowIds) {
    const wf = workflowsByIdSource.get(wfId);
    if (wf === undefined) continue;
    const childEntry = wf.startNodeIds[0];
    const wfNodeIds = new Set(wf.nodes.map((node) => node.nodeId));
    if (childEntry === undefined || !wfNodeIds.has(childEntry)) {
      return {
        ok: false,
        code: 'workflow-closure-invalid',
        message: `Workflow '${wfId}' has no valid primary start node (startNodeIds[0]).`,
        errors: [
          {
            workflowId: wfId,
            field: 'startNodeIds[0]',
            code: 'start-node-not-found',
            message: `Workflow '${wfId}' has no valid primary start node.`
          }
        ]
      };
    }
    const frozenWf = snapshotWorkflowDefinition(wf);
    const digest = computeDefinitionDigest(frozenWf);
    workflowsById[wfId] = frozenWf;
    definitionDigestsById[wfId] = digest;
    definitionDigestsById[`workflow:${wfId}`] = digest;
  }

  for (const phaseId of closureResult.referencedPhaseIds) {
    const phase = phasesByIdSource.get(phaseId);
    if (phase === undefined) continue;
    const frozenPhase = snapshotPhaseDefinition(phase, input.defaultRunnerKind);
    const digest = computeDefinitionDigest(frozenPhase);
    phasesById[phaseId] = frozenPhase;
    definitionDigestsById[phaseId] = digest;
    definitionDigestsById[`phase:${phaseId}`] = digest;
  }

  return {
    ok: true,
    closure: Object.freeze({
      rootWorkflowId: input.rootWorkflow.workflowId,
      entryNodeId: resolvedEntryNodeId,
      workflowsById: Object.freeze(workflowsById),
      phasesById: Object.freeze(phasesById),
      definitionDigestsById: Object.freeze(definitionDigestsById),
      closureMetrics: Object.freeze({
        maxDepth: closureResult.maxDepthReached,
        definitionCount: closureResult.closureSize,
        expandedNodeCount: closureResult.expandedNodeCount
      })
    })
  };
}

// Feature 099 (T489, FR-042) — `mergePhaseRunnerPolicy` stood here. It carried a
// Git-declaring Phase's pinned runner forward when a *higher-precedence layer*
// redeclared the same id without one, and its only caller was `mergeCatalog`'s
// three-layer Phase loop. With one layer nothing redeclares anything: the
// resolved definition is the only definition, and its `runner` is whatever it
// declares. Deleted rather than kept as an identity function — a merge helper
// with nothing to merge is a claim that layers still exist.
