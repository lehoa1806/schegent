import type { OpenHistoryItemDetailsCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<OpenHistoryItemDetailsCommand> = async (
  ctx,
  command
) => {
  await exec(ctx, 'schegent.showActiveRun', { id: command.payload.id, source: 'history' });
  await ack(ctx, 'accepted');
};
