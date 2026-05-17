import type { RemoveQueueItemCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, appendQueueAudit, handleIllegalState } from './handler-helpers';
import { ILLEGAL_STATE_MESSAGES } from './constants';

// BUG-002 (T116) — prefer the audit-aware ops surface so we can
// (a) attribute the originating queue in the `task-removed` audit payload, and
// (b) differentiate `unknown-task-id` from `task-not-in-pending-state` in the
// rejection reason. Fall back to the boolean `queueRemover.remove(...)` only
// when the host wasn't wired with a typed QueueOps surface.
export const handler: CommandHandler<RemoveQueueItemCommand> = async (ctx, command) => {
  const ops = ctx.deps.queueOps;
  const taskDelete =
    ctx.deps.phaseOps?.deleteTask?.bind(ctx.deps.phaseOps) ?? ops?.removeTask?.bind(ops);
  if (taskDelete) {
    const result = await taskDelete(command.payload.id);
    if (result.ok) {
      await ack(ctx, 'accepted');
      await appendQueueAudit(ctx, 'task-removed', {
        taskId: result.taskId ?? command.payload.id,
        queueId: result.queueId ?? null,
        priorStatus: result.priorStatus ?? null,
        runId: result.runId ?? null,
        cause: 'operator',
        sessionCleaned: result.sessionCleaned ?? false
      });
    } else {
      const reason = result.reason ?? 'not-found';
      const human =
        ILLEGAL_STATE_MESSAGES[reason] ?? `Cannot remove queue item: ${reason}`;
      await handleIllegalState(ctx, reason, human);
    }
    return;
  }
  const removed = await ctx.deps.queueRemover.remove(command.payload.id);
  if (removed) {
    await ack(ctx, 'accepted');
    await appendQueueAudit(ctx, 'task-removed', {
      taskId: command.payload.id,
      queueId: null,
      priorStatus: null,
      cause: 'operator',
      sessionCleaned: false
    });
  } else {
    await handleIllegalState(
      ctx,
      'not-found',
      `Cannot remove queue item: not found or no longer pending`
    );
  }
};
