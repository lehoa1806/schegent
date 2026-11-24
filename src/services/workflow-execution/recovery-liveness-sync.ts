/**
 * BUG-001 (FR-008, FR-010, FR-011) — Recovery liveness probes and
 * `recovery-uncertain-effect` ConnectedWorkflowRun reactivation helpers.
 *
 * Shared by startup recovery (`run-safety-wiring.ts`), Queue Resume
 * (`resume-queue-execution.ts`), and Phase Resume (`phase-control-commands.ts`).
 *
 * Zero `vscode` imports (hard-rules.md rule 13).
 */

import {
  LIVE_PROCESS_STATE,
  type ProcessEvidencePort,
  type ProcessEvidenceProbeInput,
  type ProcessEvidenceSnapshot
} from '../../contracts/control-ledger';
import type { WorkflowNodeTerminalStatus } from '../../contracts/workflow-definitions';
import {
  assertConnectedRunInvariants,
  clearInvocationControlMarkers,
  recordNodeAttempt,
  resolveBoundQueueId,
  setRecoveryDisposition,
  upsertInvocationFrame,
  type ConnectedWorkflowRun,
  type NodeAttemptRecord,
  type WorkflowInvocationFrame,
  type WorkflowPauseCause
} from '../../state/connected-workflow-run';
import type { ConnectedRunWriteResult } from '../../state/workspace-state';
import { getRegisteredProductionWorkflowComposition } from './production-workflow-composition';

export interface RecoveryLivenessQueueRow {
  readonly id: string;
  readonly status: string;
  readonly workflowOccurrence?: { readonly attemptId: string } | undefined;
}

export interface RecoveryLivenessQueueState {
  readonly queueLifecycle?: string | undefined;
  readonly requests: readonly RecoveryLivenessQueueRow[];
}

export interface RecoveryLivenessRunEntry {
  readonly featureId: string;
  readonly status: string;
}

export interface RecoveryLivenessHistoryEntry {
  readonly featureId: string;
  readonly terminalStatus: string;
}

export interface RecoveryLivenessStore {
  getConnectedRuns(): Readonly<Record<string, ConnectedWorkflowRun>>;
  getRunMap(): Readonly<Record<string, RecoveryLivenessRunEntry | undefined>>;
  getQueueRegistry?(): { readonly entries: readonly { readonly id: string }[] };
  getQueue?(queueId: string): RecoveryLivenessQueueState;
}

export interface RecoveryLivenessHistoryStore {
  list(): readonly RecoveryLivenessHistoryEntry[];
}

export interface ConnectedRunReactivationStore {
  getConnectedRuns(): Readonly<Record<string, ConnectedWorkflowRun>>;
  compareAndSetConnectedRun(
    next: ConnectedWorkflowRun,
    expectedRevision: number
  ): Promise<ConnectedRunWriteResult>;
}

export type ConnectedRunReactivationResult =
  | {
      readonly outcome: 'reactivated';
      readonly runId: string;
      readonly invocationId: string;
      readonly nodeId: string;
      readonly attemptId: string;
    }
  | {
      readonly outcome: 'held-explicit-pause';
      readonly runId: string;
      readonly invocationId: string;
      readonly nodeId: string;
      readonly attemptId: string;
      readonly pauseCause: WorkflowPauseCause | null;
    }
  | { readonly outcome: 'not-matched' }
  | { readonly outcome: 'stale'; readonly runId: string };

function lookupOwn<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string
): T | undefined {
  if (record === undefined || !Object.hasOwn(record, key)) return undefined;
  return record[key];
}

function toTerminalNodeStatus(status: string): WorkflowNodeTerminalStatus | undefined {
  if (status === 'completed' || status === 'failed' || status === 'canceled') {
    return status;
  }
  return undefined;
}

