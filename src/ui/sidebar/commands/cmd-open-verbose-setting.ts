import type { OpenVerboseSettingCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, exec } from './handler-helpers';

// Feature 020 — open the VS Code Settings editor scoped to
// `schegent.logging.verbose`. Read-only by construction; the operator still
// has to flip the toggle by hand.
export const handler: CommandHandler<OpenVerboseSettingCommand> = async (ctx) => {
  await exec(ctx, 'workbench.action.openSettings', '@id:schegent.logging.verbose');
  await ack(ctx, 'accepted');
};
