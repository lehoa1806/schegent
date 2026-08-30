import type { RestartCanceledTaskCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ackGenericResult } from './handler-helpers';

// Feature 017 — BUG-001. Resurrect a canceled FeatureRequest back to pending.
// The host command is where the drain that starts it is triggered; there is no
// "dequeue pump" picking it up on a later tick, which is what this comment used
// to claim and what left the restarted Task sitting pending.
export const handler: CommandHandler<RestartCanceledTaskCommand> = async (
  ctx,
  command
) => {
  const result = (await Promise.resolve(
    ctx.deps.executeCommand('schegent.restartCanceledTask', {
      taskId: command.payload.taskId
    })
  )) as { ok: boolean; reason?: string } | undefined;
  await ackGenericResult(ctx, result ?? { ok: true });
};
