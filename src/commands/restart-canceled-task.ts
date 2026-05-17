import type { QueueManager } from '../queue/queue-manager';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { FeatureRequest } from '../queue/feature-request';
import { DEFAULT_QUEUE_ID } from '../queue/queue-registry';
import { MAX_PENDING_TASKS_PER_QUEUE } from '../queue/feature-request';

export type RestartCanceledResult = { ok: true } | { ok: false; reason: string };

/**
 * Feature 017 — BUG-001. Transition a `canceled` FeatureRequest back to
 * `pending` so the queue dequeue pump picks it up on the next tick.
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

    const queue = ctx.store.getQueue();
    const targetQueueId = feature.queueId ?? DEFAULT_QUEUE_ID;
    const pendingInTarget = queue.requests.filter(
      (r) => (r.queueId ?? DEFAULT_QUEUE_ID) === targetQueueId && r.status === 'pending'
    );
    if (pendingInTarget.length >= MAX_PENDING_TASKS_PER_QUEUE) {
      return { ok: false, reason: 'task-cap-reached' };
    }

    const now = Date.now();
    const previousRunId = feature.runId;
    const restarted: FeatureRequest = {
      ...feature,
      status: 'pending',
      runId: null,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      position: pendingInTarget.length,
      retryCount: feature.retryCount + 1,
      lastError: null,
      pausedReason: null,
      pauseCause: null
    };
    const requests = queue.requests.map((r) => (r.id === taskId ? restarted : r));
    await ctx.store.setQueue({ ...queue, requests });

    await ctx.audit.append({
      runId: previousRunId ?? `task:${feature.id}`,
      phase: 'queue',
      iteration: 0,
      eventType: 'task-restarted-from-canceled',
      payload: {
        taskId: feature.id,
        queueId: targetQueueId,
        previousRunId: previousRunId ?? null
      },
      outcome: 'info'
    });

    ctx.notifier.info('Schegent: task restarted.');
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message ?? 'unknown error';
    ctx.notifier.error(`Schegent: restart failed — ${message}`);
    ctx.logger.error(message);
    return { ok: false, reason: 'unexpected-error' };
  }
}
