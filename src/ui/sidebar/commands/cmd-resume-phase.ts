import type { ResumePhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<ResumePhaseCommand> = async (ctx) => {
  await exec(ctx, 'schegent.resumePhase');
  await ack(ctx, 'accepted');
};
