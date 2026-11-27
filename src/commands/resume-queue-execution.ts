import type { SchegentWorkflowController } from '../controller/workflow-controller';
import { errorMessage } from '../lib/errors';
import type { SanitizedLogger } from '../lib/logger';
import type { GuardedRunService } from '../services/guarded-run-service';
import { reactivateRecoveryPausedConnectedRunForTask } from '../services/workflow-execution/recovery-liveness-sync';
import { isTerminalRunStatus, type WorkflowRun } from '../state/workflow-run';
import type { WorkspaceStateStore } from '../state/workspace-state';

export interface ResumePausedQueueExecutionDeps {
  readonly store: Pick<WorkspaceStateStore, 'getQueue' | 'getRun'> &
    Partial<Pick<WorkspaceStateStore, 'getConnectedRuns' | 'compareAndSetConnectedRun'>>;
  readonly guardedRunService: Pick<GuardedRunService, 'applyStartQueueIntent'>;
  readonly controller: Pick<
    SchegentWorkflowController,
    'isDriving' | 'admitResume' | 'drainQueuedWork'
  >;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
}

export type ResumeQueueExecutionOutcome =
  | { readonly action: 'resumed-run' }
  | { readonly action: 'drained-pending' }
  | { readonly action: 'preserved-phase-pause' }
  | { readonly action: 'noop'; readonly reason: string };

function isPhaseLevelPause(run: WorkflowRun): boolean {
  return run.manualPauseCause !== null && run.manualPauseCause !== 'queue-paused-mid-run';
}

/**
 * BUG-001 (FR-019, SC-009) — one-click manual Resume follow-up shared by
 * `CMD_RESUME_QUEUE` and `schegent.resumeQueue`.
 *
 * Runs immediately after `QueueManager.setQueuePausedState(false, ...)` succeeds:
 *   1. If an occupant non-terminal Run is held by an explicit phase-level pause
 *      (`breakpoint-paused`, `verify-paused`, `operator-paused`, `spend-bound-reached`),
 *      preserve that pause without bypassing it.
 *   2. If an occupant non-terminal Run is resumable (paused due to queue close /
 *      mid-run pause, with no active retry or credit wait) and not currently driven:
 *      exit `idle-pending` via `applyStartQueueIntent(now)` when pending tasks sit
 *      behind it, then invoke `controller.admitResume(queueId, ...)`.
 *   3. Otherwise, if pending tasks wait on the queue, exit `idle-pending` via
 *      `applyStartQueueIntent(now)` and invoke `controller.drainQueuedWork(queueId)`
 *      through the single `AutoDrainCoordinator` gate (Hard Rules 32 & 33).
 *   4. Empty queues stay in `active-empty` without draining.
 */
export async function resumePausedQueueExecution(
  queueId: string,
  deps: ResumePausedQueueExecutionDeps,
  prompt?: string
): Promise<ResumeQueueExecutionOutcome> {
  try {
    const queue = deps.store.getQueue(queueId);
    if (queue.queueLifecycle === 'operator-paused') {
      return { action: 'noop', reason: 'still-paused' };
    }

    const run = deps.store.getRun(queueId);
    if (run !== null && !isTerminalRunStatus(run.status)) {
      if (isPhaseLevelPause(run)) {
        return { action: 'preserved-phase-pause' };
      }
      if (run.pendingRetryAt !== null || run.creditPause !== null) {
        return { action: 'noop', reason: 'run-awaiting-retry' };
      }
      if (deps.controller.isDriving(queueId)) {
        return { action: 'noop', reason: 'already-driving' };
      }
      if (queue.queueLifecycle === 'idle-pending') {
        const applied = await deps.guardedRunService.applyStartQueueIntent(
          { startMode: 'now', source: 'operator-restart' },
          { queueId }
        );
        if (applied.outcome !== 'applied') {
          return { action: 'noop', reason: applied.outcome };
        }
      }
      if (
        deps.store.getConnectedRuns !== undefined &&
        deps.store.compareAndSetConnectedRun !== undefined
      ) {
        await reactivateRecoveryPausedConnectedRunForTask({
          store: {
            getConnectedRuns: () => deps.store.getConnectedRuns!(),
            compareAndSetConnectedRun: (next, rev) =>
              deps.store.compareAndSetConnectedRun!(next, rev)
          },
          ledgerStoreOwner: deps.store,
          taskId: run.featureId,
          logger: deps.logger
        });
      }
      await deps.controller.admitResume(
        queueId,
        prompt !== undefined ? { customPrompt: prompt } : {}
      );
      return { action: 'resumed-run' };
    }

    const hasPending = queue.requests.some((request) => request.status === 'pending');
    if (!hasPending) {
      return { action: 'noop', reason: 'empty' };
    }

    if (queue.queueLifecycle === 'idle-pending') {
      const applied = await deps.guardedRunService.applyStartQueueIntent(
        { startMode: 'now', source: 'operator-restart' },
        { queueId }
      );
      if (applied.outcome !== 'applied') {
        return { action: 'noop', reason: applied.outcome };
      }
    }

    if (
      deps.store.getConnectedRuns !== undefined &&
      deps.store.compareAndSetConnectedRun !== undefined
    ) {
      const reactivationStore = {
        getConnectedRuns: () => deps.store.getConnectedRuns!(),
        compareAndSetConnectedRun: (
          next: Parameters<NonNullable<typeof deps.store.compareAndSetConnectedRun>>[0],
          rev: number
        ) => deps.store.compareAndSetConnectedRun!(next, rev)
      };
      for (const request of queue.requests) {
        if (request.status === 'pending') {
          await reactivateRecoveryPausedConnectedRunForTask({
            store: reactivationStore,
            ledgerStoreOwner: deps.store,
            taskId: request.id,
            logger: deps.logger
          });
        }
      }
    }

    await deps.controller.drainQueuedWork(queueId);
    return { action: 'drained-pending' };
  } catch (err) {
    deps.logger.warn(`resumePausedQueueExecution failed: ${errorMessage(err)}`);
    return { action: 'noop', reason: 'unexpected-error' };
  }
}

