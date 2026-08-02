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

    const targetQueueId = feature.queueId ?? DEFAULT_QUEUE_ID;
    const now = Date.now();
    const previousRunId = feature.runId;
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
      return {
        queue: {
          ...queue,
          requests: queue.requests.map((request) =>
            request.id === taskId ? next : request
          )
        },
        result: next
      };
    });
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
    return { ok: true };
  } catch (err) {
    const message = (err as Error).message ?? 'unknown error';
    if (message === 'task-cap-reached') return { ok: false, reason: message };
    ctx.notifier.error(`Schegent: restart failed — ${message}`);
    ctx.logger.error(message);
    return { ok: false, reason: 'unexpected-error' };
  }
}
