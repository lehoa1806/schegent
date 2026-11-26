/**
 * Principal Review F1 — candidate-block legacy `retry-phase` receipt commit helper
 * extracted from `workflow-control-service.ts` to keep `workflow-control-service.ts`
 * cleanly within its LOC budget margin.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import {
  appendCommandReceipt,
  resolveRootInvocationId,
  type CommittedCommandReceipt,
  type ConnectedWorkflowRun
} from '../../state/connected-workflow-run';
import { buildWorkflowRunControlProjection } from './workflow-control-projector';
import type { ConnectedRunWriter } from './workflow-launcher';
import type {
  WorkflowControlCommandOutcome,
  WorkflowControlCommandRequest
} from './workflow-control-service';

export async function commitCandidateRetryReceipt(params: {
  readonly run: ConnectedWorkflowRun;
  readonly request: WorkflowControlCommandRequest;
  readonly candidateTargetFrameId: string;
  readonly writer: ConnectedRunWriter;
}): Promise<WorkflowControlCommandOutcome> {
  const { run, request, candidateTargetFrameId, writer } = params;

  const attachCandidateReceipt = (
    targetRun: ConnectedWorkflowRun
  ): {
    readonly withReceipt: ConnectedWorkflowRun;
    readonly receipt: CommittedCommandReceipt;
  } => {
    const rootId = resolveRootInvocationId(targetRun);
    const rootStatus = targetRun.invocations?.[rootId]?.status ?? 'in-flight';
    const targetStatus = targetRun.invocations?.[candidateTargetFrameId]?.status ?? rootStatus;
    const receipt: CommittedCommandReceipt = Object.freeze({
      commandId: request.commandId,
      operation: request.operation,
      targetInvocationId: candidateTargetFrameId,
      ...(request.targetNodeId !== undefined ? { targetNodeId: request.targetNodeId } : {}),
      committedRevision: targetRun.revision + 1,
      committedAt: request.now,
      resultingRunStatus: rootStatus,
      resultingInvocationStatus: targetStatus
    });
    return {
      withReceipt: appendCommandReceipt({ ...targetRun, revision: targetRun.revision }, receipt),
      receipt
    };
  };

  const first = attachCandidateReceipt(run);
  let written = await writer.compareAndSetConnectedRun(first.withReceipt, run.revision);
  let finalReceipt = first.receipt;

  if (written.outcome === 'stale' && written.current !== null) {
    const existing = written.current.commandReceipts?.find(
      (r) => r.commandId === request.commandId
    );
    if (existing !== undefined) {
      const sameTarget =
        existing.operation === request.operation &&
        existing.targetInvocationId === candidateTargetFrameId &&
        (request.targetNodeId === undefined ||
          existing.targetNodeId === undefined ||
          existing.targetNodeId === request.targetNodeId);
      if (sameTarget) {
        return {
          accepted: true,
          idempotentReplay: true,
          run: written.current,
          receipt: existing,
          projection: buildWorkflowRunControlProjection(written.current)
        };
      }
    } else if (written.current.revision > run.revision) {
      const retry = attachCandidateReceipt(written.current);
      finalReceipt = retry.receipt;
      written = await writer.compareAndSetConnectedRun(
        retry.withReceipt,
        written.current.revision
      );
    }
  }

  if (written.outcome === 'stale') {
    const isGuardRefusal =
      written.reason === 'immutability-violation' || written.reason === 'ownership-lost';
    return {
      accepted: false,
      refusalCode: isGuardRefusal ? 'invalid-state-for-operation' : 'stale-revision',
      reason: isGuardRefusal
        ? 'Command commit refused by connected-run immutability or ownership guard.'
        : 'Concurrent modification detected during command commit.',
      currentRevision: written.current?.revision ?? null,
      run: written.current,
      projection:
        written.current !== null ? buildWorkflowRunControlProjection(written.current) : null
    };
  }

  return {
    accepted: true,
    idempotentReplay: false,
    run: written.run,
    receipt: finalReceipt,
    projection: buildWorkflowRunControlProjection(written.run)
  };
}

