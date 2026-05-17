import type { SaveModelsCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

export const handler: CommandHandler<SaveModelsCommand> = async (ctx, command) => {
  if (!ctx.deps.updateConfig) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }
  await ctx.deps.updateConfig('models', command.payload.models);
  await ack(ctx, 'accepted');
};
