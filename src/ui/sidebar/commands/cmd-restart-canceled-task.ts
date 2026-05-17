import type { RestartCanceledTaskCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ackGenericResult } from './handler-helpers';

// Feature 017 — BUG-001. Resurrect a canceled FeatureRequest back to pending
// so the dequeue pump picks it up on the next tick.
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
