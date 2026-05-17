import type { PausePhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<PausePhaseCommand> = async (ctx) => {
  await exec(ctx, 'schegent.pausePhase');
  await ack(ctx, 'accepted');
};
