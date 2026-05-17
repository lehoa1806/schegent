import type { RetryQueueItemCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ackMutationResult, requireOps } from './handler-helpers';

export const handler: CommandHandler<RetryQueueItemCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  const result = await ops.retry(command.payload.id);
  await ackMutationResult(ctx, result, 'retry');
};
