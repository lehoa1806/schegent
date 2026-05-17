import type { ResetCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<ResetCommand> = async (ctx) => {
  await exec(ctx, 'schegent.reset');
  await ack(ctx, 'accepted');
};
