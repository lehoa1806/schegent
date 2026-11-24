/**
 * FR-R8-01 (01-05) — Candidate-block crash recovery helper, factored out of
 * `workflow-recovery-service.ts` to keep that module comfortably within its LOC budget.
 * Zero `vscode` imports.
 */

import type { ControlAdmissionPort } from '../../contracts/control-ledger';
import type { DecisionFieldValue } from '../../contracts/decision-results';
import type { ResolvedPortValue } from '../../contracts/run-request';
import {
  attemptsForNode,
  setRecoveryDisposition,
  upsertInvocationFrame,
  type ConnectedWorkflowRun,
  type RecoveryDispositionRecord,
  type WorkflowInvocationFrame
} from '../../state/connected-workflow-run';
import type { PhaseHandoffCoordinator } from '../phase-context/phase-handoff-coordinator';
import { resolveWorkflowPublicOutputs } from './binding-resolver';
import { findCandidateBlockRecoveryState } from './candidate-block-coordinator';
import type { CandidateBlockExecutor } from './candidate-block-executor';
import { commitRecoveredRunAndReleaseTerminalPins } from './phase-handoff-execution-bridge';
import {
  buildWorkflowRunControlProjection,
  type WorkflowRunControlProjection
} from './workflow-control-projector';
import type { ConnectedRunWriter } from './workflow-launcher';

export async function tryReconcileCandidateBlockFrames(input: {
  readonly run: ConnectedWorkflowRun;
  readonly rootId: string;
  readonly queueId: string;
  readonly now: number;
  readonly executor: CandidateBlockExecutor;
  readonly connectedRuns: ConnectedRunWriter;
  readonly phaseHandoffCoordinator?: PhaseHandoffCoordinator | undefined;
  readonly controlAdmission?: ControlAdmissionPort | undefined;
  readonly releaseQueueLease?: ((queueId: string, runId: string) => Promise<void> | void) | undefined;
  readonly completeParent: (args: {
    readonly writer: ConnectedRunWriter;
    readonly run: ConnectedWorkflowRun;
    readonly invocationId: string;
    readonly nodeId: string;
    readonly attemptIndex: number;
    readonly completedAt: number;
    readonly declaredOutputs: Readonly<Record<string, ResolvedPortValue>>;
    readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>> | undefined;
  }) => Promise<unknown>;
  readonly dispatchStep: (args: {
    readonly writer: ConnectedRunWriter;
    readonly run: ConnectedWorkflowRun;
    readonly invocationId: string;
    readonly nodeId: string;
    readonly startedAt: number;
  }) => Promise<unknown>;
}): Promise<{
  readonly runId: string;
  readonly mutated: boolean;
  readonly disposition: RecoveryDispositionRecord;
  readonly run: ConnectedWorkflowRun;
  readonly projection: WorkflowRunControlProjection;
} | null> {
  const { run, rootId, queueId, now, executor } = input;
  for (const cbFrame of Object.values(run.invocations ?? {})) {
    if (cbFrame.status !== 'in-flight') continue;
    const cbWf = run.frozenClosure?.workflowsById[cbFrame.workflowId];
    if (cbWf?.control?.kind !== 'candidate-block') continue;
    const cbState = findCandidateBlockRecoveryState({ executor, run, frame: cbFrame });
    if (cbState.kind === 'none') continue;

    let staged = run;
    const writer: ConnectedRunWriter = {
      async compareAndSetConnectedRun(next) {
        staged = next;
        return { outcome: 'written' as const, run: staged };
      }
    };

    if (cbState.kind === 'return-already-committed') {
      const publicOutputs = resolveWorkflowPublicOutputs({
        workflow: cbWf,
        frame: cbFrame,
        selectedCandidateId: cbState.winningCandidateId
      });
      const completedFrame: WorkflowInvocationFrame = {
        ...cbFrame,
        activeNodeId: null,
        status: 'completed',
        completedAt: now,
        resolvedOutputs: publicOutputs.ok ? publicOutputs.resolvedByPort : Object.freeze({})
      };
      staged = upsertInvocationFrame(staged, completedFrame);
      if (cbFrame.parentInvocationId !== null && cbFrame.parentCallNodeId !== null) {
        const parentFrame = staged.invocations?.[cbFrame.parentInvocationId];
        const parentAttempt = attemptsForNode(parentFrame, cbFrame.parentCallNodeId).find(
          (a) => a.childInvocationId === cbFrame.invocationId
        );
        if (parentFrame !== undefined && parentAttempt !== undefined) {
          await input.completeParent({
            writer,
            run: staged,
            invocationId: parentFrame.invocationId,
            nodeId: parentAttempt.nodeId,
            attemptIndex: parentAttempt.attemptIndex,
            completedAt: now,
            declaredOutputs: completedFrame.resolvedOutputs,
            decisionResults: cbState.decisionResults
          });
        }
      }
    } else {
      await input.dispatchStep({
        writer,
        run: staged,
        invocationId: cbFrame.invocationId,
        nodeId: cbWf.startNodeIds[0] ?? cbFrame.entryNodeId,
        startedAt: now
      });
    }

    const disposition: RecoveryDispositionRecord = Object.freeze({
      status:
        cbState.kind === 'return-already-committed'
          ? 'settled-from-evidence'
          : 'pending-dispatch-recovered',
      invocationId: cbFrame.invocationId,
      nodeId: cbFrame.activeNodeId,
      reconciledAt: now,
      reasonCode:
        cbState.kind === 'return-already-committed'
          ? 'candidate-block-return-reconciled'
          : 'candidate-block-step-reconciled'
    });
    const withDisposition = setRecoveryDisposition({ ...staged, revision: run.revision }, disposition);
    const finalRun = await commitRecoveredRunAndReleaseTerminalPins(
      input.connectedRuns,
      input.phaseHandoffCoordinator,
      withDisposition,
      run.revision
    );
    const settledRoot = finalRun.invocations?.[rootId];
    if (
      settledRoot !== undefined &&
      (settledRoot.status === 'completed' ||
        settledRoot.status === 'failed' ||
        settledRoot.status === 'canceled') &&
      finalRun.controlState !== undefined
    ) {
      await input.controlAdmission?.markRootTerminal?.({
        ledgerRunId: finalRun.controlState.ledgerRunId,
        connectedRunId: finalRun.connectedRunId,
        status: settledRoot.status,
        completedAt: now
      });
      await input.releaseQueueLease?.(queueId, finalRun.connectedRunId);
    }
    return {
      runId: finalRun.connectedRunId,
      mutated: true,
      disposition,
      run: finalRun,
      projection: buildWorkflowRunControlProjection(finalRun)
    };
  }
  return null;
}
