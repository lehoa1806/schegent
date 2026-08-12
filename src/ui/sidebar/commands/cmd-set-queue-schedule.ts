import type { SetQueueScheduleCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult, appendQueueAudit, requireOps } from './handler-helpers';

/**
 * Feature 092 (T029, US1, FR-018) — arm a queue's scheduled start.
 *
 * The payload carries the operator's raw expression; the grammar lives in
 * `parseSchedule()` behind the queue manager, so an unparseable expression
 * comes back as a refusal code rather than an exception.
 */
export const handler: CommandHandler<SetQueueScheduleCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  if (!ops.setQueueSchedule) {
    await ack(ctx, 'rejected', 'unsupported');
    return;
  }
  const queueId = command.payload?.queueId ?? '';
  const result = await ops.setQueueSchedule(queueId, command.payload?.expression ?? '');
  await ackGenericResult(ctx, result);
  if (result.ok) {
    await appendQueueAudit(ctx, 'schedule-set', { queueId: result.queueId ?? queueId });
  }
};
