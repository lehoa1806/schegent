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
import { snapshotPhaseDef, snapshotPipelineContract } from '../../config/pipeline-snapshot';
import type { WorkflowDefinition } from '../../contracts/workflow-definitions';
import type { BackendRunnerKind } from '../../runner/backend-runner-factory';
import { createConnectedRun } from '../../state/connected-workflow-run';
import type { ConnectedWorkflowRun } from '../../state/connected-workflow-run';
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
  defaultRunnerKind: BackendRunnerKind | undefined
): WorkflowRunPipeline | ConnectedRunFactoryRejection {
  const definition = catalog.pipelinesById.get(pipelineId);
  if (!definition) return { reason: 'pipeline-not-found', pipelineId };

  const phases: PhaseDef[] = [];
  for (const phaseId of definition.phases) {
    const phase = catalog.phasesById.get(phaseId);
    if (!phase) return { reason: 'pipeline-invalid', pipelineId };
    phases.push(snapshotPhaseDef(phase, defaultRunnerKind));
  }
  return snapshotPipelineContract(definition, phases);
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
    if (pipelines[node.pipelineId] !== undefined) continue;
    const frozen = freezeOne(node.pipelineId, input.catalog, input.defaultRunnerKind);
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
