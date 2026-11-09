// Feature 089 T014 — continue one connected Workflow run without the editor host.
// Contract: specs/089-headless-parity-qualification/contracts/headless-api.md §4
//
// A delegate over `continuation-service.ts`, which owns every gate a continuation
// has: the run lookup, the revision compare-and-set, the eligibility fold, the
// node start, and the compare-and-set write. This module adds none of them
// (FR-011).
//
// **Nothing here reads a catalog.** Everything a continuation resolves comes from
// the run's own frozen graph and its frozen Pipeline snapshot, so a Pipeline
// edited, reordered, or deleted since the run started cannot reach a run already
// underway (FR-032). That is the same rule the standing project invariant states
// for an in-flight `WorkflowRun.pipeline`, holding on a second adapter.
//
// The workspace root and the clock are both **values** (data-model.md §2). The
// clock especially: a service that reads it directly cannot be tested for the
// ordering properties this platform depends on.
//
// This module imports no editor host API (FR-007).

import {
  continueConnectedRun,
  continueWaitingHandoff,
  type ContinuationDeps,
  type ContinuationInput,
  type ContinueWaitingHandoffDeps,
  type ContinueWaitingHandoffInput,
  type ContinueWaitingHandoffResult
} from '../services/workflow-execution/continuation-service';
import {
  dispatchComposableNode,
  type ComposableWorkflowCoordinatorDeps,
  type ComposableWorkflowStepResult
} from '../services/workflow-execution/connected-run-coordinator';
import {
  WorkflowControlService,
  type WorkflowControlCommandOutcome,
  type WorkflowControlCommandRequest,
  type WorkflowControlServiceDeps
} from '../services/workflow-execution/workflow-control-service';
import {
  WorkflowRecoveryService,
  type ReconcileConnectedRunResult,
  type WorkflowRecoveryServiceDeps
} from '../services/workflow-execution/workflow-recovery-service';
import {
  buildAncestryEvidenceMetadata,
  buildControlProjection,
  buildWorkflowRunControlProjection,
  type AncestryEvidenceMetadata,
  type BuildControlProjectionInput,
  type WorkflowRunControlProjection
} from '../services/workflow-execution/workflow-control-projector';
import {
  ControlCommandService,
  type ControlCommandServiceDeps
} from '../services/workflow-execution/control-command-service';
import {
  getOrCreateProductionWorkflowComposition,
  type ProductionWorkflowComposition
} from '../services/workflow-execution/production-workflow-composition';
import {
  executeSharedContractOperation,
  type SharedContractBoundaryResult
} from '../services/shared-memory-storage/shared-contract-entry-boundary';
import type { StorageBoundaryOutcome } from '../contracts/shared-memory-storage/inventories';
import type { ConnectedWorkflowRun } from '../state/connected-workflow-run';
import {
  launchComposableWorkflow,
  type LaunchWorkflowResult,
  type WorkflowLauncherDeps
} from '../services/workflow-execution/workflow-launcher';
import {
  validateRunRequest,
  type EffectiveWorkflowSource
} from '../services/run-request/run-request-validator';
import type { WorkflowRunRequest } from '../contracts/run-request';
import type {
  ContinueWorkflowResult,
  ControlCommandAcknowledgement,
  ControlProjection
} from '../contracts/sidebar-ipc';
import {
  checkContinuationArgs,
  checkQueueId,
  checkRunRequest,
  checkWorkspaceRoot,
  type BoundaryRefusal
} from './process-api-validators';

export type ContinueWorkflowRunInput = ContinuationInput;

/**
 * Start one eligible node of a connected run (FR-011, FR-032).
 *
 * The argument check is the continue command's own wire validator, unchanged, so
 * the run id bound, the revision, the node id bound, and the nested run request
 * are held to exactly what the sidebar holds them to (FR-015).
 */
export async function continueWorkflowRun(
  deps: ContinuationDeps,
  input: ContinueWorkflowRunInput
): Promise<ContinueWorkflowResult | BoundaryRefusal> {
  const rootRefusal = checkWorkspaceRoot(input?.workspaceRoot);
  if (rootRefusal !== null) return rootRefusal;
  const payloadRefusal = checkContinuationArgs(input.payload);
  if (payloadRefusal !== null) return payloadRefusal;
  if (!Number.isFinite(input.startedAt)) {
    return { outcome: 'rejected-argument', field: 'startedAt', code: 'wrong-type' };
  }

  return continueConnectedRun(deps, input);
}

// ---------------------------------------------------------------------------
// FR-R5-F02 (T023, FR-018) — Headless composable Workflow launch & handoff
// ---------------------------------------------------------------------------

export interface LaunchComposableWorkflowRunInput {
  readonly connectedRunId: string;
  readonly request: WorkflowRunRequest;
  readonly workflowSource: EffectiveWorkflowSource;
  readonly workspaceRoot: string | null;
  readonly startedAt: number;
  readonly queueId?: string;
  readonly releaseRootLease?: (
    queueId: string,
    connectedRunId: string
  ) => Promise<void> | void;
}

