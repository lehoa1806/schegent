/**
 * FR-R6-F15 (F15-B) — narrow bridge between `connected-run-coordinator.ts` /
 * `workflow-control-service.ts` and `PhaseHandoffCoordinator` so workflow execution
 * stays well within its LoC ceiling.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import type { PhaseDefinition } from '../../contracts/process-definitions';
import type { FrozenPhaseHandoffDelivery } from '../../contracts/run-request';
import type { WorkflowDefinition } from '../../contracts/workflow-definitions';
import type {
  ConnectedWorkflowRun,
  NodeAttemptRecord,
  WorkflowInvocationFrame
} from '../../state/connected-workflow-run';
import {
  normalizeNodePathForHandoff,
  type PhaseHandoffCoordinator
} from '../phase-context/phase-handoff-coordinator';

export function resolvePhaseTargetInstructions(
  run: ConnectedWorkflowRun,
  phase: PhaseDefinition
): string {
  const launchInstructions = run.launchContext?.instructions;
  if (launchInstructions !== undefined && launchInstructions.trim().length > 0) {
    return launchInstructions;
  }
  return 'instruction' in phase && phase.instruction !== undefined
    ? phase.instruction
    : `skill:${phase.skill}`;
}

export async function settleAndPrepareTransitionHandoff(params: {
  readonly coordinator: PhaseHandoffCoordinator | undefined;
  readonly run: ConnectedWorkflowRun;
  readonly frame: WorkflowInvocationFrame;
  readonly workflow: WorkflowDefinition;
  readonly settledAttempt: NodeAttemptRecord;
  readonly connectionIndex: number | null;
  readonly targetNodeId: string | null;
}): Promise<
  | {
      readonly ok: true;
      readonly handoffId?: string;
      readonly waitingApproval: boolean;
    }
  | {
      readonly ok: false;
      readonly failureCode: string;
      readonly detail: string;
    }
> {
  if (params.coordinator === undefined) {
    return { ok: true, waitingApproval: false };
  }
  const recorded = await params.coordinator.recordSettledAttempt({
    run: params.run,
    frame: params.frame,
    attempt: params.settledAttempt
  });
  if (!recorded.ok) {
    return { ok: false, failureCode: recorded.failure, detail: recorded.detail };
  }

  if (params.connectionIndex === null || params.targetNodeId === null) {
    return { ok: true, waitingApproval: false };
  }
  const connection = params.workflow.connections.at(params.connectionIndex);
  if (connection?.contextPolicy === undefined) {
    return { ok: true, waitingApproval: false };
  }

  const targetNode = params.workflow.nodes.find((n) => n.nodeId === params.targetNodeId);
  const targetPhase =
    targetNode?.phaseId !== undefined
      ? params.run.frozenClosure?.phasesById[targetNode.phaseId]
      : undefined;
  const targetInstructions =
    targetPhase !== undefined
      ? resolvePhaseTargetInstructions(params.run, targetPhase)
      : params.run.launchContext?.instructions ?? '';
  const targetBackendId = targetPhase?.runner ?? 'claude';

  const prepared = await params.coordinator.prepareTransitionHandoff({
    run: params.run,
    frame: params.frame,
    workflow: params.workflow,
    connection,
    connectionIndex: params.connectionIndex,
    fromNodeId: params.settledAttempt.nodeId,
    fromAttempt: params.settledAttempt,
    targetNodeId: params.targetNodeId,
    targetInstructions,
    targetBackendId
  });
  if (prepared.kind === 'refused') {
    return { ok: false, failureCode: prepared.failure, detail: prepared.detail };
  }
  if (prepared.kind === 'no-handoff') {
    return { ok: true, waitingApproval: false };
  }
  return {
    ok: true,
    handoffId: prepared.handoffId,
    waitingApproval: prepared.waitingApproval
  };
}

export async function buildAttemptHandoffDelivery(params: {
  readonly coordinator: PhaseHandoffCoordinator | undefined;
  readonly run: ConnectedWorkflowRun;
  readonly frame: WorkflowInvocationFrame;
  readonly nodeId: string;
  readonly phase: PhaseDefinition;
  readonly pendingAttempt: NodeAttemptRecord;
}): Promise<
  | { readonly ok: true; readonly delivery: FrozenPhaseHandoffDelivery | undefined }
  | { readonly ok: false; readonly failureCode: string; readonly detail: string }
> {
  if (params.coordinator === undefined) {
    return { ok: true, delivery: undefined };
  }
  const handoffId =
    params.frame.pendingHandoff?.phaseHandoffId ??
    params.coordinator.resolvePendingHandoffForTarget(
      params.run.connectedRunId,
      params.frame.invocationId,
      params.nodeId
    );

  const priorAttempts = params.frame.attemptsByNodeId[params.nodeId] ?? [];
  const prevPhaseAttempt = [...priorAttempts]
    .reverse()
    .find((a) => a.attemptId !== params.pendingAttempt.attemptId && a.status === 'completed');
  const prevPhaseDef =
    prevPhaseAttempt !== undefined
      ? params.run.frozenClosure?.phasesById[prevPhaseAttempt.targetDefinitionId]
      : undefined;

  const planned = await params.coordinator.planAndAuthorizeAttemptDelivery({
    runId: params.run.connectedRunId,
    handoffId,
    targetAttemptId: params.pendingAttempt.attemptId,
    targetNodePath: normalizeNodePathForHandoff(params.pendingAttempt.nodePath),
    targetOccurrenceId: params.frame.invocationId,
    targetInstructions: resolvePhaseTargetInstructions(params.run, params.phase),
    backendId: params.phase.runner ?? 'claude',
    previousSessionAttempt:
      prevPhaseAttempt !== undefined
        ? {
            producer: {
              nodePath: normalizeNodePathForHandoff(prevPhaseAttempt.nodePath),
              occurrenceId: params.frame.invocationId,
              attemptId: prevPhaseAttempt.attemptId
            },
            backendId: prevPhaseDef?.runner ?? 'claude'
          }
        : null
  });
  if (!planned.ok) {
    return { ok: false, failureCode: planned.failure, detail: planned.detail };
  }
  return { ok: true, delivery: planned.delivery };
}

export function approvePendingPhaseHandoffForContinue(
  coordinator: PhaseHandoffCoordinator | undefined,
  run: ConnectedWorkflowRun,
  targetInvocationId: string,
  commandId: string
): boolean {
  const pendingPhaseHandoffId =
    run.invocations?.[targetInvocationId]?.pendingHandoff?.phaseHandoffId ??
    run.pendingHandoff?.phaseHandoffId;
  if (pendingPhaseHandoffId === undefined || coordinator === undefined) {
    return true;
  }
  const inspected = coordinator.acceptance.inspect(pendingPhaseHandoffId);
  if (!inspected.ok || inspected.record === null) {
    return false;
  }
  const latestRev = inspected.record.revisions.at(-1);
  if (latestRev === undefined) {
    return false;
  }
  if (latestRev.state === 'waiting-approval') {
    const approved = coordinator.approveHandoff(
      pendingPhaseHandoffId,
      latestRev.revision,
      commandId
    );
    if (!approved.ok) {
      return false;
    }
  }
  return true;
}
