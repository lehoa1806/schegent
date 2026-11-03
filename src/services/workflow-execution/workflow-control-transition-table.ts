// FR-R5-F03 (T001, T003) — Authoritative control transition table for nested
// Workflow runs.
//
// Pure, deterministic classification of `pause`, `resume`, `cancel`,
// `retry-phase`, `retry-invocation`, and `continue-handoff` across root,
// active-child, completed/failed/canceled-child, and `waiting-for-handoff`
// invocation frames.
//
// Zero `vscode` imports and zero I/O: both host and headless control surfaces
// consult this single decision table.

import {
  DEFAULT_MAX_PHASE_ATTEMPTS,
  attemptsForNode,
  resolveRootInvocationId,
  type ConnectedWorkflowRun,
  type NodeAttemptRecord,
  type WorkflowControlOperation,
  type WorkflowInvocationFrame
} from '../../state/connected-workflow-run';

export type WorkflowControlRefusalCode =
  | 'run-not-found'
  | 'invocation-not-found'
  | 'node-not-found'
  | 'stale-revision'
  | 'terminal-run'
  | 'invalid-state-for-operation'
  | 'not-paused'
  | 'already-paused'
  | 'handoff-not-pending'
  | 'active-descendant-blocks-retry'
  | 'retry-bound-exceeded'
  | 'spend-bound-exceeded'
  | 'fence-lost'
  | 'queue-deleted';

export type ControlTransitionDecision =
  | {
      readonly allowed: true;
      readonly operation: WorkflowControlOperation;
      readonly targetInvocationId: string;
      readonly targetNodeId: string | null;
      readonly affectedInvocationIds: readonly string[];
      readonly isRootTarget: boolean;
    }
  | {
      readonly allowed: false;
      readonly refusalCode: WorkflowControlRefusalCode;
      readonly reason: string;
      readonly targetInvocationId: string;
    };

export interface EvaluateControlTransitionInput {
  readonly run: ConnectedWorkflowRun;
  readonly operation: WorkflowControlOperation;
  readonly targetInvocationId?: string;
  readonly targetNodeId?: string;
}

const ALL_CONTROL_OPERATIONS: readonly WorkflowControlOperation[] = Object.freeze([
  'pause',
  'resume',
  'cancel',
  'retry-phase',
  'retry-invocation',
  'continue-handoff'
]);

export function isTerminalInvocationStatus(
  status: WorkflowInvocationFrame['status']
): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

/**
 * Collect `rootTargetInvocationId` and all transitive descendant invocation IDs
 * in deterministic breadth-first order.
 */
export function collectSubtreeInvocationIds(
  run: ConnectedWorkflowRun,
  rootTargetInvocationId: string
): readonly string[] {
  const invocations = run.invocations ?? {};
  if (invocations[rootTargetInvocationId] === undefined) {
    return Object.freeze([]);
  }
  const visited: string[] = [rootTargetInvocationId];
  const seen = new Set<string>([rootTargetInvocationId]);
  let cursor = 0;
  while (cursor < visited.length) {
    const currentId = visited[cursor]!;
    cursor += 1;
    for (const candidate of Object.values(invocations)) {
      if (candidate.parentInvocationId === currentId && !seen.has(candidate.invocationId)) {
        seen.add(candidate.invocationId);
        visited.push(candidate.invocationId);
      }
    }
  }
  return Object.freeze(visited);
}

/**
 * Find the latest `NodeAttemptRecord` for a leaf Phase node within `frame`.
 */
export function findLatestLeafPhaseAttempt(
  frame: WorkflowInvocationFrame,
  targetNodeId?: string | undefined
): NodeAttemptRecord | undefined {
  if (targetNodeId !== undefined) {
    const attempts = attemptsForNode(frame, targetNodeId);
    for (let i = attempts.length - 1; i >= 0; i -= 1) {
      const candidate = attempts[i];
      if (candidate !== undefined && candidate.nodeKind === 'phase') {
        return candidate;
      }
    }
    return undefined;
  }

  if (frame.activeNodeId !== null) {
    const activeAttempts = attemptsForNode(frame, frame.activeNodeId);
    const lastActive = activeAttempts[activeAttempts.length - 1];
    if (lastActive !== undefined && lastActive.nodeKind === 'phase') {
      return lastActive;
    }
  }

  let latest: NodeAttemptRecord | undefined;
  for (const attempts of Object.values(frame.attemptsByNodeId)) {
    const last = attempts[attempts.length - 1];
    if (last === undefined || last.nodeKind !== 'phase') continue;
    if (latest === undefined || last.startedAt >= latest.startedAt) {
      latest = last;
    }
  }
  return latest;
}

function isSpendBoundExceeded(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame
): boolean {
  const frameMarkers = frame.controlMarkers;
  if (
    frameMarkers?.spendBoundUsd !== undefined &&
    frameMarkers.spendUsd >= frameMarkers.spendBoundUsd
  ) {
    return true;
  }
  const rootId = resolveRootInvocationId(run);
  const rootFrame = run.invocations?.[rootId];
  const rootMarkers = rootFrame?.controlMarkers;
  if (
    rootMarkers?.spendBoundUsd !== undefined &&
    rootMarkers.spendUsd >= rootMarkers.spendBoundUsd
  ) {
    return true;
  }
  return false;
}

