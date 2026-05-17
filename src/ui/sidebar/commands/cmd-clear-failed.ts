import type { ClearFailedCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, requireOps } from './handler-helpers';

export const handler: CommandHandler<ClearFailedCommand> = async (ctx) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  await ops.clearFailed();
  await ack(ctx, 'accepted');
};
