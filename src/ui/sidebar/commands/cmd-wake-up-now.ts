import type { WakeUpNowCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

export const handler: CommandHandler<WakeUpNowCommand> = async (ctx) => {
  if (!ctx.deps.wakeUpNow) {
    await ack(ctx, 'rejected', 'wakeup-unavailable');
    return;
  }
  const result = await ctx.deps.wakeUpNow();
  await ack(
    ctx,
    result.outcome === 'failed' ? 'rejected' : 'accepted',
    result.outcome === 'failed' ? result.message : undefined,
    result
  );
  ctx.deps.onWakeUpNowComplete?.();
};
