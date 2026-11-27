/**
 * FR-R8-01 (01-09) — Production wiring of `recordSpawnIntent` (immediately
 * before child CLI process spawn) and `recordAttemptStarted` (immediately after
 * spawn acknowledgement with child PID and `queueItemId`) for workflow-owned
 * Phase attempts.
 *
 * Zero `vscode` imports.
 */

import type { PhaseDef } from '../../config/pipeline-config';
import type { ExecutionFence } from '../../contracts/control-ledger';
import type { QueueManager } from '../../queue/queue-manager';
import { registerRunSpawnHooks } from '../../runner/spawn-env';
import type { WorkflowRun } from '../../state/workflow-run';
import type { WorkspaceStateStore } from '../../state/workspace-state';
import {
  getRegisteredProductionWorkflowComposition
} from './production-workflow-composition';

export class AttemptSpawnFenceError extends Error {
  public readonly code: string;
  public readonly postSpawn: boolean;

  public constructor(code: string, message: string, postSpawn = false) {
    super(message);
    this.name = 'AttemptSpawnFenceError';
    this.code = code;
    this.postSpawn = postSpawn;
  }
}

export interface AttemptSpawnCheckpointContext {
  readonly store: Pick<WorkspaceStateStore, 'getConnectedRun'> | object;
  readonly queue: Pick<QueueManager, 'findById'>;
  readonly run: Pick<WorkflowRun, 'id' | 'featureId'>;
  readonly activePhaseDef?: Pick<PhaseDef, 'sideEffects'> | undefined;
}

export function isAttemptSpawnFenceLoss(error: unknown): boolean {
  return error instanceof AttemptSpawnFenceError && error.code === 'stale-execution-fence';
}

export function handleAttemptSpawnFenceLoss(
  error: unknown,
  store: Partial<Pick<WorkspaceStateStore, 'markRunClaimLost'>>,
  queue: Pick<QueueManager, 'queueIdForTask'>,
  run: Pick<WorkflowRun, 'featureId'>,
  logger: { warn(msg: string): void }
): boolean {
  if (!isAttemptSpawnFenceLoss(error)) return false;
  const queueId = queue.queueIdForTask(run.featureId);
  store.markRunClaimLost?.(queueId, 'superseded');
  logger.warn(
    `run-driver: workflow spawn fence lost on queue '${queueId}'; abandoning local drive without mutating shared state`
  );
  return true;
}

