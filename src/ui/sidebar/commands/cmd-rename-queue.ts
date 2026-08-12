import type { RenameQueueCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult, appendQueueAudit, requireOps } from './handler-helpers';

/** Feature 092 (T029, US1, FR-013) — rename a queue. */
export const handler: CommandHandler<RenameQueueCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  if (!ops.renameQueue) {
    await ack(ctx, 'rejected', 'unsupported');
    return;
  }
  const queueId = command.payload?.queueId ?? '';
  const result = await ops.renameQueue(queueId, command.payload?.name ?? '');
  await ackGenericResult(ctx, result);
  if (result.ok) {
    // Ids only — the old and new names are operator-authored (FR-023a).
    await appendQueueAudit(ctx, 'queue-renamed', { queueId: result.queueId ?? queueId });
  }
};
