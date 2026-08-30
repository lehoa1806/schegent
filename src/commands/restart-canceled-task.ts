import type { QueueManager } from '../queue/queue-manager';
import { withRefreshedLifecycle } from '../queue/queue-lifecycle-refresh';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { FeatureRequest } from '../queue/feature-request';
import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import { MAX_PENDING_TASKS_PER_QUEUE } from '../queue/feature-request';

export type RestartCanceledResult =
  | { ok: true; queueId: string }
  | { ok: false; reason: string };

/**
 * Feature 017 — BUG-001. Transition a `canceled` FeatureRequest back to
 * `pending`, and report the queue it landed on so the caller can ask that queue
 * to drain.
 *
 * This used to say the row would be picked up "by the queue dequeue pump on the
 * next tick". **There is no dequeue pump.** `AutoDrainCoordinator` is
 * edge-triggered — a drain happens only where some call site asks for one — and
 * the only periodic sweep in the subsystem, `QueueScheduleWatchdog.tick()`,
 * filters to queues with an elapsed `scheduledStartAt`, which an ordinary
 * restarted Task never has. So the restarted row sat `pending` with nothing to
 * start it. Returning `queueId` is what lets the registration in `ui-wiring`
 * supply the trigger, the same way `schegent.enqueue` already does for the same
 * state transition.
 *
 * Invariants:
 *  - Reject `not-found` when no FeatureRequest matches `taskId`.
 *  - Reject `illegal-state` when the matched task is not in `canceled`
 *    status (operator may have already retried via a different path).
 *  - Reject `task-cap-reached` when the target queue is already at the
 *    100-task pending cap (FR-029 ceiling).
 *  - Preserve `description`, `queueId`, `pipelineId`, `rerun`, and
 *    history-friendly fields. Reset run-scoped state (`runId`, errors,
 *    pause cause, timing) so the resurrected task starts fresh.
 *  - Append a `task-restarted-from-canceled` audit event with the
 *    resolved `{ taskId, queueId, previousRunId? }`. Routes through
 *    the existing `appendAudit()` sanitization point.
 */
export async function runRestartCanceledTask(ctx: {
  store: WorkspaceStateStore;
  queue: QueueManager;
  audit: AuditLogWriter;
  notifier: Notifier;
  logger: SanitizedLogger;
  taskId: string;
}): Promise<RestartCanceledResult> {
  try {
    const taskId = ctx.taskId?.trim() ?? '';
    if (taskId.length === 0) {
      return { ok: false, reason: 'invalid-taskId' };
    }
    const feature = ctx.queue.findById(taskId);
    if (!feature) {
      ctx.notifier.info('Schegent: cannot restart — task not found.');
      return { ok: false, reason: 'not-found' };
    }
    if (feature.status !== 'canceled') {
      return { ok: false, reason: 'illegal-state' };
    }

    const targetQueueId = feature.queueId ?? DEFAULT_QUEUE_ID;
    const now = Date.now();
    const previousRunId = feature.runId;
    // FR-R3-002 (T280) — surfaced by removing `updateQueue`'s default
    // parameter. This mutation already knew its queue (`targetQueueId`, used
    // just below for the per-queue pending cap) and still wrote to Default. For
    // a task on any other queue the read-back found no matching row, so the
    // restart returned `null` and reported `illegal-state` — a live task the
    // operator asked to restart, refused for a reason that was not true.
    const restarted = await ctx.store.updateQueue<FeatureRequest | null>((queue) => {
      const current = queue.requests.find((request) => request.id === taskId);
      if (!current || current.status !== 'canceled') return { queue, result: null };
      const pendingInTarget = queue.requests.filter(
        (request) =>
          (request.queueId ?? DEFAULT_QUEUE_ID) === targetQueueId &&
          request.status === 'pending'
      );
      if (pendingInTarget.length >= MAX_PENDING_TASKS_PER_QUEUE) {
        throw new Error('task-cap-reached');
      }
      const next: FeatureRequest = {
        ...current,
        status: 'pending',
        runId: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
        position: pendingInTarget.length,
        retryCount: current.retryCount + 1,
        lastError: null,
        pausedReason: null,
        pauseCause: null
      };
      const nextQueue = {
        ...queue,
        requests: queue.requests.map((request) =>
          request.id === taskId ? next : request
        )
      };
      return {
        // The queue just gained pending work, so its unheld lifecycle is
        // refreshed to match. A *held* queue (`operator-paused`,
        // `idle-pending`) comes back untouched, so a restart never releases a
        // hold the operator or a schedule put there — see
        // `queue-lifecycle-refresh.ts` for why that distinction is the whole
        // point of the helper.
        queue: withRefreshedLifecycle(nextQueue),
        result: next
      };
    }, targetQueueId, ctx.store.runCommitClaim(targetQueueId));
    if (!restarted) return { ok: false, reason: 'illegal-state' };

    await ctx.audit.append({
      runId: previousRunId ?? `task:${feature.id}`,
      phase: 'queue',
      iteration: 0,
      eventType: 'task-restarted-from-canceled',
      payload: {
        taskId: restarted.id,
        queueId: targetQueueId,
        previousRunId: previousRunId ?? null
      },
      outcome: 'info'
    });

    ctx.notifier.info('Schegent: task restarted.');
    return { ok: true, queueId: targetQueueId };
  } catch (err) {
    const message = (err as Error).message ?? 'unknown error';
    if (message === 'task-cap-reached') return { ok: false, reason: message };
    ctx.notifier.error(`Schegent: restart failed — ${message}`);
    ctx.logger.error(message);
    return { ok: false, reason: 'unexpected-error' };
  }
}
