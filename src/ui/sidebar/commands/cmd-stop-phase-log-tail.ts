import type { StopPhaseLogTailCommand, StopPhaseLogTailResponse } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// Feature 020 T048 — stop a phase-log tail session. Read-only by
// construction. The registry emits the `phase-log-tail-stopped` audit event.
export const handler: CommandHandler<StopPhaseLogTailCommand> = async (ctx, command) => {
  if (!ctx.deps.phaseLogTailService) {
    const failure: StopPhaseLogTailResponse = {
      outcome: 'failure',
      sessionId: command.payload.sessionId,
      reason: 'internal-error'
    };
    await ack(ctx, 'rejected', 'internal-error', failure);
    return;
  }
  const stopReq = command.payload;
  let stopResp: StopPhaseLogTailResponse;
  try {
    stopResp = await ctx.deps.phaseLogTailService.stop(stopReq);
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: phase-log tail stop failed: ${ctx.deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
    stopResp = {
      outcome: 'failure',
      sessionId: stopReq.sessionId,
      reason: 'internal-error'
    };
  }
  await ack(
    ctx,
    stopResp.outcome === 'success' ? 'accepted' : 'rejected',
    stopResp.outcome === 'success' ? undefined : stopResp.reason,
    stopResp
  );
};
