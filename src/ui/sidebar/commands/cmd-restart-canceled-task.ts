import type { RestartCanceledTaskCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { execAndAck } from './handler-helpers';

// Feature 017 — BUG-001. Resurrect a canceled FeatureRequest back to pending.
// The host command is where the drain that starts it is triggered; there is no
// "dequeue pump" picking it up on a later tick, which is what this comment used
// to claim and what left the restarted Task sitting pending.
export const handler: CommandHandler<RestartCanceledTaskCommand> = async (
  ctx,
  command
) => {
  await execAndAck(ctx, 'schegent.restartCanceledTask', {
    taskId: command.payload.taskId
  });
};
