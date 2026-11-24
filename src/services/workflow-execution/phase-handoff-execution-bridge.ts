/**
 * FR-R6-F15 (F15-B) — narrow bridge between `connected-run-coordinator.ts` /
 * `workflow-control-service.ts` / `workflow-recovery-service.ts` and `PhaseHandoffCoordinator`
 * so workflow execution stays well within its LoC ceiling.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { DEFAULT_BACKEND } from '../../contracts/backend-kinds';
import type { PhaseDefinition } from '../../contracts/process-definitions';
import type { FrozenPhaseHandoffDelivery, RunRequest } from '../../contracts/run-request';
import type { WorkflowConnection, WorkflowDefinition } from '../../contracts/workflow-definitions';
import {
  resolveRootInvocationId,
  type ConnectedWorkflowRun,
  type NodeAttemptRecord,
  type WorkflowInvocationFrame
} from '../../state/connected-workflow-run';
import {
  canonicalNodePathInFrame,
  normalizeHandoffIdentifier
} from '../phase-context/handoff-delivery-coordinator';
import {
  normalizeNodePathForHandoff,
  type PhaseHandoffCoordinator
} from '../phase-context/phase-handoff-coordinator';
import {
  buildReviewLoopId,
  deriveMaxReviewPassesForRepeat,
  resolveNodeReviewRole,
  resolveReviewLoopTarget
} from '../phase-context/review-loop-coordinator';
import { continueWaitingHandoff } from './continuation-composer';
import {
  isTerminalInvocationStatus,
  type WorkflowControlRefusalCode
} from './workflow-control-transition-table';
import type { ConnectedRunWriter } from './workflow-launcher';

export function readCandidateRefPort(
  resolvedOutputs: Readonly<Record<string, { readonly value: string }>>
): string | undefined {
  const fromOut: { readonly value: string } | undefined = Object.hasOwn(
    resolvedOutputs,
    'candidateRef'
  )
    ? resolvedOutputs['candidateRef']
    : undefined;
  return fromOut !== undefined && fromOut.value.length > 0 ? fromOut.value : undefined;
}

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

/**
 * FR-001 — returns true only when `nodeId` participates in an opted-in `contextPolicy` transition
 * (as outgoing source, selector target, or bound-input feeder to an opted-in transition).
 */
