import type { RetryActiveRunCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<RetryActiveRunCommand> = async (ctx) => {
  await exec(ctx, 'schegent.retryActiveRun');
  await ack(ctx, 'accepted');
};
