import type { QueueManager, MutationResult } from '../queue/queue-manager';
import type { WorkspaceLockManager } from '../state/lock';
import type { Notifier } from '../ui/notifications';
import type { SanitizedLogger } from '../lib/logger';
import { errorMessage } from '../lib/errors';

export interface QueueOpsCtx {
  queue: QueueManager;
  lock: WorkspaceLockManager;
  notifier: Notifier;
  logger: SanitizedLogger;
}

const ILLEGAL_STATE_MESSAGES: Record<string, string> = {
  'illegal-state': 'Action not allowed in current state',
  'not-found': 'Queue item not found',
  'no-peer': 'No other pending items to reorder',
  'at-edge': 'Already at the edge of the pending list'
};

/**
 * FR-R3-024 (FR-013) — awaits the authoritative predicate. `isHeld()` reads the
 * `Memento` mirror and is advisory by `lock.ts`'s own split; every caller below
 * mutates the queue, so every caller below is making a decision. Fails closed
 * when the ownership record cannot be read, which is the posture the same
 * mutations already had coming from the sidebar.
 */
async function ensurePrimary(ctx: QueueOpsCtx): Promise<boolean> {
  if (await ctx.lock.hasPrimacy()) return true;
  ctx.notifier.warn('Schegent: another window holds the workspace lock; ignoring request.');
  return false;
}

function notifyMutationFailure(ctx: QueueOpsCtx, action: string, result: MutationResult): void {
  const reason = result.reason ?? 'illegal-state';
  const human = ILLEGAL_STATE_MESSAGES[reason] ?? `${action} failed`;
  ctx.notifier.warn(`Schegent: ${human}.`);
}

