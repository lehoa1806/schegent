import type { PauseQueueCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ackGenericResult, appendQueueAudit, requireOps } from './handler-helpers';

export const handler: CommandHandler<PauseQueueCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  const reason = command.payload?.reason ?? null;
  const queueId = command.payload?.queueId;
  const result = await ops.setQueuePausedState(true, queueId, reason, 'operator');
  await ackGenericResult(ctx, result);
  if (result.ok) {
    await appendQueueAudit(ctx, 'queue-paused', {
      queueId: result.queueId ?? queueId ?? null,
      reason,
      source: 'operator'
    });
  }
};
