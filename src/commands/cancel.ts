import type { SchegentWorkflowController } from '../controller/workflow-controller';
import { resolveSoleRun } from '../controller/sole-run-resolver';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { QueueManager } from '../queue/queue-manager';
import type { AuditLogWriter } from '../audit/audit-log-writer';
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
 *  - In-flight task whose `runId` matches the Run on its own queue: aborts
 *    that queue's driver and finalizes both the run and the FeatureRequest.
 *  - In-flight task without a matching active run (e.g., a stale
 *    in-flight FeatureRequest after pause/resume drift): finalizes the
 *    FeatureRequest only; the controller is not signaled.
 *  - Pending task: transitions to `canceled` directly without touching
 *    the controller.
 *  - Unknown task or terminal task: returns `{ ok: false, reason }`.
 *
 * Feature 093 (T068b, FR-028) — no path here touches window primacy, and the
 * `WorkspaceLockManager` is no longer on this context at all. Both cancel paths
 * released it back when a Run's drive held it; 092 retired that wrapper, and
 * with two Runs in one window a cancel that released primacy would strand the
 * survivor in a window a rival could take over. Primacy is acquired at
 * activation and released at disposal. Dropping the dependency rather than
 * leaving it unread is the point: an unused lock handle on a command context is
 * how the release comes back.
 *
 * Emits a single sanitized `task-canceled` audit event carrying
 * `{ taskId, runId? }` per FR-035.
 */
export async function runCancel(ctx: {
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
  queue: QueueManager;
  audit: AuditLogWriter;
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

  // Feature 093 (T026) — pattern B. The header above already anticipated this:
  // the singular projection was what put action identity at risk once
  // `globalConcurrencyCap > 1`. The Task names its queue, so the read addresses
  // that queue and cannot return a sibling's Run.
  const queueId = ctx.queue.queueIdForTask(taskId);
  const activeRun = ctx.store.getRun(queueId);
  const runMatches =
    feature.status === 'in-flight' &&
    activeRun !== null &&
    activeRun.featureId === feature.id &&
    activeRun.status === 'running';

  if (runMatches && activeRun) {
    // Feature 093 (T042) — addressed: cancel this Task's queue, not every Run
    // the window is driving.
    ctx.controller.cancelActive(queueId);
    await ctx.audit.append({
      runId: activeRun.id,
      phase: activeRun.currentPhase,
      iteration: activeRun.currentIteration,
      eventType: 'task-canceled',
      payload: { taskId: feature.id, runId: activeRun.id, reason: 'user-cancel' },
      outcome: 'info'
    });
    await ctx.store.setRun(queueId, {
      ...activeRun,
      status: 'canceled',
      lastTransitionAt: Date.now()
    });
    await ctx.queue.finish(feature.id, 'canceled');
    // Feature 093 (T068b, FR-028) — cancelling one Task does not end the
    // window's primacy. See the header note.
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
  // Feature 093 (T038) — this is the palette fallback documented above: the
  // caller named no task, so the target has to be inferred. It is inferred only
  // when there is nothing to infer between. Canceling a Run the operator was not
  // looking at is unrecoverable, so several running Runs is a refusal that tells
  // them to name the task, not a coin flip.
  const target = resolveSoleRun(ctx.store.getRunMap(), (r) => r.status === 'running');
  if (!target.ok) {
    ctx.notifier.info(
      target.reason === 'ambiguous-run-target'
        ? 'Schegent: several runs are in flight; cancel a specific task instead.'
        : 'Schegent: no in-flight run to cancel.'
    );
    return { ok: false, reason: target.reason === 'ambiguous-run-target'
      ? 'ambiguous-run-target'
      : 'no-active-run' };
  }
  const { queueId, run } = target;
  // Feature 093 (T042) — `resolveControlTarget` already named the queue; cancel
  // that one.
  ctx.controller.cancelActive(queueId);
  await ctx.audit.append({
    runId: run.id,
    phase: run.currentPhase,
    iteration: run.currentIteration,
    eventType: 'task-canceled',
    payload: { taskId: run.featureId, runId: run.id, reason: 'user-cancel' },
    outcome: 'info'
  });
  await ctx.store.setRun(queueId, { ...run, status: 'canceled', lastTransitionAt: Date.now() });
  await ctx.queue.finish(run.featureId, 'canceled');
  // Feature 093 (T068b, FR-028) — same as the by-id path: the window keeps
  // primacy. Here it matters even when the resolver found a sole *running* Run,
  // because a paused sibling is still this window's work.
  ctx.notifier.info('Schegent: workflow canceled.');
  return { ok: true };
}
