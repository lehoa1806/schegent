import type { PausePhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<PausePhaseCommand> = async (ctx, cmd) => {
  await exec(ctx, 'schegent.pausePhase', cmd.payload.queueId);
  await ack(ctx, 'accepted');
};
