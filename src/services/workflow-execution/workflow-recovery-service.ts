// FR-R5-F03 (T006, T011) — New-schema restart recovery service for nested
// Workflow runs.
//
// Reconstructs frozen-plan position, active invocation, attempt lineage, and
// waiting handoffs upon host restart:
//   - preserves `waiting-for-handoff` frames without synthesizing continuations (`clean-handoff`),
//   - recovers persisted pre-dispatch `InvocationInputEnvelope`s (`acceptedAt`) without
//     consulting live UI/catalog state (`pending-dispatch-recovered`),
//   - settles interrupted `in-flight` Phase attempts when durable completion
//     evidence exists (`settled-from-evidence`),
//   - transitions interrupted `in-flight` Phase attempts with unconfirmed side
//     effects to `paused` with `manualPauseCause: 'recovery-uncertain-effect'`
//     (`uncertain-effect-paused`) rather than blindly replaying them,
//   - cancels orphaned runs whose bound queue or task was deleted (`orphaned-canceled`).
//
// Zero `vscode` imports: shared by host and headless runtime entry points.

import type { ResolvedPortValue } from '../../contracts/run-request';
import type { DecisionFieldValue } from '../../contracts/decision-results';
import type {
  ControlAdmissionPort,
  ExecutionFence
} from '../../contracts/control-ledger';
import type { WorkflowNodeTerminalStatus } from '../../contracts/workflow-definitions';
import type { ControlAttemptAdmissionService } from './control-attempt-admission';
import type { ControlNotificationService } from './control-notification-service';
import type { ControlUsageAccountingService } from './control-usage-accounting';
import type { QuotaPermit, QuotaPermitArbiter } from './quota-permit-arbiter';
import { fromPermitRecord } from './quota-permit-arbiter';
import {
  attemptsForNode,
  clearInvocationControlMarkers,
  pauseInvocationControlMarkers,
  recordNodeAttempt,
  resolveBoundQueueId,
  resolveRootInvocationId,
  setPendingHandoff,
  setRecoveryDisposition,
  upsertInvocationFrame,
  type ConnectedWorkflowRun,
  type InvocationInputEnvelope,
  type NodeAttemptRecord,
  type RecoveryDispositionRecord,
  type WorkflowInvocationFrame
} from '../../state/connected-workflow-run';
import {
  completeComposableNodeAttempt,
  dispatchComposableNode,
  type PhaseAttemptDispatchInput,
  type PhaseAttemptDispatchResult
} from './connected-run-coordinator';
import {
  handleRepeatChildCompletion,
  type RepeatExecutor
} from './repeat-executor';
import {
  buildForEachFrameKey,
  handleForEachChildSettlement,
  prepareForEachItemFrames,
  resolveFrozenForEachControl,
  type ForEachExecutor
} from './foreach-executor';
import { lookupRecord } from './control-ledger-store';
import {
  buildWorkflowRunControlProjection,
  type WorkflowRunControlProjection
} from './workflow-control-projector';
import {
  collectSubtreeInvocationIds,
  isTerminalInvocationStatus
} from './workflow-control-transition-table';
import type { ConnectedRunWriter } from './workflow-launcher';
import type { PhaseHandoffCoordinator } from '../phase-context/phase-handoff-coordinator';

export interface DurableAttemptEvidenceResult {
  readonly completed?: boolean;
  readonly settled?: boolean;
  readonly status?: WorkflowNodeTerminalStatus;
  readonly declaredOutputs?: Readonly<Record<string, ResolvedPortValue>>;
  readonly decisionResults?: Readonly<Record<string, DecisionFieldValue>>;
  readonly verdict?: 'pass' | 'fail' | null;
  readonly failureCode?: string;
  readonly completedAt?: number;
}

export type DurableAttemptEvidence = DurableAttemptEvidenceResult;

export interface WorkflowRecoveryStore extends ConnectedRunWriter {
  get(connectedRunId: string): ConnectedWorkflowRun | null;
  list?(): readonly ConnectedWorkflowRun[];
}

export interface WorkflowRecoveryServiceDeps {
  readonly connectedRuns: WorkflowRecoveryStore;
  readonly dispatchPhase: (
    input: PhaseAttemptDispatchInput
  ) => Promise<PhaseAttemptDispatchResult>;
  readonly isQueueOrTaskPresent?: (queueId: string, rootRunId: string) => boolean;
  readonly findMatchingEnqueuedAttempt?: (
    queueId: string,
    attempt: NodeAttemptRecord
  ) => string | undefined;
  readonly checkDurableAttemptEvidence?: (
    run: ConnectedWorkflowRun,
    frame: WorkflowInvocationFrame,
    attempt: NodeAttemptRecord
  ) => Promise<DurableAttemptEvidenceResult> | DurableAttemptEvidenceResult;
  readonly releaseQueueLease?: (
    queueId: string,
    runId: string
  ) => Promise<void> | void;
  readonly controlAdmission?:
    | (ControlAdmissionPort & Pick<ControlAttemptAdmissionService, 'reconcileControlRoot'>)
    | ControlAttemptAdmissionService
    | undefined;
  readonly repeatExecutor?: RepeatExecutor | undefined;
  readonly forEachExecutor?: ForEachExecutor | undefined;
  readonly phaseHandoffCoordinator?: PhaseHandoffCoordinator | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly quotaPermitArbiter?: QuotaPermitArbiter | undefined;
  readonly notificationService?: ControlNotificationService | undefined;
  readonly usageAccounting?: ControlUsageAccountingService | undefined;
  readonly resolveRecoveryFence?: (
    run: ConnectedWorkflowRun,
    queueId: string
  ) => ExecutionFence;
}