export async function withAttemptSpawnCheckpoints<T>(
  ctx: AttemptSpawnCheckpointContext,
  fn: () => Promise<T>
): Promise<T> {
  const feature = ctx.queue.findById(ctx.run.featureId);
  const occurrence = feature?.workflowOccurrence;
  if (occurrence === undefined) {
    return fn();
  }
  const composition = getRegisteredProductionWorkflowComposition(ctx.store);
  if (composition === undefined) {
    throw new AttemptSpawnFenceError(
      'stale-execution-fence',
      'Production workflow composition is unregistered; refusing unfenced child spawn.'
    );
  }
  const connectedRun =
    'getConnectedRun' in ctx.store && typeof ctx.store.getConnectedRun === 'function'
      ? ctx.store.getConnectedRun(occurrence.rootRunId)
      : null;
  const ledgerRunId = connectedRun?.controlState?.ledgerRunId ?? occurrence.rootRunId;
  const checkLiveOrStale = async (
    fence: ExecutionFence,
    queueId: string,
    fallbackCode: string,
    fallbackMessage: string,
    postSpawn = false
  ): Promise<never> => {
    const liveOk = await composition.verifyLiveFence(fence, { rootRunId: ledgerRunId, queueId });
    if (!liveOk) {
      throw new AttemptSpawnFenceError(
        'stale-execution-fence',
        `Live execution fence lost while checking workflow attempt '${occurrence.attemptId}'.`,
        postSpawn
      );
    }
    throw new AttemptSpawnFenceError(fallbackCode, fallbackMessage, postSpawn);
  };

  const rootRecord = composition.ledgerStore.getRoot(ledgerRunId);
  if (rootRecord === null || rootRecord.connectedRunId !== occurrence.rootRunId) {
    const canCommit =
      'canCommitConnectedRun' in ctx.store && typeof ctx.store.canCommitConnectedRun === 'function'
        ? await (ctx.store as Pick<WorkspaceStateStore, 'canCommitConnectedRun'>).canCommitConnectedRun()
        : true;
    throw new AttemptSpawnFenceError(
      canCommit ? 'control-root-not-found' : 'stale-execution-fence',
      canCommit
        ? `Control root '${ledgerRunId}' is missing or unbound before process spawn.`
        : `Workspace primacy lost before spawning workflow attempt '${occurrence.attemptId}'.`
    );
  }
  const initialLiveOk = await composition.verifyLiveFence(rootRecord.fence, {
    rootRunId: ledgerRunId,
    queueId: rootRecord.queueId
  });
  if (!initialLiveOk) {
    throw new AttemptSpawnFenceError(
      'stale-execution-fence',
      `Live execution fence failed verification before entering phase execution for '${occurrence.attemptId}'.`
    );
  }
  if (rootRecord.linkState !== 'active' || rootRecord.status !== 'in-flight') {
    throw new AttemptSpawnFenceError(
      'control-root-not-active',
      `Control root '${ledgerRunId}' is not active (${rootRecord.linkState}/${rootRecord.status}) before phase execution.`
    );
  }
  const initialAttempt = Object.hasOwn(rootRecord.attemptsById, occurrence.attemptId)
    ? rootRecord.attemptsById[occurrence.attemptId]
    : undefined;
  if (initialAttempt === undefined) {
    throw new AttemptSpawnFenceError(
      'attempt-not-found',
      `Control attempt '${occurrence.attemptId}' is missing before phase execution.`
    );
  }
  if (
    initialAttempt.stage !== 'pending-dispatch' &&
    initialAttempt.stage !== 'spawn-intent' &&
    initialAttempt.stage !== 'started'
  ) {
    throw new AttemptSpawnFenceError(
      'invalid-attempt-stage',
      `Control attempt '${occurrence.attemptId}' is in non-spawnable stage '${initialAttempt.stage}'.`
    );
  }

  const resolveCurrentFence = (): ExecutionFence => {
    const latestRoot = composition.ledgerStore.getRoot(ledgerRunId);
    if (latestRoot !== null && latestRoot.connectedRunId === occurrence.rootRunId) {
      return latestRoot.fence;
    }
    return rootRecord.fence;
  };
  const hasSideEffects = ctx.activePhaseDef?.sideEffects !== 'none';

  const unregister = registerRunSpawnHooks(ctx.run.id, {
    onBeforeSpawn: async (hookCtx) => {
      const latestRoot = composition.ledgerStore.getRoot(ledgerRunId);
      if (latestRoot === null || latestRoot.connectedRunId !== occurrence.rootRunId) {
        await checkLiveOrStale(
          rootRecord.fence,
          rootRecord.queueId,
          'control-root-not-found',
          `Control root '${ledgerRunId}' is missing or unbound before process spawn.`
        );
      }
      if (latestRoot!.linkState !== 'active' || latestRoot!.status !== 'in-flight') {
        await checkLiveOrStale(
          latestRoot!.fence,
          latestRoot!.queueId,
          'control-root-not-active',
          `Control root '${ledgerRunId}' is not active (${latestRoot!.linkState}/${latestRoot!.status}) before process spawn.`
        );
      }
      const attempt = Object.hasOwn(latestRoot!.attemptsById, occurrence.attemptId)
        ? latestRoot!.attemptsById[occurrence.attemptId]
        : undefined;
      if (attempt === undefined) {
        await checkLiveOrStale(
          latestRoot!.fence,
          latestRoot!.queueId,
          'attempt-not-found',
          `Control attempt '${occurrence.attemptId}' is missing before process spawn.`
        );
      }
      if (
        attempt!.stage !== 'pending-dispatch' &&
        attempt!.stage !== 'spawn-intent' &&
        attempt!.stage !== 'started'
      ) {
        await checkLiveOrStale(
          latestRoot!.fence,
          latestRoot!.queueId,
          'invalid-attempt-stage',
          `Control attempt '${occurrence.attemptId}' is in non-spawnable stage '${attempt!.stage}'.`
        );
      }
      // Helper invocations (compaction, native review) verify live execution fence without
      // advancing the main attempt from `pending-dispatch` to `spawn-intent`.
      if (hookCtx?.helperInvocation === true) {
        const helperLiveOk = await composition.verifyLiveFence(latestRoot!.fence, {
          rootRunId: ledgerRunId,
          queueId: latestRoot!.queueId
        });
        if (!helperLiveOk) {
          throw new AttemptSpawnFenceError(
            'stale-execution-fence',
            `Live execution fence failed verification before helper spawn for '${occurrence.attemptId}'.`
          );
        }
        return;
      }
      if (attempt!.stage === 'pending-dispatch') {
        const res = await composition.controlAdmission.recordSpawnIntent({
          ledgerRunId,
          attemptId: occurrence.attemptId,
          fence: resolveCurrentFence(),
          queueItemId: ctx.run.featureId,
          hasSideEffects
        });
        if (!res.ok) {
          if (res.code === 'stale-execution-fence') {
            throw new AttemptSpawnFenceError(res.code, res.message);
          }
          await checkLiveOrStale(latestRoot!.fence, latestRoot!.queueId, res.code, res.message);
        }
        return;
      }
      const liveOk = await composition.verifyLiveFence(latestRoot!.fence, {
        rootRunId: ledgerRunId,
        queueId: latestRoot!.queueId
      });
      if (!liveOk) {
        throw new AttemptSpawnFenceError(
          'stale-execution-fence',
          `Live execution fence failed verification before resumed turn spawn for '${occurrence.attemptId}'.`
        );
      }
    },
    onAfterSpawn: async (pid) => {
      const latestRoot = composition.ledgerStore.getRoot(ledgerRunId);
      if (latestRoot === null || latestRoot.connectedRunId !== occurrence.rootRunId) {
        await checkLiveOrStale(
          rootRecord.fence,
          rootRecord.queueId,
          'control-root-not-found',
          `Control root '${ledgerRunId}' disappeared before spawn acknowledgement.`,
          true
        );
      }
      if (latestRoot!.linkState !== 'active' || latestRoot!.status !== 'in-flight') {
        await checkLiveOrStale(
          latestRoot!.fence,
          latestRoot!.queueId,
          'control-root-not-active',
          `Control root '${ledgerRunId}' is not active (${latestRoot!.linkState}/${latestRoot!.status}) before spawn acknowledgement.`,
          true
        );
      }
      const attempt = Object.hasOwn(latestRoot!.attemptsById, occurrence.attemptId)
        ? latestRoot!.attemptsById[occurrence.attemptId]
        : undefined;
      if (attempt === undefined) {
        await checkLiveOrStale(
          latestRoot!.fence,
          latestRoot!.queueId,
          'attempt-not-found',
          `Control attempt '${occurrence.attemptId}' disappeared before spawn acknowledgement.`,
          true
        );
      }
      if (
        attempt!.stage !== 'pending-dispatch' &&
        attempt!.stage !== 'spawn-intent' &&
        attempt!.stage !== 'started'
      ) {
        await checkLiveOrStale(
          latestRoot!.fence,
          latestRoot!.queueId,
          'invalid-attempt-stage',
          `Control attempt '${occurrence.attemptId}' transitioned to '${attempt!.stage}' before spawn acknowledgement.`,
          true
        );
      }
      const res = await composition.controlAdmission.recordAttemptStarted({
        ledgerRunId,
        attemptId: occurrence.attemptId,
        fence: resolveCurrentFence(),
        queueItemId: ctx.run.featureId,
        ...(pid !== undefined ? { pid } : {})
      });
      if (!res.ok) {
        if (res.code === 'stale-execution-fence') {
          throw new AttemptSpawnFenceError(res.code, res.message, true);
        }
        await checkLiveOrStale(latestRoot!.fence, latestRoot!.queueId, res.code, res.message, true);
      }
    }
  });

  try {
    return await fn();
  } finally {
    unregister();
  }
}
