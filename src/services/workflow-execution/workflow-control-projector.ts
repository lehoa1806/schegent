// FR-R5-F03 (T008, T009) — Authoritative control projections and bounded
// ancestry evidence for nested Workflow runs.
//
// Exposes legal control operations, waiting/pause/failure reasons, revision
// tokens, recovery dispositions, and full invocation ancestry without
// duplicating child Phase transcripts into parent frames.
//
// Zero `vscode` imports and zero I/O: shared by host and headless adapters.

import {
  resolveBoundQueueId,
  resolveRootInvocationId,
  type ConnectedWorkflowRun,
  type NodeAttemptRecord,
  type RecoveryDispositionRecord,
  type WorkflowControlOperation,
  type WorkflowDelayedRetryCause,
  type WorkflowInvocationFrame,
  type WorkflowInvocationStatus,
  type WorkflowPauseCause
} from '../../state/connected-workflow-run';
import {
  computeAllowedControlActions,
  findLatestLeafPhaseAttempt
} from './workflow-control-transition-table';

export const MAX_EVIDENCE_SUMMARY_CHARS = 256;

/**
 * FR-R5-F03 (T008) — Bounded ancestry metadata attached to nested runtime
 * events, control receipts, and audit records.
 */
export interface AncestryEvidenceMetadata {
  readonly rootRunId: string;
  readonly invocationId: string;
  readonly parentInvocationId: string | null;
  readonly nodePath: string;
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly queueId: string;
}

export interface InvocationControlProjection {
  readonly invocationId: string;
  readonly parentInvocationId: string | null;
  readonly workflowId: string;
  readonly depth: number;
  readonly nodePath: string;
  readonly status: WorkflowInvocationStatus;
  readonly currentNodeId: string | null;
  readonly activeAttemptId: string | null;
  readonly activeAttemptIndex: number | null;
  readonly allowedActions: readonly WorkflowControlOperation[];
  readonly waitingReason: string | null;
  readonly pauseCause: WorkflowPauseCause | null;
  readonly failureReason: string | null;
  readonly pendingRetryAt: number | null;
  readonly pendingRetryCause: WorkflowDelayedRetryCause | null;
}

export interface WorkflowRunControlProjection {
  readonly runId: string;
  readonly queueId: string;
  readonly revision: number;
  readonly status: WorkflowInvocationStatus;
  readonly activeInvocationId: string;
  readonly rootInvocationId: string;
  readonly rootAllowedActions: readonly WorkflowControlOperation[];
  readonly invocations: Readonly<Record<string, InvocationControlProjection>>;
  readonly recoveryDisposition: RecoveryDispositionRecord | null;
}

function findLatestAttemptForFrame(
  frame: WorkflowInvocationFrame
): NodeAttemptRecord | undefined {
  if (frame.activeNodeId !== null) {
    const activeList = frame.attemptsByNodeId[frame.activeNodeId] ?? [];
    const lastActive = activeList[activeList.length - 1];
    if (lastActive !== undefined) {
      return lastActive;
    }
  }
  const leafPhase = findLatestLeafPhaseAttempt(frame);
  if (leafPhase !== undefined) {
    return leafPhase;
  }
  let latest: NodeAttemptRecord | undefined;
  for (const list of Object.values(frame.attemptsByNodeId)) {
    const candidate = list[list.length - 1];
    if (candidate === undefined) continue;
    if (latest === undefined || candidate.startedAt >= latest.startedAt) {
      latest = candidate;
    }
  }
  return latest;
}

function deriveWaitingReason(frame: WorkflowInvocationFrame): string | null {
  if (frame.status === 'waiting-for-handoff') {
    if (frame.pendingHandoff?.acceptedEnvelope !== undefined) {
      return 'handoff-accepted-pending-dispatch';
    }
    return 'manual-handoff-approval';
  }
  if (frame.controlMarkers?.pendingRetryCause !== null && frame.controlMarkers?.pendingRetryCause !== undefined) {
    return frame.controlMarkers.pendingRetryCause;
  }
  if (frame.status === 'paused') {
    return frame.controlMarkers?.manualPauseCause ?? 'operator-pause';
  }
  return null;
}