export interface ReconcileConnectedRunResult {
  readonly runId: string;
  readonly mutated: boolean;
  readonly disposition: RecoveryDispositionRecord | null;
  readonly run: ConnectedWorkflowRun;
  readonly projection: WorkflowRunControlProjection;
  readonly retainedUncertainPermits?: readonly QuotaPermit[] | undefined;
  readonly claimedNotificationIds?: readonly string[] | undefined;
}

function createStagingWriter(initial: ConnectedWorkflowRun): {
  readonly writer: ConnectedRunWriter;
  readonly current: () => ConnectedWorkflowRun;
  readonly set: (run: ConnectedWorkflowRun) => void;
} {
  let staged = initial;
  const writer: ConnectedRunWriter = {
    async compareAndSetConnectedRun(
      next: ConnectedWorkflowRun,
      _expectedRevision: number
    ) {
      staged = next;
      return { outcome: 'written' as const, run: staged };
    }
  };
  return {
    writer,
    current: () => staged,
    set: (run: ConnectedWorkflowRun) => {
      staged = run;
    }
  };
}

function findWaitingHandoffFrame(
  run: ConnectedWorkflowRun
): WorkflowInvocationFrame | undefined {
  for (const frame of Object.values(run.invocations ?? {})) {
    if (
      frame.status === 'waiting-for-handoff' &&
      frame.pendingHandoff !== null &&
      frame.pendingHandoff !== undefined
    ) {
      return frame;
    }
  }
  return undefined;
}

function findAcceptedEnvelopeForHandoff(
  run: ConnectedWorkflowRun,
  frame: WorkflowInvocationFrame
): InvocationInputEnvelope | undefined {
  const pending = frame.pendingHandoff;
  if (pending === undefined || pending === null) return undefined;
  if (pending.acceptedEnvelope !== undefined) {
    return pending.acceptedEnvelope;
  }
  if (pending.target.kind !== 'node') return undefined;
  const targetNodeId = pending.target.nodeId;
  const envelopes = run.inputEnvelopes ?? [];
  for (let i = envelopes.length - 1; i >= 0; i -= 1) {
    const candidate = envelopes[i];
    if (
      candidate !== undefined &&
      candidate.invocationId === frame.invocationId &&
      candidate.targetNodeId === targetNodeId &&
      candidate.source === 'manual-continuation' &&
      candidate.acceptedAt >= pending.pausedAt
    ) {
      return candidate;
    }
  }
  return undefined;
}

function findInterruptedLeafAttempt(
  run: ConnectedWorkflowRun
): { readonly frame: WorkflowInvocationFrame; readonly attempt: NodeAttemptRecord } | undefined {
  let best: { frame: WorkflowInvocationFrame; attempt: NodeAttemptRecord } | undefined;
  for (const frame of Object.values(run.invocations ?? {})) {
    if (frame.status !== 'in-flight') continue;
    for (const attempts of Object.values(frame.attemptsByNodeId)) {
      const last = attempts[attempts.length - 1];
      if (
        last !== undefined &&
        (last.status === 'in-flight' || last.status === 'pending-dispatch') &&
        last.nodeKind === 'phase'
      ) {
        if (best === undefined || frame.depth >= best.frame.depth) {
          best = { frame, attempt: last };
        }
      }
    }
  }
  return best;
}

function collectAncestorInvocationIds(
  run: ConnectedWorkflowRun,
  invocationId: string
): readonly string[] {
  const invocations = run.invocations ?? {};
  const ancestors: string[] = [];
  let cursor = invocations[invocationId]?.parentInvocationId ?? null;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    ancestors.push(cursor);
    cursor = invocations[cursor]?.parentInvocationId ?? null;
  }
  return ancestors;
}

export class WorkflowRecoveryService {
  constructor(private readonly deps: WorkflowRecoveryServiceDeps) {}

