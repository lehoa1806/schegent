import type { RetryPhaseNowCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<RetryPhaseNowCommand> = async (ctx) => {
  await exec(ctx, 'schegent.retryPhaseNow');
  await ack(ctx, 'accepted');
};
