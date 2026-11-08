// Feature 088 (T019, T020) — what a connected run freezes at start.
//
// Two snapshots, taken once and never refreshed:
//
//   * the Workflow graph (FR-003) — deep-copied, so an operator editing the
//     catalog row afterwards cannot reach through a shared reference into a run
//     already underway;
//   * every Pipeline the graph's nodes transitively reference (FR-004), each as
//     the same `WorkflowRunPipeline` a standalone Run freezes.
//
// Both freezes happen in `createConnectedRun()`; this module's job is to resolve
// what goes into them, and to refuse rather than substitute when something does
// not resolve.
//
// The Pipeline half goes through `snapshotPipelineContract()` +
// `snapshotPhaseDef()` — the same two functions `validateRunRequest()`'s own
// `freezePipeline()` calls — so a node's frozen Pipeline is byte-identical to
// what the same Pipeline would freeze as on the standalone launch path. A second
// resolver here would be a second oracle over the effective catalog, which the
// binding hard rule forbids for Pipelines and which is no more acceptable for a
// Workflow (plan D2).

import type { PipelineCatalog, PhaseDef } from '../../config/pipeline-config';
import {
  createFrozenWorkflowClosure,
  snapshotPhaseDef,
  snapshotPipelineContract
} from '../../config/pipeline-snapshot';
import type { CatalogVersionRef } from '../../contracts/catalog-version';
import type { PhaseDefinition } from '../../contracts/process-definitions';
import type {
  FrozenWorkflowClosure,
  ResolvedPortValue
} from '../../contracts/run-request';
import type { WorkflowDefinition } from '../../contracts/workflow-definitions';
import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import {
  attemptsForNode,
  createConnectedRun,
  createInvocationFrame,
  deriveNodePath,
  type ConnectedRunLaunchContext,
  type ConnectedWorkflowRun,
  type InvocationInputEnvelope,
  type NodeAttemptRecord,
  type WorkflowInvocationFrame
} from '../../state/connected-workflow-run';
import type { WorkflowRunPipeline } from '../../state/workflow-run';

/**
 * Why a connected run could not be opened. Both arms name the Pipeline at fault:
 * a Workflow's node may reference a Pipeline the catalog no longer holds, and
 * without that name the operator has a graph and no idea which node to look at.
 */
export type ConnectedRunFactoryRejection =
  | { readonly reason: 'pipeline-not-found'; readonly pipelineId: string }
  | { readonly reason: 'pipeline-invalid'; readonly pipelineId: string };

export type ConnectedRunFactoryResult =
  | { readonly outcome: 'created'; readonly run: ConnectedWorkflowRun }
  | ({ readonly outcome: 'rejected' } & ConnectedRunFactoryRejection);

export interface ConnectedRunFactoryInput {
  readonly connectedRunId: string;
  /** As resolved from the effective Workflow catalog, before any freeze. */
  readonly workflow: WorkflowDefinition;
  readonly catalog: PipelineCatalog;
  readonly startedAt: number;
  /** The backend a Phase inherits when it names none, pinned for the run's life. */
  readonly defaultRunnerKind?: BackendRunnerKind;
  /**
   * Feature 092 (T080, FR-041) — the queue the run binds to, pinned for its
   * life alongside the two snapshots. Absent means the default queue; the
   * default is applied on read, not written here (FR-046).
   */
  readonly queueId?: string;
  /**
   * Feature 102 (T037, FR-021, FR-026) — which published version each member
   * Pipeline's body came from, resolved at this freeze and pinned with it.
   *
   * Here rather than at each member start, because a member start supplies its
   * body from this snapshot: re-resolving there would stamp today's Active
   * version beside a body frozen at start, which is precisely the version the
   * system did not resolve. The port takes a Pipeline id and returns a Pipeline's
   * version — a Workflow's own version is never asked for, so FR-026 is
   * unreachable rather than merely untested.
   *
   * Optional. Absent yields snapshots with no version, recorded as "not
   * recorded" (FR-027).
   */
  readonly resolveCatalogVersion?: (pipelineId: string) => CatalogVersionRef | undefined;
}

/**
 * Freeze one Pipeline exactly as a standalone Run would, or say why not.
 *
 * A Phase the catalog lost is `pipeline-invalid`, never `done` and never
 * silently dropped: a shorter sequence than the one the operator read is not a
 * degraded run, it is a different one.
 */
