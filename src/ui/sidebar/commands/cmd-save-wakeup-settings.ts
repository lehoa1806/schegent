import type { SaveWakeUpSettingsCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

export const handler: CommandHandler<SaveWakeUpSettingsCommand> = async (ctx, command) => {
  if (!ctx.deps.saveWakeUpSettings) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }
  const result = await ctx.deps.saveWakeUpSettings(command.payload);
  if (result.ok) {
    await ack(ctx, 'accepted');
  } else {
    await ack(ctx, 'rejected', result.reason);
  }
};