/**
 * Validate a `WorkflowRunRequest`, freeze its transitive `FrozenWorkflowClosure`
 * into an `ExecutionEnvelope`, and launch the root composable Workflow run
 * through the shared `WorkflowLauncher` service (FR-001, FR-003, FR-017, FR-018).
 */
export async function launchComposableWorkflowRun(
  deps: WorkflowLauncherDeps,
  input: LaunchComposableWorkflowRunInput
): Promise<LaunchWorkflowResult | BoundaryRefusal> {
  const rootRefusal = checkWorkspaceRoot(input?.workspaceRoot);
  if (rootRefusal !== null) return rootRefusal;
  const requestRefusal = checkRunRequest(input.request);
  if (requestRefusal !== null) return requestRefusal;
  const queueRefusal = checkQueueId(input.queueId);
  if (queueRefusal !== null) return queueRefusal;
  if (!Number.isFinite(input.startedAt)) {
    return { outcome: 'rejected-argument', field: 'startedAt', code: 'wrong-type' };
  }

  const validation = await validateRunRequest(input.request, {
    workflow: input.workflowSource,
    workspaceRoot: input.workspaceRoot,
    now: input.startedAt,
    localInputs: {
      checkFile: async () => ({ ok: true }),
      checkFolder: async () => ({ ok: true })
    },
    outputProbe: {
      exists: async () => false
    },
    priorOutputs: {
      outputsFor: () => null
    }
  });
  if (!validation.ok) {
    if (input.releaseRootLease !== undefined) {
      await input.releaseRootLease(input.queueId ?? 'default', input.connectedRunId);
    }
    return { outcome: 'rejected-validation', errors: validation.errors };
  }

  return launchComposableWorkflow(deps, {
    connectedRunId: input.connectedRunId,
    envelope: validation.plan,
    workspaceRoot: input.workspaceRoot,
    startedAt: input.startedAt,
    entryPointId: 'headless.launchWorkflow',
    ...(input.queueId !== undefined ? { queueId: input.queueId } : {}),
    ...(input.releaseRootLease !== undefined
      ? { releaseRootLease: input.releaseRootLease }
      : {})
  });
}

export interface ContinueComposableWorkflowHandoffInput extends ContinueWaitingHandoffInput {
  readonly workspaceRoot: string | null;
}

export type ContinueComposableWorkflowHandoffResult =
  | Exclude<ContinueWaitingHandoffResult, { readonly outcome: 'accepted' }>
  | ComposableWorkflowStepResult
  | BoundaryRefusal;

/**
 * Accept operator handoff inputs at a `waiting-for-handoff` boundary, persist
 * an immutable `InvocationInputEnvelope` (`acceptedAt`), and dispatch the target
 * node through the shared coordinator without mutating `FrozenWorkflowClosure`
 * (FR-015, FR-016, FR-018).
 */
export async function continueComposableWorkflowHandoff(
  deps: ContinueWaitingHandoffDeps & ComposableWorkflowCoordinatorDeps & {
    readonly productionComposition?: ProductionWorkflowComposition;
  },
  input: ContinueComposableWorkflowHandoffInput
): Promise<ContinueComposableWorkflowHandoffResult> {
  const rootRefusal = checkWorkspaceRoot(input?.workspaceRoot);
  if (rootRefusal !== null) return rootRefusal;
  if (!Number.isFinite(input.acceptedAt)) {
    return { outcome: 'rejected-argument', field: 'acceptedAt', code: 'wrong-type' };
  }

  const accepted = await continueWaitingHandoff(deps, input);
  if (accepted.outcome !== 'accepted') {
    return accepted;
  }

  const composition =
    deps.productionComposition ??
    getOrCreateProductionWorkflowComposition(deps.connectedRuns, {
      ...(input.workspaceRoot !== null ? { workspaceRoot: input.workspaceRoot } : {})
    });

  return dispatchComposableNode(
    {
      ...composition.createCoordinatorDeps({
        connectedRuns: deps.connectedRuns,
        dispatchPhase: deps.dispatchPhase,
        ...(input.workspaceRoot !== null ? { workspaceRoot: input.workspaceRoot } : {}),
        ...(deps.cancelOrphanedQueueItem !== undefined
          ? { cancelOrphanedQueueItem: deps.cancelOrphanedQueueItem }
          : {})
      }),
      ...deps
    },
    {
      run: accepted.run,
      invocationId: input.invocationId,
      nodeId: input.targetNodeId,
      startedAt: input.acceptedAt
    }
  );
}

// ---------------------------------------------------------------------------
// FR-R5-F03 (T009, T015) — Headless controls, scoped retry, recovery & projections
// ---------------------------------------------------------------------------

/**
 * Execute a nested workflow control command (`pause`, `resume`, `cancel`,
 * `retry-phase`, `retry-invocation`, `continue-handoff`) through the shared
 * `WorkflowControlService` with `commandId` idempotency and `expectedRevision`
 * compare-and-set.
 */