function freezeOne(
  pipelineId: string,
  catalog: PipelineCatalog,
  defaultRunnerKind: BackendRunnerKind | undefined,
  resolveCatalogVersion: ((pipelineId: string) => CatalogVersionRef | undefined) | undefined
): WorkflowRunPipeline | ConnectedRunFactoryRejection {
  const definition = catalog.pipelinesById.get(pipelineId);
  if (!definition) return { reason: 'pipeline-not-found', pipelineId };

  const phases: PhaseDef[] = [];
  for (const phaseId of definition.phases) {
    const phase = catalog.phasesById.get(phaseId);
    if (!phase) return { reason: 'pipeline-invalid', pipelineId };
    phases.push(snapshotPhaseDef(phase, defaultRunnerKind));
  }
  const contract = snapshotPipelineContract(definition, phases);
  // Stamped after the snapshot, never inside it. `snapshotPipelineContract()`
  // names every field it copies and copies only definition fields, which is what
  // keeps catalog state out of a persisted Run; the version is not a definition
  // field but a fact about which stored revision this definition was read from,
  // so it is added here by the caller that knows it.
  const catalogVersion = resolveCatalogVersion?.(pipelineId);
  return catalogVersion === undefined ? contract : { ...contract, catalogVersion };
}

/**
 * Open a connected run over a frozen graph and a frozen Pipeline set (FR-003,
 * FR-004).
 *
 * Every node's Pipeline is frozen up front rather than lazily at each node's
 * start. A Workflow that references a Pipeline the catalog cannot resolve is
 * refused whole, at the one moment the operator is looking at it — resolving
 * node by node would start the graph and strand it several nodes in, with work
 * already done and nothing to continue to.
 *
 * "Transitively referenced" is exactly one level here: a node names a Pipeline,
 * and a Pipeline names Phases. A Pipeline cannot name another Pipeline, so there
 * is no deeper closure to walk and no cycle to guard against.
 */
export function createConnectedRunSnapshot(
  input: ConnectedRunFactoryInput
): ConnectedRunFactoryResult {
  const pipelines: Record<string, WorkflowRunPipeline> = {};
  for (const node of input.workflow.nodes) {
    // Two nodes may name the same Pipeline (FR-003); it is frozen once, and both
    // read the same snapshot.
    if (node.pipelineId === undefined || pipelines[node.pipelineId] !== undefined) continue;
    const frozen = freezeOne(
      node.pipelineId,
      input.catalog,
      input.defaultRunnerKind,
      input.resolveCatalogVersion
    );
    if ('reason' in frozen) return { outcome: 'rejected', ...frozen };
    pipelines[node.pipelineId] = frozen;
  }

  return {
    outcome: 'created',
    run: createConnectedRun({
      connectedRunId: input.connectedRunId,
      workflowId: input.workflow.workflowId,
      graph: input.workflow,
      pipelines,
      startedAt: input.startedAt,
      ...(input.queueId !== undefined ? { queueId: input.queueId } : {})
    })
  };
}

export interface ComposableWorkflowRunFactoryInput {
  readonly connectedRunId: string;
  readonly workflow: WorkflowDefinition;
  readonly entryNodeId?: string;
  readonly effectiveWorkflows?: readonly WorkflowDefinition[];
  readonly effectivePhases?: readonly PhaseDefinition[];
  readonly catalog?: PipelineCatalog;
  readonly startedAt: number;
  readonly defaultRunnerKind?: BackendRunnerKind;
  readonly queueId?: string;
  readonly boundInputs?: Readonly<Record<string, ResolvedPortValue>>;
  readonly frozenClosure?: FrozenWorkflowClosure;
  readonly launchContext?: ConnectedRunLaunchContext;
  readonly resolveCatalogVersion?: (id: string) => CatalogVersionRef | undefined;
}

export type ComposableWorkflowRunFactoryRejection =
  | { readonly reason: 'invalid-entry-node'; readonly detail: string }
  | { readonly reason: 'workflow-closure-invalid'; readonly detail: string }
  | { readonly reason: 'unsupported-control-version'; readonly detail: string };

export type ComposableWorkflowRunFactoryResult =
  | {
      readonly outcome: 'created';
      readonly run: ConnectedWorkflowRun;
      readonly rootInvocationId: string;
    }
  | ({ readonly outcome: 'rejected' } & ComposableWorkflowRunFactoryRejection);

