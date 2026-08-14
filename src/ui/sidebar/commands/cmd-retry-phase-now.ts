import type { RetryPhaseNowCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<RetryPhaseNowCommand> = async (ctx, cmd) => {
  await exec(ctx, 'schegent.retryPhaseNow', cmd.payload.queueId);
  await ack(ctx, 'accepted');
};
