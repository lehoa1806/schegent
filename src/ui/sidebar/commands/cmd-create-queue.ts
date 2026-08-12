import type { CreateQueueCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, appendQueueAudit, requireOps } from './handler-helpers';

/**
 * Feature 092 (T029, US1, FR-012) — create a queue.
 *
 * The accepted ack carries the new `queueId` so the webview can select the
 * queue it just made without waiting for the next snapshot. The operator's
 * name never reaches the audit payload (FR-023a).
 */
export const handler: CommandHandler<CreateQueueCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  if (!ops.createQueue) {
    await ack(ctx, 'rejected', 'unsupported');
    return;
  }
  const result = await ops.createQueue(command.payload?.name ?? '');
  if (!result.ok) {
    await ack(ctx, 'rejected', result.reason ?? 'operation-rejected');
    return;
  }
  await ack(ctx, 'accepted', undefined, { queueId: result.queueId });
  await appendQueueAudit(ctx, 'queue-created', { queueId: result.queueId ?? null });
};
