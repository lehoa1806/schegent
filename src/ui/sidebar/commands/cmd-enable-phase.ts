import type { EnablePhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult } from './handler-helpers';

export const handler: CommandHandler<EnablePhaseCommand> = async (ctx, command) => {
  if (!ctx.deps.phaseOps) {
    await ack(ctx, 'rejected', 'phase-ops-unavailable');
    return;
  }
  const result = await ctx.deps.phaseOps.enablePhase(command.payload.phaseId);
  await ackGenericResult(ctx, result);
};