/**
 * FR-R5-F02 — synthesize a single-Phase `WorkflowRunPipeline` from a frozen
 * `PhaseDefinition` so Phase-node execution reuses the runner boundary cleanly.
 */
export function synthesizePhasePipelineSnapshot(
  phase: PhaseDefinition,
  defaultRunnerKind?: BackendRunnerKind,
  catalogVersion?: CatalogVersionRef
): WorkflowRunPipeline {
  const phaseDef: PhaseDef = snapshotPhaseDef(
    {
      ...phase,
      id: phase.phaseId
    },
    defaultRunnerKind
  );
  const contract = snapshotPipelineContract(
    {
      id: phase.phaseId,
      name: phase.name,
      phases: [phase.phaseId],
      ...(phase.description !== undefined ? { description: phase.description } : {}),
      ...(phase.version !== undefined ? { version: phase.version } : {})
    },
    [phaseDef]
  );
  return catalogVersion === undefined ? contract : Object.freeze({ ...contract, catalogVersion });
}

/**
 * FR-R5-F02 — create a root `ConnectedWorkflowRun` with its frozen transitive
 * closure and root `WorkflowInvocationFrame`.
 */
export function createComposableWorkflowRunSnapshot(
  input: ComposableWorkflowRunFactoryInput
): ComposableWorkflowRunFactoryResult {
  const phasesFromCatalog: PhaseDefinition[] =
    input.effectivePhases !== undefined
      ? [...input.effectivePhases]
      : input.catalog !== undefined
        ? [...input.catalog.phasesById.values()].map((p): PhaseDefinition => {
            const { instruction, skill, id, ...rest } = p;
            if (skill !== undefined) {
              return {
                ...rest,
                phaseId: id,
                version: p.version ?? 1,
                skill
              };
            }
            return {
              ...rest,
              phaseId: id,
              version: p.version ?? 1,
              instruction: instruction ?? ''
            };
          })
        : [];

  let closure: FrozenWorkflowClosure;
  if (input.frozenClosure !== undefined) {
    closure = input.frozenClosure;
  } else {
    const closureOutcome = createFrozenWorkflowClosure({
      rootWorkflow: input.workflow,
      ...(input.entryNodeId !== undefined ? { entryNodeId: input.entryNodeId } : {}),
      effectiveWorkflows: input.effectiveWorkflows ?? [],
      effectivePhases: phasesFromCatalog,
      ...(input.defaultRunnerKind !== undefined
        ? { defaultRunnerKind: input.defaultRunnerKind }
        : {})
    });
    if (!closureOutcome.ok) {
      return {
        outcome: 'rejected',
        reason: closureOutcome.code,
        detail: closureOutcome.message
      };
    }

    if (input.resolveCatalogVersion !== undefined) {
      const catalogVersionsById: Record<string, CatalogVersionRef> = {};
      for (const wfId of Object.keys(closureOutcome.closure.workflowsById)) {
        const ref = input.resolveCatalogVersion(wfId);
        if (ref !== undefined) catalogVersionsById[wfId] = ref;
      }
      for (const phaseId of Object.keys(closureOutcome.closure.phasesById)) {
        const ref = input.resolveCatalogVersion(phaseId);
        if (ref !== undefined) catalogVersionsById[phaseId] = ref;
      }
      closure = Object.freeze({
        ...closureOutcome.closure,
        catalogVersionsById: Object.freeze(catalogVersionsById)
      });
    } else {
      closure = closureOutcome.closure;
    }
  }

  const pipelines: Record<string, WorkflowRunPipeline> = {};
  for (const [phaseId, phase] of Object.entries(closure.phasesById)) {
    const catalogVersion = closure.catalogVersionsById?.[phaseId];
    pipelines[phaseId] = synthesizePhasePipelineSnapshot(
      phase,
      input.defaultRunnerKind,
      catalogVersion
    );
  }

  const rootInvocationId = `${input.connectedRunId}:root`;
  const rootFrame = createInvocationFrame({
    invocationId: rootInvocationId,
    rootRunId: input.connectedRunId,
    parentInvocationId: null,
    parentCallNodeId: null,
    parentAttemptId: null,
    workflowId: closure.rootWorkflowId,
    depth: 0,
    nodePath: deriveNodePath('', closure.entryNodeId),
    entryNodeId: closure.entryNodeId,
    boundInputs: input.boundInputs ?? {},
    startedAt: input.startedAt
  });

  const run = createConnectedRun({
    connectedRunId: input.connectedRunId,
    workflowId: closure.rootWorkflowId,
    graph: closure.workflowsById[closure.rootWorkflowId] ?? input.workflow,
    pipelines,
    startedAt: input.startedAt,
    ...(input.queueId !== undefined ? { queueId: input.queueId } : {}),
    frozenClosure: closure,
    ...(input.launchContext !== undefined ? { launchContext: input.launchContext } : {}),
    invocations: { [rootInvocationId]: rootFrame }
  });

  return {
    outcome: 'created',
    run,
    rootInvocationId
  };
}