export async function executeComposableWorkflowControlCommand(
  deps: WorkflowControlServiceDeps & {
    readonly productionComposition?: ProductionWorkflowComposition;
  },
  request: WorkflowControlCommandRequest
): Promise<WorkflowControlCommandOutcome | BoundaryRefusal> {
  if (typeof request?.runId !== 'string' || request.runId.trim().length === 0) {
    return { outcome: 'rejected-argument', field: 'runId', code: 'missing' };
  }
  if (typeof request?.commandId !== 'string' || request.commandId.trim().length === 0) {
    return { outcome: 'rejected-argument', field: 'commandId', code: 'missing' };
  }
  if (!Number.isInteger(request.expectedRevision) || request.expectedRevision < 1) {
    return { outcome: 'rejected-argument', field: 'expectedRevision', code: 'wrong-type' };
  }
  if (!Number.isFinite(request.now)) {
    return { outcome: 'rejected-argument', field: 'now', code: 'wrong-type' };
  }
  const composition =
    deps.productionComposition ??
    getOrCreateProductionWorkflowComposition(deps.connectedRuns, {
      ...(deps.workspaceRoot !== undefined ? { workspaceRoot: deps.workspaceRoot } : {})
    });
  const service = new WorkflowControlService({
    controlAdmission: composition.controlAdmission,
    repeatExecutor: composition.repeatExecutor,
    forEachExecutor: composition.forEachExecutor,
    controlCommandService: composition.controlCommandService,
    ...deps
  });
  return service.executeCommand(request);
}

/**
 * Reconcile a persisted `ConnectedWorkflowRun` on startup/restart through the
 * shared `WorkflowRecoveryService`.
 */
export async function recoverComposableWorkflowRun(
  deps: WorkflowRecoveryServiceDeps & {
    readonly productionComposition?: ProductionWorkflowComposition;
  },
  input: { readonly runId: string; readonly now: number }
): Promise<ReconcileConnectedRunResult | BoundaryRefusal | undefined> {
  if (typeof input?.runId !== 'string' || input.runId.trim().length === 0) {
    return { outcome: 'rejected-argument', field: 'runId', code: 'missing' };
  }
  if (!Number.isFinite(input.now)) {
    return { outcome: 'rejected-argument', field: 'now', code: 'wrong-type' };
  }
  const composition =
    deps.productionComposition ??
    getOrCreateProductionWorkflowComposition(deps.connectedRuns, {
      ...(deps.workspaceRoot !== undefined ? { workspaceRoot: deps.workspaceRoot } : {})
    });
  const service = new WorkflowRecoveryService({
    controlAdmission: composition.controlAdmission,
    repeatExecutor: composition.repeatExecutor,
    forEachExecutor: composition.forEachExecutor,
    quotaPermitArbiter: composition.quotaPermitArbiter,
    notificationService: composition.notificationService,
    usageAccounting: composition.usageAccounting,
    ...deps
  });
  return service.reconcileRun(input.runId, input.now);
}

/**
 * Compute the authoritative `WorkflowRunControlProjection` for a nested run.
 */
export function getComposableWorkflowControlProjection(
  run: ConnectedWorkflowRun
): WorkflowRunControlProjection {
  return buildWorkflowRunControlProjection(run);
}

/**
 * Build bounded `AncestryEvidenceMetadata` (`rootRunId`, `invocationId`,
 * `parentInvocationId`, `nodePath`, `attemptId`, `attemptIndex`, `queueId`)
 * for an invocation and optional node within a nested run.
 */
export function buildComposableWorkflowAncestryEvidence(
  run: ConnectedWorkflowRun,
  invocationId: string,
  nodeId?: string | undefined
): AncestryEvidenceMetadata | undefined {
  return buildAncestryEvidenceMetadata(run, invocationId, nodeId);
}

// ---------------------------------------------------------------------------
// FR-R5-F31 (T006) — Headless candidate-block control commands & projection
// ---------------------------------------------------------------------------

/**
 * Execute a version-1 `ControlCommandEnvelope` against the shared
 * `ControlCommandService`, enforcing identical validation, receipt deduplication,
 * fencing, and state transitions as the editor IPC boundary.
 */
export async function executeWorkflowControlCommand(
  deps: ControlCommandServiceDeps,
  rawCommand: unknown
): Promise<ControlCommandAcknowledgement> {
  const service = new ControlCommandService(deps);
  return service.executeControlCommand(rawCommand);
}

/**
 * Compute the version-1 `ControlProjection` for a candidate-block `ControlFrame`.
 */
export function getCandidateBlockControlProjection(
  input: BuildControlProjectionInput
): ControlProjection {
  return buildControlProjection(input);
}

// ---------------------------------------------------------------------------
// FR-R6-F02 (T022, FR-013, SC-009) — Headless shared contract entry boundary
// ---------------------------------------------------------------------------

/**
 * Execute a shared memory and storage contract operation (`inspect-record`,
 * `accept-observation`, or `rebind-workspace`) through the headless entry point,
 * applying the exact same validation, ownership fence checks, unknown-field
 * rejection, and untrusted-workspace read-only guard as the editor UI and host.
 */
export function executeHeadlessSharedContractOperation(
  rawRequest: unknown
): StorageBoundaryOutcome<SharedContractBoundaryResult> {
  return executeSharedContractOperation('headless', rawRequest);
}