function findDurableTerminalStatusForTask(
  store: Pick<RecoveryLivenessStore, 'getRunMap'>,
  historyStore: RecoveryLivenessHistoryStore | undefined,
  taskId: string
): WorkflowNodeTerminalStatus | undefined {
  for (const run of Object.values(store.getRunMap())) {
    if (run !== undefined && run.featureId === taskId) {
      const terminal = toTerminalNodeStatus(run.status);
      if (terminal !== undefined) return terminal;
    }
  }
  if (historyStore !== undefined) {
    for (const entry of historyStore.list()) {
      if (entry.featureId === taskId) {
        const terminal = toTerminalNodeStatus(entry.terminalStatus);
        if (terminal !== undefined) return terminal;
      }
    }
  }
  return undefined;
}

function hasStartedWorkflowRunForTask(
  store: Pick<RecoveryLivenessStore, 'getRunMap'>,
  historyStore: RecoveryLivenessHistoryStore | undefined,
  taskId: string
): boolean {
  for (const run of Object.values(store.getRunMap())) {
    if (run !== undefined && run.featureId === taskId) return true;
  }
  if (historyStore !== undefined) {
    for (const entry of historyStore.list()) {
      if (entry.featureId === taskId) return true;
    }
  }
  return false;
}

/**
 * FR-008 (`BUG-001`) — returns `false` when the bound queue is missing from the
 * queue registry OR any active leaf Phase attempt's backing queue task row
 * is missing or `canceled` with no durable completion/failure evidence (allowing
 * startup recovery to cancel the orphaned run).
 */
export function isQueueOrTaskLive(input: {
  readonly store: RecoveryLivenessStore;
  readonly historyStore?: RecoveryLivenessHistoryStore | undefined;
  readonly queueId: string;
  readonly rootRunId: string;
}): boolean {
  const { store, historyStore, queueId, rootRunId } = input;
  if (
    store.getQueueRegistry !== undefined &&
    !store.getQueueRegistry().entries.some((entry) => entry.id === queueId)
  ) {
    return false;
  }
  if (store.getQueue === undefined) return true;

  const wfRun = lookupOwn(store.getConnectedRuns(), rootRunId);
  if (wfRun?.invocations === undefined) return true;

  const requests = store.getQueue(queueId).requests;
  for (const frame of Object.values(wfRun.invocations)) {
    if (frame.status !== 'in-flight' && frame.status !== 'paused') continue;
    for (const attempts of Object.values(frame.attemptsByNodeId)) {
      const last = attempts.at(-1);
      if (
        last === undefined ||
        last.nodeKind !== 'phase' ||
        last.queueItemId === undefined ||
        (last.status !== 'in-flight' && last.status !== 'paused')
      ) {
        continue;
      }
      const matchedReq = requests.find((req) => req.id === last.queueItemId);
      if (matchedReq !== undefined && matchedReq.status !== 'canceled') {
        continue;
      }
      const durableTerminal = findDurableTerminalStatusForTask(
        store,
        historyStore,
        last.queueItemId
      );
      if (durableTerminal === 'completed' || durableTerminal === 'failed') {
        continue;
      }
      if (
        matchedReq === undefined &&
        hasStartedWorkflowRunForTask(store, historyStore, last.queueItemId)
      ) {
        continue;
      }
      return false;
    }
  }
  return true;
}

/**
 * FR-008 (`BUG-001`) — returns `true` iff `attempt.queueItemId` refers to a
 * queue task row still `pending` in `queueId` with zero started `WorkflowRun`
 * or history record (meaning zero agent side effects could have occurred).
 */
export function isAttemptPendingInQueue(input: {
  readonly store: RecoveryLivenessStore;
  readonly historyStore?: RecoveryLivenessHistoryStore | undefined;
  readonly queueId: string;
  readonly attempt: Pick<NodeAttemptRecord, 'queueItemId'>;
}): boolean {
  const { store, historyStore, queueId, attempt } = input;
  if (store.getQueue === undefined || attempt.queueItemId === undefined) {
    return false;
  }
  const req = store
    .getQueue(queueId)
    .requests.find((candidate) => candidate.id === attempt.queueItemId);
  if (req === undefined || req.status !== 'pending') {
    return false;
  }
  return !hasStartedWorkflowRunForTask(store, historyStore, attempt.queueItemId);
}

