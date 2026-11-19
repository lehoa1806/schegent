// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Nothing here executes at wiring time: `pauseQueuesAtLifecycleBoundary` is
// invoked from `stage2-teardown.ts` on shutdown and from `stage2-producers.ts`
// (inside `THE GATE`, behind `isWorkspaceTrusted()` and `lockResult.acquired`)
// once per primary activation.

import { errorMessage } from '../lib/errors';
import type { SanitizedLogger } from '../lib/logger';
import { isTerminalRequestStatus } from '../queue/feature-request';
import type { QueueManager } from '../queue/queue-manager';
import type { ScheduledStartCoordinator } from '../services/scheduled-start-coordinator';
import type { WorkspaceLockManager } from '../state/lock';
import { allowedSourceStatusesFor } from '../state/run-transition-decision';
import { isTerminalRunStatus, type WorkflowRun } from '../state/workflow-run';
import { isRunRaceRefusal, type WorkspaceStateStore } from '../state/workspace-state';

/** Persisted reason stamped on queues paused at a plugin lifecycle boundary (BUG-001). */
export const EXTENSION_CLOSED_PAUSE_REASON = 'extension-closed';

export interface PauseQueuesAtBoundaryDeps {
  readonly store: WorkspaceStateStore;
  readonly queue: Pick<QueueManager, 'pause' | 'setQueuePausedState'>;
  readonly lock: Pick<WorkspaceLockManager, 'hasPrimacy'>;
  readonly scheduledStartCoordinator?: Pick<ScheduledStartCoordinator, 'cancel'>;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
  readonly now?: () => number;
}

async function pauseNonTerminalRun(
  store: WorkspaceStateStore,
  queueId: string,
  run: WorkflowRun,
  now: number
): Promise<void> {
  if (isTerminalRunStatus(run.status)) return;
  try {
    await store.updateRun(
      queueId,
      {
        runId: run.id,
        allowedStatuses: allowedSourceStatusesFor('paused', 'operator'),
        label: 'queue-pause',
        patch: (current) => {
          if (
            current.status === 'paused' &&
            current.pendingRetryAt === null &&
            current.pendingRetryCause === null &&
            current.creditPause === null &&
            current.manualPauseAt !== null
          ) {
            return {};
          }
          return {
            status: 'paused',
            pendingRetryAt: null,
            pendingRetryCause: null,
            creditPause: null,
            failureCause: undefined,
            lastTransitionAt: now,
            ...(current.manualPauseAt === null
              ? { manualPauseAt: now, manualPauseCause: 'queue-paused-mid-run' as const }
              : {})
          };
        }
      },
      store.runCommitClaim(queueId)
    );
  } catch (err) {
    if (!isRunRaceRefusal(err)) throw err;
  }
}

async function pauseSingleQueueAtBoundary(
  queueId: string,
  deps: PauseQueuesAtBoundaryDeps,
  now: number
): Promise<void> {
  const initialQueue = deps.store.getQueue(queueId);
  const initialRun = deps.store.getRun(queueId);
  const inFlightRequests = initialQueue.requests.filter((r) => r.status === 'in-flight');
  const hasNonTerminalRequest = initialQueue.requests.some((r) => !isTerminalRequestStatus(r.status));
  const hasSchedule = initialQueue.scheduledStartAt !== null;
  const hasNonTerminalRun = initialRun !== null && !isTerminalRunStatus(initialRun.status);

  if (
    initialQueue.queueLifecycle === 'active-empty' &&
    initialQueue.inFlightId === null &&
    !hasNonTerminalRequest &&
    !hasSchedule &&
    !hasNonTerminalRun
  ) {
    return;
  }

  if (hasSchedule && deps.scheduledStartCoordinator) {
    try {
      await deps.scheduledStartCoordinator.cancel(queueId, 'pause-cancel');
    } catch (err) {
      deps.logger.warn(`lifecycle-boundary schedule cancel failed: ${errorMessage(err)}`);
    }
  }

  for (const request of inFlightRequests) {
    const pauseOutcome = await deps.queue.pause(
      request.id,
      request.pauseCause ?? 'manually-paused-task',
      false
    );
    if (!pauseOutcome.ok) {
      deps.logger.warn(
        `lifecycle-boundary task pause declined (${pauseOutcome.reason ?? 'unknown'})`
      );
    }
  }

  if (initialQueue.queueLifecycle === 'operator-paused') {
    const afterTaskPause = deps.store.getQueue(queueId);
    if (
      afterTaskPause.inFlightId !== null ||
      afterTaskPause.scheduledStartAt !== null ||
      afterTaskPause.scheduledStartSource !== null
    ) {
      await deps.store.updateQueue(
        (current) => ({
          queue: {
            ...current,
            inFlightId: null,
            scheduledStartAt: null,
            scheduledStartSource: null,
            updatedAt: now
          },
          result: undefined
        }),
        queueId,
        deps.store.runCommitClaim(queueId)
      );
    }
  } else {
    const result = await deps.queue.setQueuePausedState(
      true,
      queueId,
      EXTENSION_CLOSED_PAUSE_REASON,
      'operator'
    );
    if (!result.ok && result.reason !== 'already-paused') {
      deps.logger.warn(
        `lifecycle-boundary queue pause declined (${result.reason ?? 'unknown'})`
      );
    }
    if (deps.store.getQueue(queueId).inFlightId !== null) {
      await deps.store.updateQueue(
        (current) => ({
          queue: { ...current, inFlightId: null, updatedAt: now },
          result: undefined
        }),
        queueId,
        deps.store.runCommitClaim(queueId)
      );
    }
  }

  const latestRun = deps.store.getRun(queueId);
  if (latestRun !== null && !isTerminalRunStatus(latestRun.status)) {
    await pauseNonTerminalRun(deps.store, queueId, latestRun, now);
  }
}

/**
 * BUG-001 (FR-015, FR-016, FR-017) — persist a pause across every queue holding
 * non-terminal work, an active lifecycle, an armed schedule, or a non-terminal
 * WorkflowRun. Called during Stage 2 teardown (after backend teardown and before
 * lease/primacy release) and once per primary activation as crash-safe defense.
 *
 * Never throws: every error is logged and swallowed so teardown always reaches
 * transport flush, execution-lease release, and primacy-lock release.
 */
export async function pauseQueuesAtLifecycleBoundary(
  deps: PauseQueuesAtBoundaryDeps
): Promise<void> {
  let primary = false;
  try {
    primary = await deps.lock.hasPrimacy();
  } catch (err) {
    deps.logger.warn(`lifecycle-boundary primacy check failed: ${errorMessage(err)}`);
    return;
  }
  if (!primary) return;

  let queueIds: readonly string[];
  try {
    queueIds = deps.store.getQueueRegistry().entries.map((entry) => entry.id);
  } catch (err) {
    deps.logger.warn(`lifecycle-boundary registry read failed: ${errorMessage(err)}`);
    return;
  }

  const now = (deps.now ?? Date.now)();
  for (const queueId of queueIds) {
    try {
      await pauseSingleQueueAtBoundary(queueId, deps, now);
    } catch (err) {
      deps.logger.warn(`lifecycle-boundary pause failed: ${errorMessage(err)}`);
    }
  }
}

