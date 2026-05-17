import type { OpenAuditLogCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<OpenAuditLogCommand> = async (ctx) => {
  await exec(ctx, 'schegent.showAuditLog');
  await ack(ctx, 'accepted');
};
