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
import type { WorkflowNodeTerminalStatus } from '../../contracts/workflow-definitions';
import {
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
  buildWorkflowRunControlProjection,
  type WorkflowRunControlProjection
} from './workflow-control-projector';
import {
  collectSubtreeInvocationIds,
  isTerminalInvocationStatus
} from './workflow-control-transition-table';
import type { ConnectedRunWriter } from './workflow-launcher';

export interface DurableAttemptEvidenceResult {
  readonly completed: boolean;
  readonly status?: WorkflowNodeTerminalStatus;
  readonly declaredOutputs?: Readonly<Record<string, ResolvedPortValue>>;
  readonly verdict?: 'pass' | 'fail' | null;
  readonly failureCode?: string;
  readonly completedAt?: number;
}

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
  readonly checkDurableAttemptEvidence?: (
    run: ConnectedWorkflowRun,
    frame: WorkflowInvocationFrame,
    attempt: NodeAttemptRecord
  ) => Promise<DurableAttemptEvidenceResult> | DurableAttemptEvidenceResult;
  readonly releaseQueueLease?: (
    queueId: string,
    runId: string
  ) => Promise<void> | void;
}

export interface ReconcileConnectedRunResult {
  readonly runId: string;
  readonly mutated: boolean;
  readonly disposition: RecoveryDispositionRecord | null;
  readonly run: ConnectedWorkflowRun;
  readonly projection: WorkflowRunControlProjection;
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
      if (last !== undefined && last.status === 'in-flight' && last.nodeKind === 'phase') {
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

    // 1. Terminal runs: no-op, ensure lease is released.
    if (rootFrame !== undefined && isTerminalInvocationStatus(rootFrame.status)) {
      await this.deps.releaseQueueLease?.(queueId, run.connectedRunId);
      return {
        runId: run.connectedRunId,
        mutated: false,
        disposition: run.recoveryDisposition ?? null,
        run,
        projection: buildWorkflowRunControlProjection(run)
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
          if (last !== undefined && (last.status === 'in-flight' || last.status === 'paused')) {
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
        projection: buildWorkflowRunControlProjection(finalRun)
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
        nextRun = upsertInvocationFrame(nextRun, {
          ...waitingFrame,
          status: 'in-flight',
          pendingHandoff: null,
          boundInputs: Object.freeze({
            ...waitingFrame.boundInputs,
            ...acceptedEnvelope.inputsByPort
          })
        });
        staging.set(nextRun);

        await dispatchComposableNode(
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
        projection: buildWorkflowRunControlProjection(finalRun)
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
            dispatchPhase: this.deps.dispatchPhase
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
        projection: buildWorkflowRunControlProjection(finalRun)
      };
    }

    return {
      runId: run.connectedRunId,
      mutated: false,
      disposition: run.recoveryDisposition ?? null,
      run,
      projection: buildWorkflowRunControlProjection(run)
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
