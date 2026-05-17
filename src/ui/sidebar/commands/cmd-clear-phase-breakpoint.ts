import type { ClearPhaseBreakpointCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult } from './handler-helpers';

// Feature 028 US2 — clear a previously-armed breakpoint. The controller emits
// the `phase-breakpoint-cleared { cause: 'operator' }` audit event.
export const handler: CommandHandler<ClearPhaseBreakpointCommand> = async (
  ctx,
  command
) => {
  if (!ctx.deps.phaseOps?.clearPhaseBreakpoint) {
    await ack(ctx, 'rejected', 'phase-ops-unavailable');
    return;
  }
  const result = await ctx.deps.phaseOps.clearPhaseBreakpoint(
    command.payload.runId,
    command.payload.phaseId
  );
  await ackGenericResult(ctx, result);
};
