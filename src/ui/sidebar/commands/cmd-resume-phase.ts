import type { ResumePhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<ResumePhaseCommand> = async (ctx, cmd) => {
  // The prompt stays positional and optional; the queue is always sent, so a
  // resume with no operator prompt still says which Run it resumes.
  await exec(ctx, 'schegent.resumePhase', cmd.payload.prompt, cmd.payload.queueId);
  await ack(ctx, 'accepted');
};