export interface CreateChildInvocationInput {
  readonly parentFrame: WorkflowInvocationFrame;
  readonly callNodeId: string;
  readonly parentAttemptId: string;
  readonly childWorkflow: WorkflowDefinition;
  readonly boundInputs: Readonly<Record<string, ResolvedPortValue>>;
  readonly startedAt: number;
}

/**
 * FR-R5-F02 — create a child `WorkflowInvocationFrame` when a parent Workflow
 * node invokes a nested `workflow` definition. Always enters at `childWorkflow.startNodeIds[0]`.
 */
export function createChildWorkflowInvocationFrame(
  input: CreateChildInvocationInput
): WorkflowInvocationFrame {
  const childEntryNodeId = input.childWorkflow.startNodeIds[0] ?? '';
  const callPath =
    input.parentFrame.depth === 0
      ? deriveNodePath('', input.callNodeId)
      : deriveNodePath(input.parentFrame.nodePath, input.callNodeId);
  const childNodePath = deriveNodePath(callPath, childEntryNodeId);
  const invocationId = `${input.parentFrame.invocationId}:${input.callNodeId}:${input.parentAttemptId}`;
  return createInvocationFrame({
    invocationId,
    rootRunId: input.parentFrame.rootRunId,
    parentInvocationId: input.parentFrame.invocationId,
    parentCallNodeId: input.callNodeId,
    parentAttemptId: input.parentAttemptId,
    workflowId: input.childWorkflow.workflowId,
    depth: input.parentFrame.depth + 1,
    nodePath: childNodePath,
    entryNodeId: childEntryNodeId,
    boundInputs: input.boundInputs,
    startedAt: input.startedAt
  });
}

export interface CreateNodeAttemptInput {
  readonly frame: WorkflowInvocationFrame;
  readonly nodeId: string;
  readonly nodeKind: 'phase' | 'workflow';
  readonly targetDefinitionId: string;
  readonly inputEnvelope: InvocationInputEnvelope;
  readonly startedAt: number;
  readonly status?: 'pending-dispatch' | 'in-flight';
  readonly queueItemId?: string;
  readonly childInvocationId?: string;
}

/**
 * FR-R5-F02 — construct a `NodeAttemptRecord` with deterministic 1-based
 * `attemptIndex` and hierarchical `nodePath`.
 */
export function createNodeAttemptRecord(input: CreateNodeAttemptInput): NodeAttemptRecord {
  const existingAttempts = attemptsForNode(input.frame, input.nodeId);
  const attemptIndex = existingAttempts.length + 1;
  const attemptId = `${input.frame.invocationId}:${input.nodeId}:attempt-${attemptIndex}`;
  const parentPrefix =
    input.frame.parentInvocationId === null
      ? ''
      : input.frame.nodePath.slice(0, input.frame.nodePath.lastIndexOf('/'));
  const nodePath = deriveNodePath(parentPrefix, input.nodeId);

  return Object.freeze({
    attemptId,
    attemptIndex,
    rootRunId: input.frame.rootRunId,
    invocationId: input.frame.invocationId,
    parentInvocationId: input.frame.parentInvocationId,
    nodePath,
    nodeId: input.nodeId,
    nodeKind: input.nodeKind,
    targetDefinitionId: input.targetDefinitionId,
    status: input.status ?? 'in-flight',
    startedAt: input.startedAt,
    ...(input.queueItemId !== undefined ? { queueItemId: input.queueItemId } : {}),
    ...(input.childInvocationId !== undefined
      ? { childInvocationId: input.childInvocationId }
      : {}),
    inputEnvelope: input.inputEnvelope,
    declaredOutputs: Object.freeze({})
  });
}
