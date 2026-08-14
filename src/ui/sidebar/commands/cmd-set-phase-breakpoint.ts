import type { SetPhaseBreakpointCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult } from './handler-helpers';

// Feature 028 US2 — arm a one-shot future-phase breakpoint. The host controller
// re-validates the (runId, phaseId) tuple against the run's immutable pipeline
// snapshot, the phasesCompleted ledger, and the existing phaseOverrides /
// phaseBreakpoints lists before mutating `WorkflowRun.phaseBreakpoints`. The
// controller also emits the `phase-breakpoint-set` audit event — the router
// does not double-emit.
export const handler: CommandHandler<SetPhaseBreakpointCommand> = async (ctx, command) => {
  if (!ctx.deps.phaseOps?.setPhaseBreakpoint) {
    await ack(ctx, 'rejected', 'phase-ops-unavailable');
    return;
  }
  const result = await ctx.deps.phaseOps.setPhaseBreakpoint(
    command.payload.runId,
    command.payload.phaseId,
    command.payload.queueId
  );
  await ackGenericResult(ctx, result);
};
