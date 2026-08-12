import type { SaveQueueSettingsCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult, appendQueueAudit, requireOps } from './handler-helpers';

/**
 * Feature 092 (T029, US1, FR-018) — workspace-level queue settings.
 *
 * The concurrency-cap bound is validated behind the port, alongside the
 * package contribution and the host settings validator; this handler makes no
 * judgement about the value it forwards.
 */
export const handler: CommandHandler<SaveQueueSettingsCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  if (!ops.saveQueueSettings) {
    await ack(ctx, 'rejected', 'unsupported');
    return;
  }
  const result = await ops.saveQueueSettings({
    globalConcurrencyCap: command.payload?.globalConcurrencyCap,
    defaultQueueId: command.payload?.defaultQueueId
  });
  await ackGenericResult(ctx, result);
  if (result.ok) {
    await appendQueueAudit(ctx, 'queue-settings-saved', {
      queueId: result.queueId ?? command.payload?.defaultQueueId ?? null,
      globalConcurrencyCap: command.payload?.globalConcurrencyCap
    });
  }
};
