import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { QueueManager } from '../queue/queue-manager';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { WorkspaceLockManager } from '../state/lock';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';

export type CancelResult = { ok: true } | { ok: false; reason: string };

/**
 * Feature 017 — BUG-001. Cancel a queued task by id.
 *
 * The host resolves the target by `FeatureRequest.id` instead of via the
 * singular `store.getRun()` projection so action identity is preserved
 * when `globalConcurrencyCap > 1` AND after a queue pause/resume swap.
 *
 * Behavior:
 *  - `taskId` is required when the call comes through the sidebar IPC
 *    boundary (validated by the runtime validator). When invoked from
 *    the VS Code command palette without an arg, falls back to the
 *    legacy "cancel the active singular run" path so the palette
 *    affordance keeps working.
 *  - In-flight task whose `runId` matches `store.getRun().id`: aborts
 *    the controller, finalizes both the run and the FeatureRequest, and
 *    releases the workspace lock.
 *  - In-flight task without a matching active run (e.g., a stale
 *    in-flight FeatureRequest after pause/resume drift): finalizes the
 *    FeatureRequest only; the controller is not signaled.
 *  - Pending task: transitions to `canceled` directly without touching
 *    the controller or the lock.
 *  - Unknown task or terminal task: returns `{ ok: false, reason }`.
 *
 * Emits a single sanitized `task-canceled` audit event carrying
 * `{ taskId, runId? }` per FR-035.
 */
export async function runCancel(ctx: {
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
  queue: QueueManager;
  audit: AuditLogWriter;
  lock: WorkspaceLockManager;
  notifier: Notifier;
  logger: SanitizedLogger;
  taskId?: string;
}): Promise<CancelResult> {
  try {
    const taskId = typeof ctx.taskId === 'string' ? ctx.taskId.trim() : '';
    if (taskId.length > 0) {
      return await cancelByTaskId(ctx, taskId);
    }
    return await cancelActiveRun(ctx);
  } catch (err) {
    const message = (err as Error).message ?? 'unknown error';
    ctx.notifier.error(`Schegent: cancel failed — ${message}`);
    ctx.logger.error(message);
    return { ok: false, reason: 'unexpected-error' };
  }
}

async function cancelByTaskId(
  ctx: Parameters<typeof runCancel>[0],
  taskId: string
): Promise<CancelResult> {
  const feature = ctx.queue.findById(taskId);
  if (!feature) {
    ctx.notifier.info('Schegent: cancel target not found.');
    return { ok: false, reason: 'not-found' };
  }
  if (feature.status !== 'in-flight' && feature.status !== 'pending') {
    return { ok: false, reason: 'illegal-state' };
  }

  const activeRun = ctx.store.getRun();
  const runMatches =
    feature.status === 'in-flight' &&
    activeRun !== null &&
    activeRun.featureId === feature.id &&
    activeRun.status === 'running';

  if (runMatches && activeRun) {
    ctx.controller.cancelActive();
    await ctx.audit.append({
      runId: activeRun.id,
      phase: activeRun.currentPhase,
      iteration: activeRun.currentIteration,
      eventType: 'task-canceled',
      payload: { taskId: feature.id, runId: activeRun.id, reason: 'user-cancel' },
      outcome: 'info'
    });
    await ctx.store.setRun({ ...activeRun, status: 'canceled', lastTransitionAt: Date.now() });
    await ctx.queue.finish(feature.id, 'canceled');
    await ctx.lock.release();
    ctx.notifier.info('Schegent: task canceled.');
    return { ok: true };
  }

  // Pending OR in-flight without a matching active run. The controller
  // is not signaled — we only finalize the FeatureRequest row.
  await ctx.audit.append({
    runId: feature.runId ?? `task:${feature.id}`,
    phase: 'queue',
    iteration: 0,
    eventType: 'task-canceled',
    payload: {
      taskId: feature.id,
      runId: feature.runId ?? null,
      reason: feature.status === 'pending' ? 'user-cancel-pending' : 'user-cancel-stale-in-flight'
    },
    outcome: 'info'
  });
  await ctx.queue.finish(feature.id, 'canceled');
  ctx.notifier.info('Schegent: task canceled.');
  return { ok: true };
}

async function cancelActiveRun(ctx: Parameters<typeof runCancel>[0]): Promise<CancelResult> {
  const run = ctx.store.getRun();
  if (!run || run.status !== 'running') {
    ctx.notifier.info('Schegent: no in-flight run to cancel.');
    return { ok: false, reason: 'no-active-run' };
  }
  ctx.controller.cancelActive();
  await ctx.audit.append({
    runId: run.id,
    phase: run.currentPhase,
    iteration: run.currentIteration,
    eventType: 'task-canceled',
    payload: { taskId: run.featureId, runId: run.id, reason: 'user-cancel' },
    outcome: 'info'
  });
  await ctx.store.setRun({ ...run, status: 'canceled', lastTransitionAt: Date.now() });
  await ctx.queue.finish(run.featureId, 'canceled');
  await ctx.lock.release();
  ctx.notifier.info('Schegent: workflow canceled.');
  return { ok: true };
}