/**
 * FR-008 (`BUG-001`) — builds a store-backed `ProcessEvidencePort` so
 * `ControlAttemptAdmissionService.reconcileControlRoot` sees live queue items
 * and durable terminal outcomes during startup recovery.
 */
export function createStoreProcessEvidencePort(input: {
  readonly store: RecoveryLivenessStore;
  readonly historyStore?: RecoveryLivenessHistoryStore | undefined;
  readonly isProcessAlive?: ((pid: number) => boolean) | undefined;
}): ProcessEvidencePort {
  const { store, historyStore, isProcessAlive } = input;
  return {
    inspectAttempt(probe: ProcessEvidenceProbeInput): ProcessEvidenceSnapshot {
      const connectedRun = lookupOwn(store.getConnectedRuns(), probe.connectedRunId);
      const queueId =
        connectedRun !== undefined ? resolveBoundQueueId(connectedRun) : undefined;
      let queueItemId = probe.queueItemId;
      if (queueItemId === undefined && connectedRun?.invocations !== undefined) {
        const frame = lookupOwn(connectedRun.invocations, probe.invocationId);
        const attempts = lookupOwn(frame?.attemptsByNodeId, probe.nodeId);
        queueItemId = attempts?.find((a) => a.attemptId === probe.attemptId)?.queueItemId;
      }

      const requests =
        queueId !== undefined && store.getQueue !== undefined
          ? store.getQueue(queueId).requests
          : undefined;
      const matchedReq = requests?.find(
        (req) =>
          (queueItemId !== undefined && req.id === queueItemId) ||
          req.workflowOccurrence?.attemptId === probe.attemptId
      );
      const effectiveTaskId = queueItemId ?? matchedReq?.id;

      if (effectiveTaskId !== undefined) {
        const terminal = findDurableTerminalStatusForTask(store, historyStore, effectiveTaskId);
        if (terminal !== undefined) {
          return {
            processState: terminal === 'completed' ? 'exited-clean' : 'exited-failed',
            durableTerminalStatus: terminal,
            ...(requests !== undefined
              ? { queueItemPresent: matchedReq !== undefined && matchedReq.status !== 'canceled' }
              : {})
          };
        }
      }

      if (
        probe.pid !== undefined &&
        Number.isSafeInteger(probe.pid) &&
        probe.pid > 1 &&
        isProcessAlive !== undefined &&
        isProcessAlive(probe.pid)
      ) {
        return {
          processState: LIVE_PROCESS_STATE,
          ...(requests !== undefined
            ? { queueItemPresent: matchedReq !== undefined && matchedReq.status !== 'canceled' }
            : {})
        };
      }

      if (requests !== undefined) {
        const stillLivePreSpawnRow =
          matchedReq !== undefined &&
          (matchedReq.status === 'paused' ||
            (matchedReq.status === 'pending' &&
              (effectiveTaskId === undefined ||
                !hasStartedWorkflowRunForTask(store, historyStore, effectiveTaskId))));
        return {
          processState: 'not-found',
          queueItemPresent: stillLivePreSpawnRow
        };
      }
      return { processState: 'not-found' };
    }
  };
}

function collectFrameChain(
  run: ConnectedWorkflowRun,
  leafFrame: WorkflowInvocationFrame
): readonly WorkflowInvocationFrame[] {
  const invocations = run.invocations ?? {};
  const chain: WorkflowInvocationFrame[] = [leafFrame];
  const seen = new Set<string>([leafFrame.invocationId]);
  let cursor = leafFrame.parentInvocationId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = lookupOwn(invocations, cursor);
    if (parent === undefined) break;
    chain.push(parent);
    cursor = parent.parentInvocationId;
  }
  return chain;
}

