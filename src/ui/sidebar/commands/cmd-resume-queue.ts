import type { ResumeQueueCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ackGenericResult, appendQueueAudit, requireOps } from './handler-helpers';

export const handler: CommandHandler<ResumeQueueCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  const queueId = command.payload?.queueId;
  const result = await ops.setQueuePausedState(false, queueId, null, 'operator');
  await ackGenericResult(ctx, result);
  if (result.ok) {
    await appendQueueAudit(ctx, 'queue-resumed', {
      queueId: result.queueId ?? queueId ?? null,
      source: 'operator'
    });
  }
};
