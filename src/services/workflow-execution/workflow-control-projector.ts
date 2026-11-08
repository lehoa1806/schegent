// FR-R5-F03 (T008, T009) — Authoritative control projections and bounded
// ancestry evidence for nested Workflow runs.
//
// Exposes legal control operations, waiting/pause/failure reasons, revision
// tokens, recovery dispositions, and full invocation ancestry without
// duplicating child Phase transcripts into parent frames.
//
// Zero `vscode` imports and zero I/O: shared by host and headless adapters.

import type {
  ConnectedInvocationAttemptProjection,
  ConnectedInvocationProjection
} from '../../contracts/sidebar-ipc/workflow-run';
import {
  attemptsForNode,
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

export {
  buildControlProjection,
  type BuildControlProjectionInput
} from './control-command-service';

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
  readonly pauseExplanation?: string | null;
  readonly pauseGuidance?: string | null;
  readonly failureReason: string | null;
  readonly pendingRetryAt: number | null;
  readonly pendingRetryCause: WorkflowDelayedRetryCause | null;
}

export interface WorkflowPauseCauseDescription {
  readonly explanation: string;
  readonly guidance: string;
}

/**
 * FR-R5-F08 — deterministic human-readable explanation and operator guidance
 * for each `WorkflowPauseCause`.
 */
export function describeWorkflowPauseCause(
  cause: WorkflowPauseCause | null | undefined
): WorkflowPauseCauseDescription | null {
  if (cause === null || cause === undefined) return null;
  switch (cause) {
    case 'recovery-uncertain-effect':
      return Object.freeze({
        explanation:
          'Paused during restart recovery because the active Phase attempt had no live queue task or verified settlement evidence.',
        guidance:
          'Inspect workspace outputs, then choose Resume (reconciles evidence before re-dispatching), Retry Phase, or Cancel.'
      });
    case 'credit-exhausted':
      return Object.freeze({
        explanation: 'Paused because backend provider credit or quota was exhausted during execution.',
        guidance: 'Restore provider credit or wait for quota reset, then choose Resume or Cancel.'
      });
    case 'spend-bound-exceeded':
      return Object.freeze({
        explanation: 'Paused because cumulative invocation spend reached the configured spend bound.',
        guidance: 'Review invocation spend and outputs, then choose Resume or Cancel.'
      });
    case 'operator-pause':
      return Object.freeze({
        explanation: 'Paused by operator request.',
        guidance: 'Choose Resume to continue or Cancel to stop this workflow.'
      });
  }
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
    const activeList = attemptsForNode(frame, frame.activeNodeId);
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
  const pauseDescription = describeWorkflowPauseCause(pauseCause);
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
    pauseExplanation: pauseDescription?.explanation ?? null,
    pauseGuidance: pauseDescription?.guidance ?? null,
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
  const attempts = attemptsForNode(frame, targetNodeId);
  const latestAttempt = attempts[attempts.length - 1];
  const attemptIndex = latestAttempt?.attemptIndex ?? 1;
  const attemptId =
    latestAttempt?.attemptId ?? `${frame.invocationId}:${targetNodeId}:attempt-${attemptIndex}`;

  return Object.freeze({
    rootRunId: frame.rootRunId,
    invocationId: frame.invocationId,
    parentInvocationId: frame.parentInvocationId,
    nodePath: latestAttempt?.nodePath ?? frame.nodePath,
    attemptId,
    attemptIndex,
    queueId: resolveBoundQueueId(run)
  });
}

/**
 * FR-R5-F06 — Project hierarchical `ConnectedInvocationProjection` rows for
 * the sidebar/webview wire contract from `run.invocations` and `run.frozenClosure`.
 */
export function projectConnectedInvocations(
  run: ConnectedWorkflowRun,
  _control: WorkflowRunControlProjection = buildWorkflowRunControlProjection(run)
): readonly ConnectedInvocationProjection[] | undefined {
  const frames = run.invocations;
  if (frames === undefined || Object.keys(frames).length === 0) return undefined;
  const orderedFrames: WorkflowInvocationFrame[] = Object.values(frames).sort((a, b) =>
    a.depth !== b.depth ? a.depth - b.depth : a.startedAt - b.startedAt
  );
  return Object.freeze(
    orderedFrames.map((frame): ConnectedInvocationProjection => {
      const ctrl = buildInvocationControlProjection(run, frame);
      const wfDef = run.frozenClosure?.workflowsById[frame.workflowId];
      const versionRef = run.frozenClosure?.catalogVersionsById?.[frame.workflowId];
      const attempts: ConnectedInvocationAttemptProjection[] = Object.values(frame.attemptsByNodeId)
        .flatMap((list) => list)
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((att) =>
          Object.freeze({
            attemptId: att.attemptId,
            attemptIndex: att.attemptIndex,
            nodeId: att.nodeId,
            nodeKind: att.nodeKind,
            status: att.status,
            startedAt: att.startedAt,
            ...(att.completedAt !== undefined ? { endedAt: att.completedAt } : {}),
            ...(att.queueItemId !== undefined ? { queueItemId: att.queueItemId } : {}),
            ...(att.childInvocationId !== undefined ? { childInvocationId: att.childInvocationId } : {}),
            ...(att.failureCode !== undefined ? { failureCode: att.failureCode } : {})
          })
        );
      const rawHandoff =
        frame.pendingHandoff ??
        (run.pendingHandoff?.invocationId === frame.invocationId ? run.pendingHandoff : null);
      const pendingHandoff =
        rawHandoff !== null
          ? Object.freeze({
              fromNodeId: rawHandoff.fromNodeId,
              toNodeId: rawHandoff.target.kind === 'node' ? rawHandoff.target.nodeId : null,
              connectionId: String(rawHandoff.connectionIndex),
              boundInputPortIds: Object.freeze(Object.keys(rawHandoff.prefilledInputsByPort))
            })
          : null;
      return Object.freeze({
        invocationId: frame.invocationId,
        parentInvocationId: frame.parentInvocationId,
        workflowId: frame.workflowId,
        ...(wfDef !== undefined ? { workflowName: wfDef.name } : {}),
        ...(versionRef !== undefined ? { frozenVersionId: versionRef.versionId } : {}),
        depth: frame.depth,
        nodePath: frame.nodePath,
        status: ctrl.status,
        currentNodeId: ctrl.currentNodeId,
        activeAttemptId: ctrl.activeAttemptId,
        activeAttemptIndex: ctrl.activeAttemptIndex,
        allowedActions: ctrl.allowedActions,
        waitingReason: ctrl.waitingReason,
        pauseCause: ctrl.pauseCause,
        pauseExplanation: ctrl.pauseExplanation ?? null,
        pauseGuidance: ctrl.pauseGuidance ?? null,
        failureReason: ctrl.failureReason,
        pendingRetryAt: ctrl.pendingRetryAt,
        pendingRetryCause: ctrl.pendingRetryCause,
        ...(pendingHandoff !== null ? { pendingHandoff } : {}),
        outputPortIds: Object.freeze(Object.keys(frame.resolvedOutputs)),
        attempts: Object.freeze(attempts)
      });
    })
  );
}
