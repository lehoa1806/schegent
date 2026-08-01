import type { ResumePhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<ResumePhaseCommand> = async (ctx, cmd) => {
  if (cmd.payload?.prompt) {
    await exec(ctx, 'schegent.resumePhase', cmd.payload.prompt);
  } else {
    await exec(ctx, 'schegent.resumePhase');
  }
  await ack(ctx, 'accepted');
};
