import type { ResumeCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<ResumeCommand> = async (ctx) => {
  await exec(ctx, 'schegent.resume');
  await ack(ctx, 'accepted');
};