function resolveDeepestActiveInvocationId(
  run: ConnectedWorkflowRun,
  rootInvocationId: string
): string {
  const invocations = run.invocations ?? {};
  let candidate: WorkflowInvocationFrame | undefined = invocations[rootInvocationId];
  for (const frame of Object.values(invocations)) {
    if (
      frame.status === 'in-flight' ||
      frame.status === 'waiting-for-handoff' ||
      frame.status === 'paused'
    ) {
      if (candidate === undefined || frame.depth >= candidate.depth) {
        candidate = frame;
      }
    }
  }
  return candidate?.invocationId ?? rootInvocationId;
}

/**
 * Build the authoritative control projection for a single `WorkflowInvocationFrame`.
 */
export function buildInvocationControlProjection(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame
): InvocationControlProjection {
  const latestAttempt = findLatestAttemptForFrame(frame);
  const allowedActions = computeAllowedControlActions(run, frame.invocationId);
  const pauseCause = frame.controlMarkers?.manualPauseCause ?? null;
  const pendingRetryAt = frame.controlMarkers?.pendingRetryAt ?? null;
  const pendingRetryCause = frame.controlMarkers?.pendingRetryCause ?? null;
  const failureReason =
    frame.status === 'failed'
      ? frame.failureCode ?? latestAttempt?.failureCode ?? 'unhandled-node-failure'
      : null;

  return Object.freeze({
    invocationId: frame.invocationId,
    parentInvocationId: frame.parentInvocationId,
    workflowId: frame.workflowId,
    depth: frame.depth,
    nodePath: frame.nodePath,
    status: frame.status,
    currentNodeId: frame.activeNodeId ?? latestAttempt?.nodeId ?? null,
    activeAttemptId: latestAttempt?.attemptId ?? null,
    activeAttemptIndex: latestAttempt?.attemptIndex ?? null,
    allowedActions,
    waitingReason: deriveWaitingReason(frame),
    pauseCause,
    failureReason,
    pendingRetryAt,
    pendingRetryCause
  });
}

/**
 * Build the authoritative control projection for an entire `ConnectedWorkflowRun`.
 */
export function buildWorkflowRunControlProjection(
  run: ConnectedWorkflowRun
): WorkflowRunControlProjection {
  const rootInvocationId = resolveRootInvocationId(run);
  const invocationsMap = run.invocations ?? {};
  const projections: Record<string, InvocationControlProjection> = {};

  for (const [invId, frame] of Object.entries(invocationsMap)) {
    projections[invId] = buildInvocationControlProjection(run, frame);
  }

  const rootFrame = invocationsMap[rootInvocationId];
  const rootStatus: WorkflowInvocationStatus = rootFrame?.status ?? 'in-flight';
  const rootAllowedActions =
    projections[rootInvocationId]?.allowedActions ?? Object.freeze([]);
  const activeInvocationId = resolveDeepestActiveInvocationId(run, rootInvocationId);

  return Object.freeze({
    runId: run.connectedRunId,
    queueId: resolveBoundQueueId(run),
    revision: run.revision,
    status: rootStatus,
    activeInvocationId,
    rootInvocationId,
    rootAllowedActions,
    invocations: Object.freeze(projections),
    recoveryDisposition: run.recoveryDisposition ?? null
  });
}

/**
 * Construct bounded `AncestryEvidenceMetadata` for a specific invocation and
 * optional node/attempt within `run` (`FR-R5-F03-T08`).
 *
 * Never copies child Phase transcripts into parent records.
 */
export function buildAncestryEvidenceMetadata(
  run: ConnectedWorkflowRun,
  invocationId: string,
  nodeId?: string | undefined
): AncestryEvidenceMetadata | undefined {
  const frame = run.invocations?.[invocationId];
  if (frame === undefined) {
    return undefined;
  }
  const targetNodeId = nodeId ?? frame.activeNodeId ?? frame.entryNodeId;
  const attempts = frame.attemptsByNodeId[targetNodeId] ?? [];
  const latestAttempt = attempts[attempts.length - 1];
  const attemptIndex = latestAttempt?.attemptIndex ?? 1;
  const attemptId =
    latestAttempt?.attemptId ?? `${frame.invocationId}:${targetNodeId}:attempt-${attemptIndex}`;
  const nodePath = latestAttempt?.nodePath ?? frame.nodePath;

  return Object.freeze({
    rootRunId: frame.rootRunId,
    invocationId: frame.invocationId,
    parentInvocationId: frame.parentInvocationId,
    nodePath,
    attemptId,
    attemptIndex,
    queueId: resolveBoundQueueId(run)
  });
}