function nodeParticipatesInContextPolicy(
  run: ConnectedWorkflowRun,
  workflow: WorkflowDefinition,
  nodeId: string,
  selectedConnection: WorkflowConnection | undefined
): boolean {
  if (selectedConnection?.contextPolicy !== undefined) return true;
  const allWorkflows = run.frozenClosure
    ? Object.values(run.frozenClosure.workflowsById)
    : [workflow];
  for (const wf of allWorkflows) {
    for (const conn of wf.connections) {
      if (conn.contextPolicy === undefined) continue;
      if (conn.from.nodeId === nodeId) return true;
      if (
        conn.contextPolicy.selectors.some(
          (sel) => sel.sourceNodePath === nodeId || sel.sourceNodePath.endsWith(`/${nodeId}`)
        )
      ) {
        return true;
      }
    }
    for (const b of wf.bindings ?? []) {
      if (b.kind === 'input' && b.source.from === 'node-output' && b.source.nodeId === nodeId) {
        if (
          wf.connections.some(
            (c) => c.contextPolicy !== undefined && 'nodeId' in c.to && c.to.nodeId === b.nodeId
          )
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function settleDeliveredIncomingDispatches(
  coordinator: PhaseHandoffCoordinator,
  runId: string,
  completedAttemptId: string
): void {
  const normalizedId = normalizeHandoffIdentifier(completedAttemptId, 'attempt-1');
  for (const handoffId of coordinator.store.listHandoffIdsForRun(runId)) {
    let record: ReturnType<PhaseHandoffCoordinator['store']['load']>;
    try {
      record = coordinator.store.load(handoffId);
    } catch {
      // Corrupt handoff row remains unsettled and fails closed on inspection/delivery.
      continue;
    }
    if (record === null) continue;
    for (const d of record.dispatches) {
      if (d.state === 'intent' && d.targetAttemptId === normalizedId) {
        coordinator.settleAttemptDispatch({
          handoffId,
          revision: d.revision,
          targetAttemptId: normalizedId,
          delivered: true
        });
      }
    }
  }
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
      readonly handoffRevision?: number;
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

  // Settle any incoming `'intent'` dispatch for an attempt that completed cleanly.
  if (params.settledAttempt.status === 'completed') {
    settleDeliveredIncomingDispatches(
      params.coordinator,
      params.run.connectedRunId,
      params.settledAttempt.attemptId
    );
  }

  const connection =
    params.connectionIndex !== null
      ? params.workflow.connections.at(params.connectionIndex)
      : undefined;
  const reviewLoopTarget = resolveReviewLoopTarget(
    params.run,
    params.frame,
    params.settledAttempt.nodeId
  );

  // FR-001: disabled transitions with no opted-in `contextPolicy` and no review loop must write
  // zero SQLite handoff rows, zero F05 pins, and zero immutable attempt captures.
  if (
    !nodeParticipatesInContextPolicy(
      params.run,
      params.workflow,
      params.settledAttempt.nodeId,
      connection
    ) &&
    reviewLoopTarget === null
  ) {
    return { ok: true, waitingApproval: false };
  }

  const readPortStr = (
    ports: Readonly<Record<string, { readonly value: string }>>,
    key: string
  ): string | undefined => {
    const entry: { readonly value: string } | undefined = Object.hasOwn(ports, key)
      ? ports[key]
      : undefined;
    return entry !== undefined && entry.value.length > 0 ? entry.value : undefined;
  };
  // CR-314-4: keep explicit declaredOutputs distinct from frame.boundInputs so stale Repeat entry
  // inputs never override a post-Fix candidateRef recorded in the review-loop ledger.
  const candidateSnapshotDigest = readPortStr(params.settledAttempt.declaredOutputs, 'candidateRef');
  const fallbackCandidateRef = readPortStr(params.frame.boundInputs, 'candidateRef');
  const scopeRevision = readPortStr(params.settledAttempt.declaredOutputs, 'scopeRevision');
  const fallbackScopeRevision = readPortStr(params.frame.boundInputs, 'scopeRevision');
  const criteriaRevision = readPortStr(params.settledAttempt.declaredOutputs, 'criteriaRevision');
  const fallbackCriteriaRevision = readPortStr(params.frame.boundInputs, 'criteriaRevision');
  const allowReviewReport =
    resolveNodeReviewRole(params.run, params.frame, params.settledAttempt.nodeId) === 'reviewer';

  const recorded = await params.coordinator.recordSettledAttempt({
    run: params.run,
    frame: params.frame,
    attempt: params.settledAttempt,
    allowReviewReport,
    ...(reviewLoopTarget !== null
      ? {
          reviewLoopNodeId: reviewLoopTarget.repeatNodeId,
          maxReviewPasses: deriveMaxReviewPassesForRepeat(reviewLoopTarget)
        }
      : {}),
    ...(candidateSnapshotDigest !== undefined ? { candidateSnapshotDigest } : {}),
    ...(fallbackCandidateRef !== undefined ? { fallbackCandidateRef } : {}),
    ...(scopeRevision !== undefined ? { scopeRevision } : {}),
    ...(fallbackScopeRevision !== undefined ? { fallbackScopeRevision } : {}),
    ...(criteriaRevision !== undefined ? { criteriaRevision } : {}),
    ...(fallbackCriteriaRevision !== undefined ? { fallbackCriteriaRevision } : {})
  });
  if (!recorded.ok) {
    return { ok: false, failureCode: recorded.failure, detail: recorded.detail };
  }

  // FR-027: if a non-reviewer phase (e.g. Fix inside Repeat) produced a new `candidateRef` that
  // differs from the latest reviewed pass, mark the review loop candidate invalidated so Repeat
  // cannot exit without a re-review of the updated candidate.
  const declaredNewCandidate = candidateSnapshotDigest;
  if (reviewLoopTarget !== null && declaredNewCandidate !== undefined) {
    const loopId = buildReviewLoopId(params.run.connectedRunId, reviewLoopTarget.repeatNodeId);
    try {
      const storedLoop = params.coordinator.store.loadReviewLoop(loopId);
      const latestPassCandidate = storedLoop?.snapshot.passes.at(-1)?.candidateRef;
      if (storedLoop !== null && latestPassCandidate !== declaredNewCandidate) {
        params.coordinator.invalidateReviewLoopCandidate({
          runId: params.run.connectedRunId,
          repeatNodeId: reviewLoopTarget.repeatNodeId,
          newCandidateRef: declaredNewCandidate
        });
      }
    } catch {
      // Fail closed if the persisted review-loop ledger is corrupt.
      return { ok: false, failureCode: 'storage-unavailable', detail: 'corrupt-review-loop-ledger' };
    }
  }

  if (params.connectionIndex === null || params.targetNodeId === null) {
    return { ok: true, waitingApproval: false };
  }
  if (connection?.contextPolicy === undefined) {
    return { ok: true, waitingApproval: false };
  }

  const targetNode = params.workflow.nodes.find((n) => n.nodeId === params.targetNodeId);
  let targetPhase: PhaseDefinition | undefined =
    targetNode?.phaseId !== undefined
      ? params.run.frozenClosure?.phasesById[targetNode.phaseId]
      : undefined;
  if (targetPhase === undefined && targetNode?.workflowId !== undefined) {
    const childWf = params.run.frozenClosure?.workflowsById[targetNode.workflowId];
    const entryNode = childWf?.nodes.find((n) => n.nodeId === childWf.startNodeIds[0]);
    if (entryNode?.phaseId !== undefined) {
      targetPhase = params.run.frozenClosure?.phasesById[entryNode.phaseId];
    }
  }
  const targetInstructions =
    targetPhase !== undefined
      ? resolvePhaseTargetInstructions(params.run, targetPhase)
      : params.run.launchContext?.instructions ?? '';
  const targetBackendId = targetPhase?.runner ?? DEFAULT_BACKEND;

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
    handoffRevision: prepared.revision.revision,
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
  const workflow = params.run.frozenClosure?.workflowsById[params.frame.workflowId];
  let handoffId =
    params.frame.pendingHandoff?.phaseHandoffId ??
    params.coordinator.resolvePendingHandoffForTarget(
      params.run.connectedRunId,
      params.frame.invocationId,
      params.nodeId
    );
  let inheritedFromParentCall = false;
  if (
    handoffId === null &&
    params.frame.parentInvocationId !== null &&
    params.frame.parentCallNodeId !== null &&
    workflow?.startNodeIds[0] === params.nodeId
  ) {
    handoffId = params.coordinator.resolvePendingHandoffForTarget(
      params.run.connectedRunId,
      params.frame.parentInvocationId,
      params.frame.parentCallNodeId
    );
    inheritedFromParentCall = handoffId !== null;
  }

  // FR-001: on a disabled transition with no handoff and no review-loop/contextPolicy role, leave
  // prompt delivery completely untouched (`undefined`, zero `acpPromptBlocks`).
  if (handoffId === null) {
    const inReviewLoop = resolveReviewLoopTarget(params.run, params.frame, params.nodeId) !== null;
    const inPolicy =
      workflow !== undefined &&
      nodeParticipatesInContextPolicy(params.run, workflow, params.nodeId, undefined);
    if (!inPolicy && !inReviewLoop) {
      return { ok: true, delivery: undefined };
    }
  }

  const priorAttempts = params.frame.attemptsByNodeId[params.nodeId] ?? [];
  const prevPhaseAttempt = [...priorAttempts]
    .reverse()
    .find((a) => a.attemptId !== params.pendingAttempt.attemptId && a.status === 'completed');
  const prevPhaseDef =
    prevPhaseAttempt !== undefined
      ? params.run.frozenClosure?.phasesById[prevPhaseAttempt.targetDefinitionId]
      : undefined;

  const parentFrame =
    inheritedFromParentCall && params.frame.parentInvocationId !== null
      ? params.run.invocations?.[params.frame.parentInvocationId]
      : undefined;
  const deliveryTargetNodePath =
    inheritedFromParentCall &&
    parentFrame !== undefined &&
    params.frame.parentCallNodeId !== null
      ? canonicalNodePathInFrame(parentFrame, params.frame.parentCallNodeId)
      : normalizeNodePathForHandoff(params.pendingAttempt.nodePath);
  const deliveryTargetOccurrenceId =
    inheritedFromParentCall && params.frame.parentInvocationId !== null
      ? params.frame.parentInvocationId
      : params.frame.invocationId;

  const planned = await params.coordinator.planAndAuthorizeAttemptDelivery({
    runId: params.run.connectedRunId,
    handoffId,
    targetAttemptId: params.pendingAttempt.attemptId,
    targetNodePath: deliveryTargetNodePath,
    targetOccurrenceId: deliveryTargetOccurrenceId,
    targetInstructions: resolvePhaseTargetInstructions(params.run, params.phase),
    backendId: params.phase.runner ?? DEFAULT_BACKEND,
    reviewRole: resolveNodeReviewRole(params.run, params.frame, params.nodeId),
    previousSessionAttempt:
      prevPhaseAttempt !== undefined
        ? {
            producer: {
              nodePath: normalizeNodePathForHandoff(prevPhaseAttempt.nodePath),
              occurrenceId: params.frame.invocationId,
              attemptId: prevPhaseAttempt.attemptId
            },
            backendId: prevPhaseDef?.runner ?? DEFAULT_BACKEND
          }
        : null
  });
  if (!planned.ok) {
    return { ok: false, failureCode: planned.failure, detail: planned.detail };
  }
  return { ok: true, delivery: planned.delivery };
}

/**
 * FR-012 — revision-bound approval check for `continue-handoff`. Fails closed whenever a waiting
 * handoff has no expected revision pinned OR when the handoff has moved to a newer revision.
 */
export function approvePendingPhaseHandoffForContinue(
  coordinator: PhaseHandoffCoordinator | undefined,
  run: ConnectedWorkflowRun,
  targetInvocationId: string,
  commandId: string,
  expectedHandoffRevision?: number
): boolean {
  const pending =
    run.invocations?.[targetInvocationId]?.pendingHandoff ?? run.pendingHandoff;
  const pendingPhaseHandoffId = pending?.phaseHandoffId;
  if (pendingPhaseHandoffId === undefined || coordinator === undefined) {
    return true;
  }
  const effectiveExpectedRevision = expectedHandoffRevision ?? pending?.phaseHandoffRevision;
  const inspected = coordinator.acceptance.inspect(pendingPhaseHandoffId);
  if (!inspected.ok || inspected.record === null) {
    return false;
  }
  const latestRev = inspected.record.revisions.at(-1);
  if (latestRev === undefined) {
    return false;
  }
  if (effectiveExpectedRevision === undefined) {
    // Fail closed if a waiting-approval handoff lacks any pinned revision.
    return latestRev.state !== 'waiting-approval';
  }
  if (latestRev.revision !== effectiveExpectedRevision) {
    const stale = coordinator.approveHandoff(
      pendingPhaseHandoffId,
      effectiveExpectedRevision,
      commandId
    );
    return stale.ok;
  }
  if (latestRev.state === 'waiting-approval') {
    const approved = coordinator.approveHandoff(
      pendingPhaseHandoffId,
      effectiveExpectedRevision,
      commandId
    );
    if (!approved.ok) {
      return false;
    }
  }
  return true;
}

/**
 * CR-314-2 / SR-314-3 — pre-validates `continuationRequest`, computes the staged `continueWaitingHandoff`
 * transition, verifies live run revision freshness, and ONLY THEN commits revision-bound SQLite
 * phase-handoff approval (`FR-012`), so invalid continuation requests or stale runs never mutate SQLite.
 */
export async function validateAndApproveContinueHandoff(params: {
  readonly stagingWriter: ConnectedRunWriter;
  readonly stagedRun: ConnectedWorkflowRun;
  readonly readLiveRun: () => ConnectedWorkflowRun | null;
  readonly coordinator: PhaseHandoffCoordinator | undefined;
  readonly run: ConnectedWorkflowRun;
  readonly targetInvocationId: string;
  readonly targetNodeId: string;
  readonly continuationRequest: RunRequest | undefined;
  readonly commandId: string;
  readonly now: number;
  readonly expectedHandoffRevision: number | undefined;
}): Promise<
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly refusalCode: WorkflowControlRefusalCode;
      readonly reason: string;
    }
> {
  const { continuationRequest, run, targetInvocationId, targetNodeId } = params;
  if (
    continuationRequest !== undefined &&
    (typeof continuationRequest.pipelineId !== 'string' ||
      continuationRequest.pipelineId.trim().length === 0 ||
      !Array.isArray(continuationRequest.inputs) ||
      !Array.isArray(continuationRequest.supplemental) ||
      !Array.isArray(continuationRequest.outputs) ||
      (continuationRequest.workflowId !== undefined &&
        continuationRequest.workflowId !== run.workflowId))
  ) {
    return {
      accepted: false,
      refusalCode: 'invalid-state-for-operation',
      reason: 'Continuation request is malformed or targets a different workflow.'
    };
  }

  const requestPayload: RunRequest = continuationRequest ?? {
    pipelineId: targetNodeId,
    workflowId: run.workflowId,
    inputs: [],
    supplemental: [],
    outputs: []
  };

  const targetFrame = run.invocations?.[targetInvocationId];
  const targetWfDef =
    targetFrame !== undefined ? run.frozenClosure?.workflowsById[targetFrame.workflowId] : undefined;
  const targetNodeDef = targetWfDef?.nodes.find((n) => n.nodeId === targetNodeId);
  const targetExpectedInputs =
    targetNodeDef?.workflowId !== undefined
      ? run.frozenClosure?.workflowsById[targetNodeDef.workflowId]?.inputs
      : undefined;

  const accepted = await continueWaitingHandoff(
    { connectedRuns: params.stagingWriter },
    {
      run: params.stagedRun,
      expectedRevision: params.stagedRun.revision,
      invocationId: targetInvocationId,
      targetNodeId,
      request: requestPayload,
      acceptedAt: params.now,
      ...(targetExpectedInputs !== undefined ? { expectedInputs: targetExpectedInputs } : {})
    }
  );
  if (accepted.outcome !== 'accepted') {
    return {
      accepted: false,
      refusalCode:
        accepted.outcome === 'rejected-stale'
          ? 'stale-revision'
          : accepted.outcome === 'rejected-validation'
            ? 'invalid-state-for-operation'
            : 'handoff-not-pending',
      reason:
        accepted.outcome === 'rejected-validation'
          ? 'Continuation request failed required input validation.'
          : 'Pending handoff could not be accepted for the target node.'
    };
  }

  const liveRun = params.readLiveRun();
  if (liveRun === null || liveRun.revision !== run.revision) {
    return {
      accepted: false,
      refusalCode: 'stale-revision',
      reason: 'Concurrent modification detected before handoff approval.'
    };
  }

  const pendingHandoff =
    run.invocations?.[targetInvocationId]?.pendingHandoff ?? run.pendingHandoff;
  const resolvedExpectedRev =
    params.expectedHandoffRevision ?? pendingHandoff?.phaseHandoffRevision;
  if (
    !approvePendingPhaseHandoffForContinue(
      params.coordinator,
      run,
      targetInvocationId,
      params.commandId,
      resolvedExpectedRev
    )
  ) {
    return {
      accepted: false,
      refusalCode: 'stale-revision',
      reason: 'Pending phase handoff revision is stale or awaits explicit approval.'
    };
  }
  return { accepted: true };
}

/**
 * FR-R7-14 (14-08) — Release handoff artifact pins only when the run's root
 * invocation frame is durably confirmed terminal (`completed`, `failed`, or `canceled`).
 * Idempotent across repeated recoveries; never touches active, paused, or waiting runs.
 */
export function releaseTerminalHandoffPinsIfConfirmed(
  coordinator: Pick<PhaseHandoffCoordinator, 'releaseTerminalRunPins'> | undefined,
  run: ConnectedWorkflowRun
): void {
  if (coordinator === undefined) {
    return;
  }
  const rootId = resolveRootInvocationId(run);
  const rootFrame = run.invocations?.[rootId];
  if (rootFrame !== undefined && isTerminalInvocationStatus(rootFrame.status)) {
    coordinator.releaseTerminalRunPins(run.connectedRunId);
  }
}

/**
 * FR-R7-14 (14-08) — Commit a recovered `ConnectedWorkflowRun` via CAS and release
 * terminal handoff pins strictly after `'written'` confirms a terminal root status.
 */
export async function commitRecoveredRunAndReleaseTerminalPins(
  connectedRuns: ConnectedRunWriter,
  coordinator: Pick<PhaseHandoffCoordinator, 'releaseTerminalRunPins'> | undefined,
  nextRun: ConnectedWorkflowRun,
  expectedRevision: number
): Promise<ConnectedWorkflowRun> {
  const written = await connectedRuns.compareAndSetConnectedRun(nextRun, expectedRevision);
  if (written.outcome === 'written') {
    releaseTerminalHandoffPinsIfConfirmed(coordinator, written.run);
    return written.run;
  }
  return written.current ?? nextRun;
}
