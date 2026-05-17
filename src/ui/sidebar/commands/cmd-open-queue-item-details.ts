import type { OpenQueueItemDetailsCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<OpenQueueItemDetailsCommand> = async (
  ctx,
  command
) => {
  await exec(ctx, 'schegent.showActiveRun', { id: command.payload.id, source: 'queue' });
  await ack(ctx, 'accepted');
};
