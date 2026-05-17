import type { SaveGeneralSettingsCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

export const handler: CommandHandler<SaveGeneralSettingsCommand> = async (ctx, command) => {
  if (!ctx.deps.writeGeneralSettings) {
    await ack(ctx, 'rejected', 'config-ops-unavailable');
    return;
  }
  const updates = command.payload.updates;
  const result = await ctx.deps.writeGeneralSettings(updates);
  if (result.ok) {
    await ack(ctx, 'accepted');
  } else {
    await ack(ctx, 'rejected', result.reason);
  }
};