  /**
   * Reconcile a single persisted `ConnectedWorkflowRun` on host activation/restart.
   */
  public async reconcileRun(
    runId: string,
    now: number
  ): Promise<ReconcileConnectedRunResult | undefined> {
    const run = this.deps.connectedRuns.get(runId);
    if (run === null) {
      return undefined;
    }

    const queueId = resolveBoundQueueId(run);
    const rootId = resolveRootInvocationId(run);
    const rootFrame = run.invocations?.[rootId];

    let retainedUncertainPermits: readonly QuotaPermit[] | undefined;
    let claimedNotificationIds: readonly string[] | undefined;
    if (run.controlState !== undefined && this.deps.controlAdmission !== undefined) {
      const recoveryFence =
        this.deps.resolveRecoveryFence?.(run, queueId) ?? {
          primacyClaim: `primacy:${run.connectedRunId}`,
          queueClaim: `queue:${queueId}`,
          rootGeneration: 1
        };
      const reconciledRoot = await this.deps.controlAdmission.reconcileControlRoot({
        ledgerRunId: run.controlState.ledgerRunId,
        connectedRun: run,
        newFence: recoveryFence
      });
      if (reconciledRoot.ledger !== undefined) {
        const uncertainList: QuotaPermit[] = [];
        for (const pRec of Object.values(reconciledRoot.ledger.permits)) {
          if (
            (pRec.rootRunId ?? pRec.ledgerRunId) === run.controlState.ledgerRunId &&
            (pRec.status === 'held-uncertain' || pRec.state === 'uncertain')
          ) {
            const parsed = fromPermitRecord(pRec, recoveryFence);
            if (parsed !== undefined) {
              uncertainList.push(parsed);
            }
          }
        }
        retainedUncertainPermits = Object.freeze(uncertainList);
      }
      if (this.deps.notificationService !== undefined) {
        const flushed = await this.deps.notificationService.flushPendingNotifications(
          run.controlState.ledgerRunId
        );
        claimedNotificationIds = Object.freeze(
          flushed.map((n) => n.notificationId)
        );
      }
    }

    // 1. Terminal runs: no-op, ensure lease is released.
    if (rootFrame !== undefined && isTerminalInvocationStatus(rootFrame.status)) {
      await this.deps.releaseQueueLease?.(queueId, run.connectedRunId);
      return {
        runId: run.connectedRunId,
        mutated: false,
        disposition: run.recoveryDisposition ?? null,
        run,
        projection: buildWorkflowRunControlProjection(run),
        ...(retainedUncertainPermits !== undefined
          ? { retainedUncertainPermits }
          : {}),
        ...(claimedNotificationIds !== undefined ? { claimedNotificationIds } : {})
      };
    }

    // 2. Orphaned runs (bound queue or backing task deleted): cancel only this run.
    if (
      this.deps.isQueueOrTaskPresent !== undefined &&
      !this.deps.isQueueOrTaskPresent(queueId, run.connectedRunId)
    ) {
      const staging = createStagingWriter(run);
      let nextRun = staging.current();
      const subtreeIds = collectSubtreeInvocationIds(nextRun, rootId);
      for (const invId of subtreeIds) {
        const frame = nextRun.invocations?.[invId];
        if (frame === undefined || isTerminalInvocationStatus(frame.status)) continue;
        let updatedFrame: WorkflowInvocationFrame = {
          ...frame,
          activeNodeId: null,
          status: 'canceled',
          completedAt: now,
          pendingHandoff: null,
          controlMarkers: clearInvocationControlMarkers(frame.controlMarkers)
        };
        for (const attempts of Object.values(updatedFrame.attemptsByNodeId)) {
          const last = attempts[attempts.length - 1];
          if (
            last !== undefined &&
            (last.status === 'in-flight' ||
              last.status === 'pending-dispatch' ||
              last.status === 'paused')
          ) {
            updatedFrame = recordNodeAttempt(updatedFrame, {
              ...last,
              status: 'canceled',
              completedAt: now
            });
          }
        }
        nextRun = upsertInvocationFrame(nextRun, updatedFrame);
      }
      if (nextRun.pendingHandoff !== undefined && nextRun.pendingHandoff !== null) {
        nextRun = setPendingHandoff(nextRun, null);
      }
      const disposition: RecoveryDispositionRecord = Object.freeze({
        status: 'orphaned-canceled',
        invocationId: rootId,
        nodeId: rootFrame?.activeNodeId ?? null,
        reconciledAt: now,
        reasonCode: 'bound-queue-or-task-deleted'
      });
      nextRun = setRecoveryDisposition({ ...nextRun, revision: run.revision }, disposition);
      const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
        nextRun,
        run.revision
      );
      const finalRun = written.outcome === 'written' ? written.run : written.current ?? nextRun;
      await this.deps.releaseQueueLease?.(queueId, run.connectedRunId);
      return {
        runId: finalRun.connectedRunId,
        mutated: true,
        disposition,
        run: finalRun,
        projection: buildWorkflowRunControlProjection(finalRun),
        ...(retainedUncertainPermits !== undefined
          ? { retainedUncertainPermits }
          : {}),
        ...(claimedNotificationIds !== undefined ? { claimedNotificationIds } : {})
      };
    }

