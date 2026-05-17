import type { ClearCompletedCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, requireOps } from './handler-helpers';

export const handler: CommandHandler<ClearCompletedCommand> = async (ctx) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  await ops.clearCompleted();
  await ack(ctx, 'accepted');
};
