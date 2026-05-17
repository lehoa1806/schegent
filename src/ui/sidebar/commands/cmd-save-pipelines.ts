import type { SavePipelinesCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

export const handler: CommandHandler<SavePipelinesCommand> = async (ctx, command) => {
  if (!ctx.deps.updateConfig) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }
  await ctx.deps.updateConfig('pipelines', command.payload.pipelines);
  await ack(ctx, 'accepted');
};
