import type { ResumeCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<ResumeCommand> = async (ctx, cmd) => {
  if (cmd.payload?.prompt) {
    await exec(ctx, 'schegent.resume', cmd.payload.prompt);
  } else {
    await exec(ctx, 'schegent.resume');
  }
  await ack(ctx, 'accepted');
};
