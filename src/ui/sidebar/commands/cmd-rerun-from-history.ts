import type { RerunFromHistoryCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

export const handler: CommandHandler<RerunFromHistoryCommand> = async (ctx, command) => {
  await exec(ctx, 'schegent.rerunFromHistory', {
    runId: command.payload.runId,
    ...(command.payload.force === true ? { force: true } : {})
  });
  await ack(ctx, 'accepted');
};
