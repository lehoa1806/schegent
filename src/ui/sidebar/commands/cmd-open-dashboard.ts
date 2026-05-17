import type { OpenDashboardCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<OpenDashboardCommand> = async (ctx) => {
  await exec(ctx, 'schegent.openDashboard');
  await ack(ctx, 'accepted');
};