function expectId(input: unknown): string | null {
  if (typeof input === 'string' && input.length > 0) return input;
  if (input && typeof input === 'object' && 'id' in input) {
    const id = (input as { id: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

/**
 * Returning a Task to `pending` is not the same thing as asking the queue to
 * drain, and for the whole life of this command it only did the first —
 * `AutoDrainCoordinator` is edge-triggered, so the retried Task sat pending
 * until some unrelated event happened to trigger a drain. The caller now owns
 * that trigger, and needs two facts to fire it: whether the retry took, and
 * *which* queue to drain. Hence a result where there was none.
 *
 * `queueId` is resolved from the row rather than defaulted, because
 * `drainQueuedWork` must never sweep Default on behalf of a Task that lives
 * somewhere else (`tests/lint/no-implicit-default-queue.test.ts`).
 */
export type RetryQueuedItemResult =
  | { ok: true; queueId: string }
  | { ok: false; reason: string };

export async function runRetryQueuedItem(
  arg: unknown,
  ctx: QueueOpsCtx
): Promise<RetryQueuedItemResult> {
  if (!(await ensurePrimary(ctx))) return { ok: false, reason: 'not-primary' };
  const id = expectId(arg);
  if (!id) {
    ctx.notifier.warn('Schegent: retry requires a queue item id.');
    return { ok: false, reason: 'invalid-id' };
  }
  try {
    // Resolved before the mutation: `queueIdForTask` reads the row, and the row
    // is only guaranteed to be there while the Task still exists.
    const queueId = ctx.queue.queueIdForTask(id);
    const result = await ctx.queue.retry(id);
    if (!result.ok) {
      notifyMutationFailure(ctx, 'Retry', result);
      return { ok: false, reason: result.reason ?? 'illegal-state' };
    }
    return { ok: true, queueId };
  } catch (err) {
    ctx.logger.error(`runRetryQueuedItem failed: ${(err as Error).message}`);
    ctx.notifier.error(`Schegent: retry failed.`);
    return { ok: false, reason: 'unexpected-error' };
  }
}

/**
 * Feature 195 (T064, FR-025) — the third exit from a halted queue, as a host
 * command.
 *
 * Shaped like `runRetryQueuedItem` above, and for the same reason: the halt ends
 * only when the queue is offered a drain, and `AutoDrainCoordinator` is
 * edge-triggered, so the caller needs both whether the attestation took and
 * which queue to sweep. It writes nothing of its own — `QueueManager.attestCompleted`
 * is the single call site in the product capable of attesting (see its doc), and
 * a second status writer here is exactly what that design excludes.
 *
 * No consent check. The operator's assertion was made at the prompt and carried
 * on the wire as `confirmed: true`, which the ingress validator refuses without;
 * re-deciding it here would make two sites responsible for one question.
 */
export type AttestTaskCompletedResult =
  | { ok: true; queueId: string }
  | { ok: false; reason: string };

export async function runAttestTaskCompleted(
  arg: unknown,
  ctx: QueueOpsCtx
): Promise<AttestTaskCompletedResult> {
  if (!(await ensurePrimary(ctx))) return { ok: false, reason: 'not-primary' };
  const id = expectId(arg);
  if (!id) {
    ctx.notifier.warn('Schegent: marking a task completed requires a queue item id.');
    return { ok: false, reason: 'invalid-id' };
  }
  try {
    // Resolved before the mutation, as in `runRetryQueuedItem`: the row is only
    // guaranteed to be readable while the Task is still there.
    const queueId = ctx.queue.queueIdForTask(id);
    const result = await ctx.queue.attestCompleted(id);
    if (!result.ok) {
      notifyMutationFailure(ctx, 'Mark completed', result);
      return { ok: false, reason: result.reason ?? 'illegal-state' };
    }
    return { ok: true, queueId };
  } catch (err) {
    // `errorMessage` rather than the `Error` cast its seven neighbours use:
    // `catch` binds `unknown`, and FR-R3-110 holds that cast's baseline
    // shrink-only, so a new site takes the helper. (Spelling the cast out here
    // would itself count as a site — `no-new-error-cast.test.ts` counts the
    // literal, comments included.)
    ctx.logger.error(`runAttestTaskCompleted failed: ${errorMessage(err)}`);
    ctx.notifier.error(`Schegent: marking the task completed failed.`);
    return { ok: false, reason: 'unexpected-error' };
  }
}

export async function runMoveQueuedItemUp(arg: unknown, ctx: QueueOpsCtx): Promise<void> {
  if (!(await ensurePrimary(ctx))) return;
  const id = expectId(arg);
  if (!id) {
    ctx.notifier.warn('Schegent: move requires a queue item id.');
    return;
  }
  try {
    const result = await ctx.queue.moveUp(id);
    if (!result.ok) notifyMutationFailure(ctx, 'Move up', result);
  } catch (err) {
    ctx.logger.error(`runMoveQueuedItemUp failed: ${(err as Error).message}`);
    ctx.notifier.error(`Schegent: move up failed.`);
  }
}

export async function runMoveQueuedItemDown(arg: unknown, ctx: QueueOpsCtx): Promise<void> {
  if (!(await ensurePrimary(ctx))) return;
  const id = expectId(arg);
  if (!id) {
    ctx.notifier.warn('Schegent: move requires a queue item id.');
    return;
  }
  try {
    const result = await ctx.queue.moveDown(id);
    if (!result.ok) notifyMutationFailure(ctx, 'Move down', result);
  } catch (err) {
    ctx.logger.error(`runMoveQueuedItemDown failed: ${(err as Error).message}`);
    ctx.notifier.error(`Schegent: move down failed.`);
  }
}

export async function runClearCompleted(ctx: QueueOpsCtx): Promise<void> {
  if (!(await ensurePrimary(ctx))) return;
  try {
    const result = await ctx.queue.clearCompleted();
    // Code-review finding (iteration 4) — `ClearByStatusResult.ok` was
    // widened onto `clearCompleted` alongside the `unknown-queue-id` guard
    // (T1621), but this Command Palette route calls it with no `queueId`
    // (defaulting to `DEFAULT_QUEUE_ID`, D6) and kept reading only
    // `.removed`. Unreachable while the reserved default queue exists (it
    // cannot be deleted — `queue-control-ipc.ts`'s
    // `default-queue-undeletable` refusal), but a silent narrowing of a
    // widened contract back to its old shape is worth closing rather than
    // leaving for the day that stops being true.
    if (!result.ok) {
      ctx.notifier.error('Schegent: clear completed failed — the default queue was not found.');
    } else if (result.removed === 0) {
      ctx.notifier.info('Schegent: no completed items to clear.');
    } else {
      ctx.notifier.info(`Schegent: cleared ${result.removed} completed item(s).`);
    }
  } catch (err) {
    ctx.logger.error(`runClearCompleted failed: ${(err as Error).message}`);
    ctx.notifier.error(`Schegent: clear completed failed.`);
  }
}

export async function runClearFailed(ctx: QueueOpsCtx): Promise<void> {
  if (!(await ensurePrimary(ctx))) return;
  try {
    const result = await ctx.queue.clearFailed();
    // Code-review finding — see `runClearCompleted` above; the same
    // widened-but-unread `.ok` gap, on its sibling.
    if (!result.ok) {
      ctx.notifier.error('Schegent: clear failed failed — the default queue was not found.');
    } else if (result.removed === 0) {
      ctx.notifier.info('Schegent: no failed items to clear.');
    } else {
      ctx.notifier.info(`Schegent: cleared ${result.removed} failed item(s).`);
    }
  } catch (err) {
    ctx.logger.error(`runClearFailed failed: ${(err as Error).message}`);
    ctx.notifier.error(`Schegent: clear failed failed.`);
  }
}

export async function runPauseQueue(arg: unknown, ctx: QueueOpsCtx): Promise<void> {
  if (!(await ensurePrimary(ctx))) return;
  const reason =
    arg && typeof arg === 'object' && 'reason' in arg && typeof (arg as { reason: unknown }).reason === 'string'
      ? ((arg as { reason: string }).reason as string)
      : null;
  try {
    await ctx.queue.setQueuePausedState(true, undefined, reason, 'operator');
    ctx.notifier.info('Schegent: queue paused.');
  } catch (err) {
    ctx.logger.error(`runPauseQueue failed: ${(err as Error).message}`);
    ctx.notifier.error(`Schegent: pause queue failed.`);
  }
}

export async function runResumeQueue(ctx: QueueOpsCtx): Promise<void> {
  if (!(await ensurePrimary(ctx))) return;
  try {
    await ctx.queue.setQueuePausedState(false, undefined, null, 'operator');
    ctx.notifier.info('Schegent: queue resumed.');
  } catch (err) {
    ctx.logger.error(`runResumeQueue failed: ${(err as Error).message}`);
    ctx.notifier.error(`Schegent: resume queue failed.`);
  }
}
