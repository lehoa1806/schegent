import type { PauseQueueCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult, appendQueueAudit, requireOps } from './handler-helpers';

export const handler: CommandHandler<PauseQueueCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  const reason = command.payload?.reason ?? null;
  const queueId = command.payload?.queueId;
  if (ops.setQueuePausedState) {
    const result = await ops.setQueuePausedState(true, queueId, reason);
    await ackGenericResult(ctx, result);
    if (result.ok) {
      // Feature 028 — `source: 'operator'` distinguishes operator-driven pauses
      // from the cascade-source pauses emitted by the controller.
      await appendQueueAudit(ctx, 'queue-paused', {
        queueId: result.queueId ?? queueId ?? null,
        reason,
        source: 'operator'
      });
    }
    return;
  }
  await ops.setPaused(true, reason);
  await ack(ctx, 'accepted');
};
