import type { ModifyTaskCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult, appendQueueAudit, requireOps } from './handler-helpers';

export const handler: CommandHandler<ModifyTaskCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  if (!ops.modifyTask) {
    await ack(ctx, 'rejected', 'queue-ops-unavailable');
    return;
  }
  const result = await ops.modifyTask(command.payload.taskId, command.payload.description);
  await ackGenericResult(ctx, result);
  if (result.ok) {
    await appendQueueAudit(ctx, 'task-modified', {
      taskId: command.payload.taskId,
      queueId: result.queueId ?? null
    });
  }
};