const MAX_REACTIVATION_CAS_RETRIES = 3;

/**
 * FR-010 / FR-011 (`BUG-001`) — atomically reactivates a `ConnectedWorkflowRun`
 * invocation chain and active leaf attempt from `paused` back to `in-flight`
 * ONLY when every paused frame in the chain carries
 * `manualPauseCause === 'recovery-uncertain-effect'`.
 *
 * Explicit pauses (`operator-pause`, `spend-bound-exceeded`, `credit-exhausted`)
 * are never bypassed and are reported via `{ outcome: 'held-explicit-pause' }`.
 * Honors Hard Rule 28 paired pause/retry marker invariants via
 * `clearInvocationControlMarkers`.
 */
export async function reactivateRecoveryPausedConnectedRunForTask(input: {
  readonly store: ConnectedRunReactivationStore;
  readonly ledgerStoreOwner?: object | undefined;
  readonly taskId: string;
  readonly logger?: { readonly warn?: (msg: string) => void } | undefined;
}): Promise<ConnectedRunReactivationResult> {
  const { store, taskId } = input;
  let lastStaleRunId: string | undefined;

  for (let casTry = 0; casTry < MAX_REACTIVATION_CAS_RETRIES; casTry += 1) {
    let matched:
      | {
          readonly run: ConnectedWorkflowRun;
          readonly frame: WorkflowInvocationFrame;
          readonly attempt: NodeAttemptRecord;
        }
      | undefined;

    for (const candidateRun of Object.values(store.getConnectedRuns())) {
      if (candidateRun.invocations === undefined) continue;
      for (const frame of Object.values(candidateRun.invocations)) {
        for (const attempts of Object.values(frame.attemptsByNodeId)) {
          const found = attempts.find(
            (attempt) =>
              attempt.queueItemId === taskId &&
              (attempt.status === 'paused' || attempt.status === 'in-flight')
          );
          if (found !== undefined) {
            matched = { run: candidateRun, frame, attempt: found };
            break;
          }
        }
        if (matched !== undefined) break;
      }
      if (matched !== undefined) break;
    }

    if (matched === undefined) {
      return { outcome: 'not-matched' };
    }

    const { run, frame, attempt } = matched;
    const chain = collectFrameChain(run, frame);
    const anyPausedFrame = chain.some((f) => f.status === 'paused');
    if (!anyPausedFrame && attempt.status !== 'paused') {
      return { outcome: 'not-matched' };
    }

    for (const candidateFrame of chain) {
      const cause = candidateFrame.controlMarkers?.manualPauseCause ?? null;
      if (candidateFrame.status === 'paused' && cause !== 'recovery-uncertain-effect') {
        return {
          outcome: 'held-explicit-pause',
          runId: run.connectedRunId,
          invocationId: frame.invocationId,
          nodeId: attempt.nodeId,
          attemptId: attempt.attemptId,
          pauseCause: cause
        };
      }
      if (cause !== null && cause !== 'recovery-uncertain-effect') {
        return {
          outcome: 'held-explicit-pause',
          runId: run.connectedRunId,
          invocationId: frame.invocationId,
          nodeId: attempt.nodeId,
          attemptId: attempt.attemptId,
          pauseCause: cause
        };
      }
    }

    if (!anyPausedFrame && attempt.status === 'paused') {
      return {
        outcome: 'held-explicit-pause',
        runId: run.connectedRunId,
        invocationId: frame.invocationId,
        nodeId: attempt.nodeId,
        attemptId: attempt.attemptId,
        pauseCause: frame.controlMarkers?.manualPauseCause ?? null
      };
    }

    const { completedAt: _removedCompletedAt, ...attemptWithoutCompletedAt } = attempt;
    const reactivatedAttempt: NodeAttemptRecord = Object.freeze({
      ...attemptWithoutCompletedAt,
      status: 'in-flight'
    });
    const reactivatedLeafFrame: WorkflowInvocationFrame = {
      ...recordNodeAttempt(frame, reactivatedAttempt),
      status: 'in-flight',
      controlMarkers: clearInvocationControlMarkers(frame.controlMarkers)
    };

    let nextRun = upsertInvocationFrame(run, reactivatedLeafFrame);
    for (const anc of chain.slice(1)) {
      if (anc.status !== 'paused') continue;
      nextRun = upsertInvocationFrame(nextRun, {
        ...anc,
        status: 'in-flight',
        controlMarkers: clearInvocationControlMarkers(anc.controlMarkers)
      });
    }

    const finalNext: ConnectedWorkflowRun =
      nextRun.recoveryDisposition?.status === 'uncertain-effect-paused'
        ? setRecoveryDisposition({ ...nextRun, revision: run.revision }, null)
        : Object.freeze({ ...nextRun, revision: run.revision + 1 });
    assertConnectedRunInvariants(finalNext);

    const written = await store.compareAndSetConnectedRun(finalNext, run.revision);
    if (written.outcome === 'written') {
      const composition = getRegisteredProductionWorkflowComposition(
        input.ledgerStoreOwner ?? store
      );
      if (composition !== undefined) {
        const ledgerRunId = run.controlState?.ledgerRunId ?? run.connectedRunId;
        const root = composition.ledgerStore.getRoot(ledgerRunId);
        if (
          root !== null &&
          root.connectedRunId === run.connectedRunId &&
          root.linkState === 'active' &&
          root.status === 'paused' &&
          root.pauseCause === 'recovery-uncertain-effect' &&
          (await composition.verifyLiveFence(root.fence, {
            rootRunId: ledgerRunId,
            queueId: root.queueId
          }))
        ) {
          await composition.ledgerStore.mutate(
            { targetRootId: ledgerRunId, expectedFence: root.fence, allowSettlementReserve: true },
            ({ ledger }) => {
              const liveRoot = lookupOwn(ledger.roots, ledgerRunId);
              if (
                liveRoot === undefined ||
                liveRoot.connectedRunId !== run.connectedRunId ||
                liveRoot.linkState !== 'active' ||
                liveRoot.status !== 'paused' ||
                liveRoot.pauseCause !== 'recovery-uncertain-effect'
              ) {
                return { commit: false, code: 'stale-ledger-revision', message: 'Root no longer recovery-paused.' };
              }
              const nextFrames = { ...liveRoot.framesByKey };
              for (const [k, f] of Object.entries(nextFrames)) {
                if (f.status === 'paused' && f.pauseCause === 'recovery-uncertain-effect') {
                  const { pauseCause: _clearedFrameCause, ...restFrame } = f;
                  nextFrames[k] = Object.freeze({ ...restFrame, status: 'in-flight', updatedAt: Date.now() });
                }
              }
              const { pauseCause: _clearedRootCause, ...restRoot } = liveRoot;
              const nextRoot = Object.freeze({
                ...restRoot,
                status: 'in-flight' as const,
                framesByKey: Object.freeze(nextFrames),
                updatedAt: Date.now()
              });
              return {
                commit: true,
                plan: {
                  nextLedger: { ...ledger, roots: { ...ledger.roots, [ledgerRunId]: nextRoot } },
                  targetRootId: ledgerRunId,
                  expectedFence: liveRoot.fence,
                  allowSettlementReserve: true,
                  result: true
                }
              };
            }
          );
        }
      }
      return {
        outcome: 'reactivated',
        runId: run.connectedRunId,
        invocationId: frame.invocationId,
        nodeId: attempt.nodeId,
        attemptId: attempt.attemptId
      };
    }
    lastStaleRunId = run.connectedRunId;
  }

  input.logger?.warn?.(
    `recovery-liveness-sync: CAS contention reactivating connected run '${lastStaleRunId ?? 'unknown'}' for task '${taskId}'.`
  );
  return { outcome: 'stale', runId: lastStaleRunId ?? '' };
}
