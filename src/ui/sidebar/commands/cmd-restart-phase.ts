import type { RestartPhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<RestartPhaseCommand> = async (ctx) => {
  await exec(ctx, 'schegent.restartPhase');
  await ack(ctx, 'accepted');
};