function hasActiveDescendantOrSibling(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame
): boolean {
  const invocations = run.invocations ?? {};
  const subtreeIds = collectSubtreeInvocationIds(run, frame.invocationId);
  for (const id of subtreeIds) {
    if (id === frame.invocationId) continue;
    const desc = invocations[id];
    if (desc !== undefined && (desc.status === 'in-flight' || desc.status === 'waiting-for-handoff')) {
      return true;
    }
  }
  if (frame.parentInvocationId !== null && frame.parentCallNodeId !== null) {
    for (const sibling of Object.values(invocations)) {
      if (
        sibling.invocationId !== frame.invocationId &&
        sibling.parentInvocationId === frame.parentInvocationId &&
        sibling.parentCallNodeId === frame.parentCallNodeId &&
        (sibling.status === 'in-flight' || sibling.status === 'waiting-for-handoff')
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Evaluate whether `operation` is legal on `targetInvocationId` in `run`.
 */
export function evaluateControlTransition(
  input: EvaluateControlTransitionInput
): ControlTransitionDecision {
  const { run, operation } = input;
  const rootInvocationId = resolveRootInvocationId(run);
  const targetInvocationId = input.targetInvocationId ?? rootInvocationId;
  const invocations = run.invocations ?? {};
  const frame = invocations[targetInvocationId];

  if (frame === undefined) {
    return {
      allowed: false,
      refusalCode: 'invocation-not-found',
      reason: `Invocation '${targetInvocationId}' does not exist on run '${run.connectedRunId}'.`,
      targetInvocationId
    };
  }

  const rootFrame = invocations[rootInvocationId] ?? frame;
  const isRootTarget = targetInvocationId === rootInvocationId;
  const subtreeIds = collectSubtreeInvocationIds(run, targetInvocationId);

  switch (operation) {
    case 'pause': {
      if (frame.status === 'paused') {
        return {
          allowed: false,
          refusalCode: 'already-paused',
          reason: `Invocation '${targetInvocationId}' is already paused.`,
          targetInvocationId
        };
      }
      if (isTerminalInvocationStatus(frame.status)) {
        return {
          allowed: false,
          refusalCode: isTerminalInvocationStatus(rootFrame.status)
            ? 'terminal-run'
            : 'invalid-state-for-operation',
          reason: `Cannot pause invocation '${targetInvocationId}' in terminal status '${frame.status}'.`,
          targetInvocationId
        };
      }
      const affected = subtreeIds.filter((id) => {
        const sub = invocations[id];
        return sub !== undefined && !isTerminalInvocationStatus(sub.status);
      });
      return {
        allowed: true,
        operation,
        targetInvocationId,
        targetNodeId: frame.activeNodeId,
        affectedInvocationIds: Object.freeze(affected),
        isRootTarget
      };
    }

    case 'resume': {
      if (frame.status !== 'paused') {
        return {
          allowed: false,
          refusalCode: 'not-paused',
          reason: `Cannot resume invocation '${targetInvocationId}' because its status is '${frame.status}'.`,
          targetInvocationId
        };
      }
      if (isSpendBoundExceeded(run, frame)) {
        return {
          allowed: false,
          refusalCode: 'spend-bound-exceeded',
          reason: `Cannot resume invocation '${targetInvocationId}' because spend bound is exceeded.`,
          targetInvocationId
        };
      }
      const affected = subtreeIds.filter((id) => invocations[id]?.status === 'paused');
      return {
        allowed: true,
        operation,
        targetInvocationId,
        targetNodeId: frame.activeNodeId,
        affectedInvocationIds: Object.freeze(affected),
        isRootTarget
      };
    }

    case 'cancel': {
      if (isTerminalInvocationStatus(frame.status)) {
        return {
          allowed: false,
          refusalCode: isTerminalInvocationStatus(rootFrame.status)
            ? 'terminal-run'
            : 'invalid-state-for-operation',
          reason: `Cannot cancel invocation '${targetInvocationId}' in terminal status '${frame.status}'.`,
          targetInvocationId
        };
      }
      const affected = subtreeIds.filter((id) => {
        const sub = invocations[id];
        return sub !== undefined && !isTerminalInvocationStatus(sub.status);
      });
      return {
        allowed: true,
        operation,
        targetInvocationId,
        targetNodeId: frame.activeNodeId,
        affectedInvocationIds: Object.freeze(affected),
        isRootTarget
      };
    }

    case 'retry-phase': {
      if (isSpendBoundExceeded(run, frame)) {
        return {
          allowed: false,
          refusalCode: 'spend-bound-exceeded',
          reason: `Cannot retry phase in '${targetInvocationId}' because spend bound is exceeded.`,
          targetInvocationId
        };
      }
      const latestAttempt = findLatestLeafPhaseAttempt(frame, input.targetNodeId);
      if (latestAttempt === undefined) {
        return {
          allowed: false,
          refusalCode: input.targetNodeId !== undefined ? 'node-not-found' : 'invalid-state-for-operation',
          reason: `No retryable leaf Phase attempt found in invocation '${targetInvocationId}'.`,
          targetInvocationId
        };
      }
      if (latestAttempt.status === 'in-flight' || latestAttempt.status === 'completed') {
        return {
          allowed: false,
          refusalCode: 'invalid-state-for-operation',
          reason: `Leaf Phase '${latestAttempt.nodeId}' is '${latestAttempt.status}' and cannot be retried via retry-phase.`,
          targetInvocationId
        };
      }
      const maxAttempts = frame.controlMarkers?.maxPhaseAttempts ?? DEFAULT_MAX_PHASE_ATTEMPTS;
      const attemptCount = attemptsForNode(frame, latestAttempt.nodeId).length;
      if (attemptCount >= maxAttempts) {
        return {
          allowed: false,
          refusalCode: 'retry-bound-exceeded',
          reason: `Phase '${latestAttempt.nodeId}' reached maximum attempts (${maxAttempts}).`,
          targetInvocationId
        };
      }
      return {
        allowed: true,
        operation,
        targetInvocationId,
        targetNodeId: latestAttempt.nodeId,
        affectedInvocationIds: Object.freeze([targetInvocationId]),
        isRootTarget
      };
    }

    case 'retry-invocation': {
      if (isSpendBoundExceeded(run, frame)) {
        return {
          allowed: false,
          refusalCode: 'spend-bound-exceeded',
          reason: `Cannot retry invocation '${targetInvocationId}' because spend bound is exceeded.`,
          targetInvocationId
        };
      }
      if (frame.status === 'in-flight' || frame.status === 'waiting-for-handoff') {
        return {
          allowed: false,
          refusalCode: 'active-descendant-blocks-retry',
          reason: `Cannot retry invocation '${targetInvocationId}' while it is '${frame.status}'.`,
          targetInvocationId
        };
      }
      if (hasActiveDescendantOrSibling(run, frame)) {
        return {
          allowed: false,
          refusalCode: 'active-descendant-blocks-retry',
          reason: `Cannot retry invocation '${targetInvocationId}' while a descendant or sibling invocation is active.`,
          targetInvocationId
        };
      }
      if (frame.parentInvocationId !== null && frame.parentCallNodeId !== null) {
        const parentFrame = invocations[frame.parentInvocationId];
        if (parentFrame !== undefined) {
          const maxAttempts =
            parentFrame.controlMarkers?.maxPhaseAttempts ?? DEFAULT_MAX_PHASE_ATTEMPTS;
          const callAttempts = attemptsForNode(parentFrame, frame.parentCallNodeId);
          if (callAttempts.length >= maxAttempts) {
            return {
              allowed: false,
              refusalCode: 'retry-bound-exceeded',
              reason: `Child workflow call '${frame.parentCallNodeId}' reached maximum invocation attempts (${maxAttempts}).`,
              targetInvocationId
            };
          }
        }
      } else {
        const maxAttempts = frame.controlMarkers?.maxPhaseAttempts ?? DEFAULT_MAX_PHASE_ATTEMPTS;
        const entryAttempts = attemptsForNode(frame, frame.entryNodeId);
        if (entryAttempts.length >= maxAttempts) {
          return {
            allowed: false,
            refusalCode: 'retry-bound-exceeded',
            reason: `Root invocation '${targetInvocationId}' reached maximum retry attempts (${maxAttempts}).`,
            targetInvocationId
          };
        }
      }
      return {
        allowed: true,
        operation,
        targetInvocationId,
        targetNodeId: frame.parentCallNodeId ?? frame.entryNodeId,
        affectedInvocationIds: subtreeIds,
        isRootTarget
      };
    }

    case 'continue-handoff': {
      if (
        frame.status !== 'waiting-for-handoff' ||
        frame.pendingHandoff === undefined ||
        frame.pendingHandoff === null
      ) {
        return {
          allowed: false,
          refusalCode: 'handoff-not-pending',
          reason: `Invocation '${targetInvocationId}' has no pending handoff to continue.`,
          targetInvocationId
        };
      }
      const nextNodeId =
        frame.pendingHandoff.target.kind === 'node'
          ? frame.pendingHandoff.target.nodeId
          : null;
      return {
        allowed: true,
        operation,
        targetInvocationId,
        targetNodeId: nextNodeId,
        affectedInvocationIds: Object.freeze([targetInvocationId]),
        isRootTarget
      };
    }
  }
}

/**
 * Compute the bounded list of currently allowed `WorkflowControlOperation`s for
 * `invocationId` without UI guesswork.
 */
export function computeAllowedControlActions(
  run: ConnectedWorkflowRun,
  invocationId: string
): readonly WorkflowControlOperation[] {
  const allowed: WorkflowControlOperation[] = [];
  for (const operation of ALL_CONTROL_OPERATIONS) {
    const decision = evaluateControlTransition({
      run,
      operation,
      targetInvocationId: invocationId
    });
    if (decision.allowed) {
      allowed.push(operation);
    }
  }
  return Object.freeze(allowed);
}