    // 3. Waiting-for-handoff frames:
    const waitingFrame = findWaitingHandoffFrame(run);
    if (
      waitingFrame !== undefined &&
      waitingFrame.pendingHandoff !== null &&
      waitingFrame.pendingHandoff !== undefined
    ) {
      const acceptedEnvelope = findAcceptedEnvelopeForHandoff(run, waitingFrame);
      const targetNodeId =
        waitingFrame.pendingHandoff.target.kind === 'node'
          ? waitingFrame.pendingHandoff.target.nodeId
          : null;

      if (acceptedEnvelope !== undefined && targetNodeId !== null) {
        // Post-acceptance, pre-dispatch crash: recover from persisted InvocationInputEnvelope.
        const staging = createStagingWriter(run);
        let nextRun = setPendingHandoff(staging.current(), null);
        // The accepted envelope reaches the target through `run.inputEnvelopes` at dispatch. The
        // frame's `boundInputs` are the Workflow's public inputs and stay as launched.
        nextRun = upsertInvocationFrame(nextRun, {
          ...waitingFrame,
          status: 'in-flight',
          pendingHandoff: null
        });
        staging.set(nextRun);

        const dispatched = await dispatchComposableNode(
          {
            connectedRuns: staging.writer,
            dispatchPhase: this.deps.dispatchPhase
          },
          {
            run: staging.current(),
            invocationId: waitingFrame.invocationId,
            nodeId: targetNodeId,
            startedAt: now
          }
        );

        if (
          dispatched.outcome === 'phase-dispatched' ||
          dispatched.outcome === 'waiting-for-handoff' ||
          dispatched.outcome === 'workflow-completed'
        ) {
          const disposition: RecoveryDispositionRecord = Object.freeze({
            status: 'pending-dispatch-recovered',
            invocationId: waitingFrame.invocationId,
            nodeId: targetNodeId,
            reconciledAt: now,
            reasonCode: 'recovered-accepted-input-envelope'
          });
          const withDisposition = setRecoveryDisposition(
            { ...staging.current(), revision: run.revision },
            disposition
          );
          const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
            withDisposition,
            run.revision
          );
          const finalRun =
            written.outcome === 'written' ? written.run : written.current ?? withDisposition;
          return {
            runId: finalRun.connectedRunId,
            mutated: true,
            disposition,
            run: finalRun,
            projection: buildWorkflowRunControlProjection(finalRun)
          };
        }

        // Handoff redispatch failed: fall back to paused with recovery-uncertain-effect
        // rather than falsely stamping pending-dispatch-recovered.
        let fallbackRun = run;
        const pausedHandoffFrame: WorkflowInvocationFrame = {
          ...waitingFrame,
          status: 'paused',
          activeNodeId: targetNodeId,
          controlMarkers: pauseInvocationControlMarkers(
            waitingFrame.controlMarkers,
            now,
            'recovery-uncertain-effect'
          )
        };
        fallbackRun = upsertInvocationFrame(fallbackRun, pausedHandoffFrame);
        for (const ancId of collectAncestorInvocationIds(fallbackRun, waitingFrame.invocationId)) {
          const anc = fallbackRun.invocations?.[ancId];
          if (anc === undefined || isTerminalInvocationStatus(anc.status)) continue;
          fallbackRun = upsertInvocationFrame(fallbackRun, {
            ...anc,
            status: 'paused',
            controlMarkers: pauseInvocationControlMarkers(
              anc.controlMarkers,
              now,
              'recovery-uncertain-effect'
            )
          });
        }
        const disposition: RecoveryDispositionRecord = Object.freeze({
          status: 'uncertain-effect-paused',
          invocationId: waitingFrame.invocationId,
          nodeId: targetNodeId,
          reconciledAt: now,
          reasonCode: 'handoff-redispatch-failed'
        });
        const withDisposition = setRecoveryDisposition(
          { ...fallbackRun, revision: run.revision },
          disposition
        );
        const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
          withDisposition,
          run.revision
        );
        const finalRun =
          written.outcome === 'written' ? written.run : written.current ?? withDisposition;
        return {
          runId: finalRun.connectedRunId,
          mutated: true,
          disposition,
          run: finalRun,
          projection: buildWorkflowRunControlProjection(finalRun)
        };
      }

      // Clean waiting-for-handoff: preserve waiting state without synthesizing continuation.
      const disposition: RecoveryDispositionRecord = Object.freeze({
        status: 'clean-handoff',
        invocationId: waitingFrame.invocationId,
        nodeId: targetNodeId,
        reconciledAt: now,
        reasonCode: 'awaiting-operator-handoff'
      });
      const withDisposition = setRecoveryDisposition(
        { ...run, revision: run.revision },
        disposition
      );
      const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
        withDisposition,
        run.revision
      );
      const finalRun =
        written.outcome === 'written' ? written.run : written.current ?? withDisposition;
      return {
        runId: finalRun.connectedRunId,
        mutated: true,
        disposition,
        run: finalRun,
        projection: buildWorkflowRunControlProjection(finalRun),
        ...(retainedUncertainPermits !== undefined
          ? { retainedUncertainPermits }
          : {}),
        ...(claimedNotificationIds !== undefined ? { claimedNotificationIds } : {})
      };
    }

    // 4. Interrupted in-flight leaf Phase attempt:
    const interrupted = findInterruptedLeafAttempt(run);
    if (interrupted !== undefined) {
      const { frame, attempt } = interrupted;
      const evidence =
        this.deps.checkDurableAttemptEvidence !== undefined
          ? await this.deps.checkDurableAttemptEvidence(run, frame, attempt)
          : { completed: false };

      const staging = createStagingWriter(run);

      if (evidence.completed) {
        // Durable completion evidence exists: settle attempt forward and advance graph.
        await completeComposableNodeAttempt(
          {
            connectedRuns: staging.writer,
            dispatchPhase: this.deps.dispatchPhase,
            ...(this.deps.controlAdmission !== undefined
              ? { controlAdmission: this.deps.controlAdmission }
              : {}),
            ...(this.deps.repeatExecutor !== undefined
              ? { repeatExecutor: this.deps.repeatExecutor }
              : {}),
            ...(this.deps.forEachExecutor !== undefined
              ? { forEachExecutor: this.deps.forEachExecutor }
              : {}),
            ...(this.deps.workspaceRoot !== undefined
              ? { workspaceRoot: this.deps.workspaceRoot }
              : {}),
            ...(this.deps.resolveRecoveryFence !== undefined
              ? { resolveExecutionFence: this.deps.resolveRecoveryFence }
              : {})
          },
          {
            run: staging.current(),
            invocationId: frame.invocationId,
            nodeId: attempt.nodeId,
            attemptIndex: attempt.attemptIndex,
            status: evidence.status ?? 'completed',
            completedAt: evidence.completedAt ?? now,
            ...(evidence.declaredOutputs !== undefined
              ? { declaredOutputs: evidence.declaredOutputs }
              : {}),
            ...(evidence.decisionResults !== undefined
              ? { decisionResults: evidence.decisionResults }
              : {}),
            ...(evidence.verdict !== undefined ? { verdict: evidence.verdict } : {}),
            ...(evidence.failureCode !== undefined ? { failureCode: evidence.failureCode } : {})
          }
        );

        const disposition: RecoveryDispositionRecord = Object.freeze({
          status: 'settled-from-evidence',
          invocationId: frame.invocationId,
          nodeId: attempt.nodeId,
          attemptId: attempt.attemptId,
          reconciledAt: now,
          reasonCode: 'durable-attempt-completion-verified'
        });
        const withDisposition = setRecoveryDisposition(
          { ...staging.current(), revision: run.revision },
          disposition
        );
        const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
          withDisposition,
          run.revision
        );
        const finalRun =
          written.outcome === 'written' ? written.run : written.current ?? withDisposition;
        const settledRoot = finalRun.invocations?.[rootId];
        if (settledRoot !== undefined && isTerminalInvocationStatus(settledRoot.status)) {
          await this.deps.releaseQueueLease?.(queueId, finalRun.connectedRunId);
        }
        return {
          runId: finalRun.connectedRunId,
          mutated: true,
          disposition,
          run: finalRun,
          projection: buildWorkflowRunControlProjection(finalRun)
        };
      }

      if (attempt.status === 'pending-dispatch') {
        let resolvedQueueItemId = this.deps.findMatchingEnqueuedAttempt?.(queueId, attempt);
        if (resolvedQueueItemId === undefined && run.controlState === undefined) {
          const workflowDef = run.frozenClosure?.workflowsById[frame.workflowId] ?? run.graph;
          const phaseNode = workflowDef.nodes.find((candidate) => candidate.nodeId === attempt.nodeId);
          if (phaseNode !== undefined && phaseNode.kind === 'phase') {
            const phaseDef = run.frozenClosure?.phasesById[phaseNode.phaseId ?? ''] ?? {
              phaseId: phaseNode.phaseId ?? attempt.nodeId,
              name: phaseNode.label ?? attempt.nodeId,
              version: 1,
              instruction: ''
            };
            const phaseResult = await this.deps.dispatchPhase({
              run,
              frame,
              node: phaseNode,
              phase: phaseDef,
              boundInputs: attempt.inputEnvelope.inputsByPort,
              inputEnvelope: attempt.inputEnvelope,
              attemptId: attempt.attemptId,
              attemptIndex: attempt.attemptIndex,
              queueId,
              startedAt: attempt.startedAt
            });
            if (phaseResult.outcome === 'dispatched') {
              resolvedQueueItemId = phaseResult.queueItemId;
            }
          }
        }
        if (resolvedQueueItemId !== undefined) {
          const boundAttempt: NodeAttemptRecord = {
            ...attempt,
            status: 'in-flight',
            queueItemId: resolvedQueueItemId
          };
          const updatedFrame: WorkflowInvocationFrame = {
            ...recordNodeAttempt(frame, boundAttempt),
            status: 'in-flight',
            activeNodeId: attempt.nodeId
          };
          const recoveredRun = upsertInvocationFrame(run, updatedFrame);
          const disposition: RecoveryDispositionRecord = Object.freeze({
            status: 'pending-dispatch-recovered',
            invocationId: frame.invocationId,
            nodeId: attempt.nodeId,
            attemptId: attempt.attemptId,
            reconciledAt: now,
            reasonCode: 'recovered-pending-dispatch-attempt'
          });
          const withDisposition = setRecoveryDisposition(
            { ...recoveredRun, revision: run.revision },
            disposition
          );
          const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
            withDisposition,
            run.revision
          );
          const finalRun =
            written.outcome === 'written' ? written.run : written.current ?? withDisposition;
          return {
            runId: finalRun.connectedRunId,
            mutated: true,
            disposition,
            run: finalRun,
            projection: buildWorkflowRunControlProjection(finalRun)
          };
        }
      }

      // No durable completion evidence: transition to 'paused' with 'recovery-uncertain-effect'.
      let nextRun = staging.current();
      const pausedAttempt: NodeAttemptRecord = {
        ...attempt,
        status: 'paused',
        completedAt: now
      };
      const pausedLeafFrame: WorkflowInvocationFrame = {
        ...recordNodeAttempt(frame, pausedAttempt),
        status: 'paused',
        controlMarkers: pauseInvocationControlMarkers(
          frame.controlMarkers,
          now,
          'recovery-uncertain-effect'
        )
      };
      nextRun = upsertInvocationFrame(nextRun, pausedLeafFrame);

      for (const ancId of collectAncestorInvocationIds(nextRun, frame.invocationId)) {
        const anc = nextRun.invocations?.[ancId];
        if (anc === undefined || isTerminalInvocationStatus(anc.status)) continue;
        nextRun = upsertInvocationFrame(nextRun, {
          ...anc,
          status: 'paused',
          controlMarkers: pauseInvocationControlMarkers(
            anc.controlMarkers,
            now,
            'recovery-uncertain-effect'
          )
        });
      }

      const disposition: RecoveryDispositionRecord = Object.freeze({
        status: 'uncertain-effect-paused',
        invocationId: frame.invocationId,
        nodeId: attempt.nodeId,
        attemptId: attempt.attemptId,
        reconciledAt: now,
        reasonCode: 'interrupted-attempt-missing-completion-evidence'
      });
      nextRun = setRecoveryDisposition({ ...nextRun, revision: run.revision }, disposition);
      const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
        nextRun,
        run.revision
      );
      const finalRun = written.outcome === 'written' ? written.run : written.current ?? nextRun;
      return {
        runId: finalRun.connectedRunId,
        mutated: true,
        disposition,
        run: finalRun,
        projection: buildWorkflowRunControlProjection(finalRun),
        ...(retainedUncertainPermits !== undefined
          ? { retainedUncertainPermits }
          : {})
      };
    }

    // 5. Post-child-return Repeat reconciliation (crash after child completed before parent Repeat advanced):
    for (const parentFrame of Object.values(run.invocations ?? {})) {
      if (parentFrame.status !== 'in-flight') continue;
      const parentWf = run.frozenClosure?.workflowsById[parentFrame.workflowId];
      if (parentWf === undefined) continue;
      for (const parentNode of parentWf.nodes) {
        if (parentNode.control?.kind !== 'repeat') continue;
        const nodeAttempts = attemptsForNode(parentFrame, parentNode.nodeId);
        const latestParentAtt = nodeAttempts.at(-1);
        if (
          latestParentAtt === undefined ||
          latestParentAtt.status !== 'in-flight' ||
          latestParentAtt.childInvocationId === undefined
        ) {
          continue;
        }
        const childFrame = run.invocations?.[latestParentAtt.childInvocationId];
        const childWf =
          childFrame !== undefined
            ? run.frozenClosure?.workflowsById[childFrame.workflowId]
            : undefined;
        if (childFrame?.status !== 'completed' || childWf === undefined) continue;

        const staging = createStagingWriter(run);
        const recoveryFence = this.deps.resolveRecoveryFence?.(run, queueId);
        const repeatRes = await handleRepeatChildCompletion({
          run: staging.current(),
          parentFrame,
          parentWorkflow: parentWf,
          parentNode,
          parentAttempt: latestParentAtt,
          completedChildFrame: childFrame,
          childWorkflow: childWf,
          childOutputs: childFrame.resolvedOutputs,
          completedAt: childFrame.completedAt ?? now,
          repeatExecutor: this.deps.repeatExecutor,
          fence: recoveryFence
        });
        staging.set(repeatRes.run);

        if (repeatRes.kind === 'accepted') {
          await completeComposableNodeAttempt(
            {
              connectedRuns: staging.writer,
              dispatchPhase: this.deps.dispatchPhase,
              ...(this.deps.controlAdmission !== undefined
                ? { controlAdmission: this.deps.controlAdmission }
                : {}),
              ...(this.deps.repeatExecutor !== undefined
                ? { repeatExecutor: this.deps.repeatExecutor }
                : {}),
              ...(this.deps.resolveRecoveryFence !== undefined
                ? { resolveExecutionFence: this.deps.resolveRecoveryFence }
                : {})
            },
            {
              run: staging.current(),
              invocationId: parentFrame.invocationId,
              nodeId: parentNode.nodeId,
              attemptIndex: latestParentAtt.attemptIndex,
              status: 'completed',
              completedAt: now,
              declaredOutputs: repeatRes.exportedOutputs
            }
          );
        } else if (repeatRes.kind === 'advance') {
          await dispatchComposableNode(
            {
              connectedRuns: staging.writer,
              dispatchPhase: this.deps.dispatchPhase,
              ...(this.deps.controlAdmission !== undefined
                ? { controlAdmission: this.deps.controlAdmission }
                : {}),
              ...(this.deps.repeatExecutor !== undefined
                ? { repeatExecutor: this.deps.repeatExecutor }
                : {}),
              ...(this.deps.resolveRecoveryFence !== undefined
                ? { resolveExecutionFence: this.deps.resolveRecoveryFence }
                : {})
            },
            {
              run: staging.current(),
              invocationId: repeatRes.nextChildInvocationId,
              nodeId: repeatRes.childEntryNodeId,
              startedAt: now
            }
          );
        }

        const disposition: RecoveryDispositionRecord = Object.freeze({
          status: 'settled-from-evidence',
          invocationId: parentFrame.invocationId,
          nodeId: parentNode.nodeId,
          attemptId: latestParentAtt.attemptId,
          reconciledAt: now,
          reasonCode: 'repeat-post-pass-reconciled'
        });
        const withDisposition = setRecoveryDisposition(
          { ...staging.current(), revision: run.revision },
          disposition
        );
        const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
          withDisposition,
          run.revision
        );
        const finalRun =
          written.outcome === 'written' ? written.run : written.current ?? withDisposition;
        return {
          runId: finalRun.connectedRunId,
          mutated: true,
          disposition,
          run: finalRun,
          projection: buildWorkflowRunControlProjection(finalRun)
        };
      }
    }

    // 6. Post-child-settlement / mid-slot ForEach reconciliation (crash across any slot boundary):
    for (const parentFrame of Object.values(run.invocations ?? {})) {
      if (parentFrame.status !== 'in-flight') continue;
      const parentWf = run.frozenClosure?.workflowsById[parentFrame.workflowId];
      if (parentWf === undefined) continue;
      for (const parentNode of parentWf.nodes) {
        if (parentNode.control?.kind !== 'for-each') continue;
        const resolvedCtrl = resolveFrozenForEachControl(run, parentWf, parentNode, parentFrame);
        if (!resolvedCtrl.ok) continue;

        const nodeAttempts = attemptsForNode(parentFrame, parentNode.nodeId);
        const latestParentAtt = nodeAttempts.at(-1);
        const ledgerRunId = run.controlState?.ledgerRunId ?? run.connectedRunId;
        const frameKey = buildForEachFrameKey(parentFrame.invocationId, parentNode.nodeId);
        const loadedLedger = this.deps.forEachExecutor?.getLedgerStore().read();
        const ledgerRoot =
          loadedLedger !== undefined && loadedLedger.ok
            ? lookupRecord(loadedLedger.ledger.roots, ledgerRunId)
            : undefined;
        const ledgerFrame =
          ledgerRoot !== undefined ? lookupRecord(ledgerRoot.framesByKey, frameKey) : undefined;
        const ledgerFe = ledgerFrame?.forEachState;

        // Case A: Crash after collection freeze (before item 0 frame created) or after item advance
        // (ledger currentIndex advanced to k, while run only has k attempts recorded)
        if (
          ledgerFrame?.status === 'in-flight' &&
          ledgerFe !== undefined &&
          (ledgerFe.itemCount ?? ledgerFe.totalItems) > 0 &&
          nodeAttempts.length === ledgerFe.currentIndex
        ) {
          const staging = createStagingWriter(run);
          let parentForPrep = parentFrame;
          if (latestParentAtt !== undefined && latestParentAtt.status === 'in-flight') {
            const prevSlot = ledgerFe.slots.at(ledgerFe.currentIndex - 1);
            const settledPrev: NodeAttemptRecord = Object.freeze({
              ...latestParentAtt,
              status: prevSlot?.state === 'failed' ? 'failed' : 'completed',
              completedAt: now,
              declaredOutputs: Object.freeze({})
            });
            parentForPrep = recordNodeAttempt(parentFrame, settledPrev);
          }
          const baseInputs =
            nodeAttempts.at(0)?.inputEnvelope.inputsByPort ?? parentFrame.boundInputs;
          const itemJson = ledgerFe.frozenItemsJson?.at(ledgerFe.currentIndex) ?? '{}';
          const prepared = prepareForEachItemFrames({
            run: staging.current(),
            parentFrame: parentForPrep,
            node: parentNode,
            childWorkflow: resolvedCtrl.childWorkflow,
            itemIndex: ledgerFe.currentIndex,
            itemInputPortId: resolvedCtrl.control.itemInputPortId,
            itemCanonicalJson: itemJson,
            baseInputsByPort: baseInputs,
            startedAt: now
          });
          if (prepared !== null) {
            staging.set(prepared.nextRun);
            await dispatchComposableNode(
              {
                connectedRuns: staging.writer,
                dispatchPhase: this.deps.dispatchPhase,
                ...(this.deps.controlAdmission !== undefined
                  ? { controlAdmission: this.deps.controlAdmission }
                  : {}),
                ...(this.deps.forEachExecutor !== undefined
                  ? { forEachExecutor: this.deps.forEachExecutor }
                  : {}),
                ...(this.deps.workspaceRoot !== undefined
                  ? { workspaceRoot: this.deps.workspaceRoot }
                  : {})
              },
              {
                run: staging.current(),
                invocationId: prepared.childFrame.invocationId,
                nodeId: prepared.childEntryNodeId,
                startedAt: now
              }
            );
            const disposition: RecoveryDispositionRecord = Object.freeze({
              status: 'pending-dispatch-recovered',
              invocationId: parentFrame.invocationId,
              nodeId: parentNode.nodeId,
              attemptId: prepared.parentAttempt.attemptId,
              reconciledAt: now,
              reasonCode: 'foreach-slot-advance-recovered'
            });
            const withDisposition = setRecoveryDisposition(
              { ...staging.current(), revision: run.revision },
              disposition
            );
            const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
              withDisposition,
              run.revision
            );
            const finalRun =
              written.outcome === 'written' ? written.run : written.current ?? withDisposition;
            return {
              runId: finalRun.connectedRunId,
              mutated: true,
              disposition,
              run: finalRun,
              projection: buildWorkflowRunControlProjection(finalRun)
            };
          }
        }

        if (
          latestParentAtt === undefined ||
          latestParentAtt.status !== 'in-flight' ||
          latestParentAtt.childInvocationId === undefined
        ) {
          continue;
        }
        const childFrame = run.invocations?.[latestParentAtt.childInvocationId];
        if (childFrame === undefined) continue;

        // Case B: Crash after child admission before child entry node was dispatched
        if (
          childFrame.status === 'in-flight' &&
          Object.keys(childFrame.attemptsByNodeId).length === 0
        ) {
          const staging = createStagingWriter(run);
          await dispatchComposableNode(
            {
              connectedRuns: staging.writer,
              dispatchPhase: this.deps.dispatchPhase,
              ...(this.deps.controlAdmission !== undefined
                ? { controlAdmission: this.deps.controlAdmission }
                : {}),
              ...(this.deps.forEachExecutor !== undefined
                ? { forEachExecutor: this.deps.forEachExecutor }
                : {}),
              ...(this.deps.workspaceRoot !== undefined
                ? { workspaceRoot: this.deps.workspaceRoot }
                : {})
            },
            {
              run: staging.current(),
              invocationId: childFrame.invocationId,
              nodeId: childFrame.entryNodeId,
              startedAt: now
            }
          );
          const disposition: RecoveryDispositionRecord = Object.freeze({
            status: 'pending-dispatch-recovered',
            invocationId: childFrame.invocationId,
            nodeId: childFrame.entryNodeId,
            attemptId: latestParentAtt.attemptId,
            reconciledAt: now,
            reasonCode: 'foreach-child-admission-recovered'
          });
          const withDisposition = setRecoveryDisposition(
            { ...staging.current(), revision: run.revision },
            disposition
          );
          const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
            withDisposition,
            run.revision
          );
          const finalRun =
            written.outcome === 'written' ? written.run : written.current ?? withDisposition;
          return {
            runId: finalRun.connectedRunId,
            mutated: true,
            disposition,
            run: finalRun,
            projection: buildWorkflowRunControlProjection(finalRun)
          };
        }

        // Case C: Crash after child settlement, after slot commit, or before final export
        if (childFrame.status !== 'completed' && childFrame.status !== 'failed') continue;
        const staging = createStagingWriter(run);
        const feRes = await handleForEachChildSettlement({
          run: staging.current(),
          parentFrame,
          parentWorkflow: parentWf,
          parentNode,
          childFrame,
          childStatus: childFrame.status,
          childFailureCode: childFrame.failureCode,
          childFailureMessage: childFrame.failureMessage,
          completedAt: childFrame.completedAt ?? now,
          forEachExecutor: this.deps.forEachExecutor,
          workspaceRoot: this.deps.workspaceRoot
        });
        if (feRes.action === 'not-for-each' || feRes.action === 'canceled') continue;

        if (feRes.action === 'completed') {
          staging.set(feRes.nextRun);
          await completeComposableNodeAttempt(
            {
              connectedRuns: staging.writer,
              dispatchPhase: this.deps.dispatchPhase,
              ...(this.deps.controlAdmission !== undefined
                ? { controlAdmission: this.deps.controlAdmission }
                : {}),
              ...(this.deps.forEachExecutor !== undefined
                ? { forEachExecutor: this.deps.forEachExecutor }
                : {}),
              ...(this.deps.workspaceRoot !== undefined
                ? { workspaceRoot: this.deps.workspaceRoot }
                : {})
            },
            {
              run: staging.current(),
              invocationId: parentFrame.invocationId,
              nodeId: parentNode.nodeId,
              attemptIndex: feRes.parentAttempt.attemptIndex,
              status: 'completed',
              completedAt: now,
              declaredOutputs: feRes.declaredOutputs
            }
          );
        } else if (feRes.action === 'advance-item') {
          staging.set(feRes.nextRun);
          await dispatchComposableNode(
            {
              connectedRuns: staging.writer,
              dispatchPhase: this.deps.dispatchPhase,
              ...(this.deps.controlAdmission !== undefined
                ? { controlAdmission: this.deps.controlAdmission }
                : {}),
              ...(this.deps.forEachExecutor !== undefined
                ? { forEachExecutor: this.deps.forEachExecutor }
                : {}),
              ...(this.deps.workspaceRoot !== undefined
                ? { workspaceRoot: this.deps.workspaceRoot }
                : {})
            },
            {
              run: staging.current(),
              invocationId: feRes.childInvocationId,
              nodeId: feRes.childEntryNodeId,
              startedAt: now
            }
          );
        } else if (feRes.action === 'paused') {
          staging.set(feRes.nextRun);
        } else {
          staging.set(feRes.nextRun);
          await completeComposableNodeAttempt(
            {
              connectedRuns: staging.writer,
              dispatchPhase: this.deps.dispatchPhase,
              ...(this.deps.controlAdmission !== undefined
                ? { controlAdmission: this.deps.controlAdmission }
                : {}),
              ...(this.deps.forEachExecutor !== undefined
                ? { forEachExecutor: this.deps.forEachExecutor }
                : {}),
              ...(this.deps.workspaceRoot !== undefined
                ? { workspaceRoot: this.deps.workspaceRoot }
                : {})
            },
            {
              run: staging.current(),
              invocationId: parentFrame.invocationId,
              nodeId: parentNode.nodeId,
              attemptIndex: latestParentAtt.attemptIndex,
              status: 'failed',
              completedAt: now,
              failureCode: feRes.failureCode
            }
          );
        }

        const disposition: RecoveryDispositionRecord = Object.freeze({
          status: 'settled-from-evidence',
          invocationId: parentFrame.invocationId,
          nodeId: parentNode.nodeId,
          attemptId: latestParentAtt.attemptId,
          reconciledAt: now,
          reasonCode: 'foreach-post-item-reconciled'
        });
        const withDisposition = setRecoveryDisposition(
          { ...staging.current(), revision: run.revision },
          disposition
        );
        const written = await this.deps.connectedRuns.compareAndSetConnectedRun(
          withDisposition,
          run.revision
        );
        const finalRun =
          written.outcome === 'written' ? written.run : written.current ?? withDisposition;
        return {
          runId: finalRun.connectedRunId,
          mutated: true,
          disposition,
          run: finalRun,
          projection: buildWorkflowRunControlProjection(finalRun)
        };
      }
    }

    return {
      runId: run.connectedRunId,
      mutated: false,
      disposition: run.recoveryDisposition ?? null,
      run,
      projection: buildWorkflowRunControlProjection(run),
      ...(retainedUncertainPermits !== undefined
        ? { retainedUncertainPermits }
        : {})
    };
  }

  /**
   * Reconcile all persisted `ConnectedWorkflowRun` records on host startup.
   */
  public async reconcileAllRuns(now: number): Promise<readonly ReconcileConnectedRunResult[]> {
    const list = this.deps.connectedRuns.list?.() ?? [];
    const results: ReconcileConnectedRunResult[] = [];
    for (const run of list) {
      const reconciled = await this.reconcileRun(run.connectedRunId, now);
      if (reconciled !== undefined) {
        results.push(reconciled);
      }
    }
    return Object.freeze(results);
  }
}
