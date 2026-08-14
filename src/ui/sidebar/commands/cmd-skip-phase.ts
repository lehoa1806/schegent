import type { SkipPhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult } from './handler-helpers';

export const handler: CommandHandler<SkipPhaseCommand> = async (ctx, command) => {
  if (!ctx.deps.phaseOps) {
    await ack(ctx, 'rejected', 'phase-ops-unavailable');
    return;
  }
  const result = await ctx.deps.phaseOps.skipPhase(command.payload.phaseId, command.payload.queueId);
  await ackGenericResult(ctx, result);
};
