import type { ClearQueueScheduleCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult, appendQueueAudit, requireOps } from './handler-helpers';

/** Feature 092 (T029, US1, FR-018) — disarm a queue's scheduled start. */
export const handler: CommandHandler<ClearQueueScheduleCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  if (!ops.setQueueSchedule) {
    await ack(ctx, 'rejected', 'unsupported');
    return;
  }
  const queueId = command.payload?.queueId ?? '';
  const result = await ops.setQueueSchedule(queueId, null);
  await ackGenericResult(ctx, result);
  if (result.ok) {
    await appendQueueAudit(ctx, 'schedule-cleared', { queueId: result.queueId ?? queueId });
  }
};
