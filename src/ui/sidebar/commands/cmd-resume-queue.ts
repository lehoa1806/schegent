import type { ResumeQueueCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult, appendQueueAudit, requireOps } from './handler-helpers';

export const handler: CommandHandler<ResumeQueueCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  const queueId = command.payload?.queueId;
  if (ops.setQueuePausedState) {
    const result = await ops.setQueuePausedState(false, queueId, null);
    await ackGenericResult(ctx, result);
    if (result.ok) {
      await appendQueueAudit(ctx, 'queue-resumed', {
        queueId: result.queueId ?? queueId ?? null,
        source: 'operator'
      });
    }
    return;
  }
  await ops.setPaused(false, null);
  await ack(ctx, 'accepted');
};
