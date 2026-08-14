import type { RestartPhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<RestartPhaseCommand> = async (ctx, cmd) => {
  await exec(ctx, 'schegent.restartPhase', cmd.payload.queueId);
  await ack(ctx, 'accepted');
};
