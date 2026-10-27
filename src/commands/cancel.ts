import type { SchegentWorkflowController } from '../controller/workflow-controller';
import { resolveSoleRun } from '../controller/sole-run-resolver';
import { isRunRaceRefusal, type WorkspaceStateStore } from '../state/workspace-state';
import { canceledRunPatch, LIVE_RUN_STATUSES } from '../state/workflow-run';
import type { QueueManager } from '../queue/queue-manager';
import { decideTaskTransition } from '../queue/task-transition-decision';
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
  // FR-R3-161 (FR-004, SC-001) — 2026-09-04. This guard read
  // `feature.status !== 'in-flight' && feature.status !== 'pending'` and
  // decided the cancellation edge on its own authority. It agreed with the
  // closed table exactly, which is precisely what made it worth removing: a
  // second site that reaches the same verdict by its own rule is how the two
  // come to disagree, and the disagreement is silent, because each side is
  // individually correct and they differ only on a status that reaches both.
  // FR-004 counts such a site even when it is right today. Consulting the
  // classifier and acting on its answer is not a second decision, however many
  // places do it; deciding without consulting it is, even once.
  //
  // Ownership holds by construction: the row was resolved by identity above,
  // and `queueIdForTask` below reads the queue off that same row, so there is
  // no addressed queue for it to mismatch (research F9, F18 — the same
  // argument that retires the `queue-mismatch` reason).
  //
  // The refusal keeps this route's own reason. `CancelResult.reason` is the
  // command's vocabulary, not the classifier's, and nothing operator-visible
  // changes here — the paused refusal stays as silent as it was, and is
  // reported in this feature's closure record rather than fixed.
  const admission = decideTaskTransition({
    operation: 'finish',
    currentStatus: feature.status,
    targetStatus: 'canceled',
    queueAlreadyHasDifferentInFlight: false
  });
  if (!admission.eligible) {
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
    await markCanceled(ctx.store, queueId, activeRun.id);
    const finished = await ctx.queue.finish(feature.id, 'canceled');
    // FR-R3-153 — `finish` refuses a transition outside the closed table by
    // returning `{ ok: false, reason }` rather than throwing, so the queue
    // row can fail to update with no exception raised. Report that instead
    // of the blanket success notification below.
    if (finished.ok === false) {
      ctx.logger.error(`cancel: queue.finish refused: ${finished.reason ?? 'unknown'}`);
      ctx.notifier.error('Schegent: cancel failed — the task could not be finalized.');
      return { ok: false, reason: finished.reason ?? 'unexpected-error' };
    }
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
  const finished = await ctx.queue.finish(feature.id, 'canceled');
  // FR-R3-153 — see the `runMatches` branch above: a refusal is a returned
  // value now, not a throw, and must not be reported as a success.
  if (finished.ok === false) {
    ctx.logger.error(`cancel: queue.finish refused: ${finished.reason ?? 'unknown'}`);
    ctx.notifier.error('Schegent: cancel failed — the task could not be finalized.');
    return { ok: false, reason: finished.reason ?? 'unexpected-error' };
  }
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
  await markCanceled(ctx.store, queueId, run.id);
  const finished = await ctx.queue.finish(run.featureId, 'canceled');
  // FR-R3-153 — see `cancelByTaskId` above: a refusal is a returned value
  // now, not a throw, and must not be reported as a success.
  if (finished.ok === false) {
    ctx.logger.error(`cancel: queue.finish refused: ${finished.reason ?? 'unknown'}`);
    ctx.notifier.error('Schegent: cancel failed — the task could not be finalized.');
    return { ok: false, reason: finished.reason ?? 'unexpected-error' };
  }
  // Feature 093 (T068b, FR-028) — same as the by-id path: the window keeps
  // primacy. Here it matters even when the resolver found a sole *running* Run,
  // because a paused sibling is still this window's work.
  ctx.notifier.info('Schegent: workflow canceled.');
  return { ok: true };
}

/**
 * FR-R4-F01 (FR-008) — cancel is a patch of the Run as it is inside the
 * `KEYS.run` chain: the status and the stamp, and both pause/retry pairs cleared,
 * so a pause or a retry countdown that landed after the caller's read cannot
 * survive on a canceled Run as the one-sided state `validateRunInvariants` forbids.
 * A Run that has already ended, or been replaced, refuses the update instead of
 * being overwritten as canceled. That refusal is not a failed cancel: the driver
 * `cancelActive` just aborted writes its own `canceled` transition, and it can
 * reach the chain first.
 */
async function markCanceled(
  store: WorkspaceStateStore,
  queueId: string,
  runId: string
): Promise<void> {
  try {
    await store.updateRun(
      queueId,
      {
        runId,
        allowedStatuses: LIVE_RUN_STATUSES,
        label: 'cancel',
        patch: () => canceledRunPatch(Date.now())
      },
      store.runCommitClaim(queueId)
    );
  } catch (error) {
    if (!isRunRaceRefusal(error)) throw error;
  }
}
