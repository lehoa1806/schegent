import type { MoveTaskCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult, appendQueueAudit, requireOps } from './handler-helpers';

/**
 * Feature 092 (T029, US1, FR-017, FR-042) — move a pending Task to another
 * queue.
 *
 * A Task that is the child of a connected run is refused: its queue binding
 * belongs to the aggregate that enqueued it, and moving it would leave the
 * aggregate pointing at a Task executing on a queue it did not choose.
 */
export const handler: CommandHandler<MoveTaskCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  if (!ops.moveTask) {
    await ack(ctx, 'rejected', 'unsupported');
    return;
  }
  const taskId = command.payload?.taskId ?? '';
  const targetQueueId = command.payload?.targetQueueId ?? '';
  const result = await ops.moveTask(taskId, targetQueueId, command.payload?.position ?? null);
  await ackGenericResult(ctx, result);
  if (result.ok) {
    await appendQueueAudit(ctx, 'task-moved', {
      queueId: result.queueId ?? targetQueueId,
      taskId: result.taskId ?? taskId
    });
  }
};
