import type { StopPhaseLogTailCommand, StopPhaseLogTailResponse } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// Feature 020 T048 — stop a phase-log tail session. Gated, not serialized
// (FR-R4-F05, FR-003): the registry emits a `phase-log-tail-stopped` audit row, so
// a window that has lost primacy cannot stop its tail through this command. The
// tail still ends without it: when its task leaves in flight, when the next tail
// starts (one runs at a time), or at extension teardown
// (`activation/phase-log-tail-wiring.ts`). Closing the panel does not end it.
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
