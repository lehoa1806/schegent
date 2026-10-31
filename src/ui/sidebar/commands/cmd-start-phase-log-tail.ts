import type { StartPhaseLogTailCommand, StartPhaseLogTailResponse } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// Feature 020 T048 — start a phase-log tail session. Gated, not serialized
// (FR-R4-F05, FR-003): the registry appends a `phase-log-tail-started` audit row,
// so the router's trust and primary-host gates run first. The adapter validates the
// snapshot (task in-flight + active phase) and delegates to the registry,
// which owns cap-1, mechanism probe, and audit emission.
export const handler: CommandHandler<StartPhaseLogTailCommand> = async (ctx, command) => {
  if (!ctx.deps.phaseLogTailService) {
    const failure: StartPhaseLogTailResponse = {
      outcome: 'failure',
      reason: 'internal-error'
    };
    await ack(ctx, 'rejected', 'internal-error', failure);
    return;
  }
  const startReq = command.payload;
  let startResp: StartPhaseLogTailResponse;
  try {
    startResp = await ctx.deps.phaseLogTailService.start(startReq);
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: phase-log tail start failed: ${ctx.deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
    startResp = { outcome: 'failure', reason: 'internal-error' };
  }
  await ack(
    ctx,
    startResp.outcome === 'success' ? 'accepted' : 'rejected',
    startResp.outcome === 'success' ? undefined : startResp.reason,
    startResp
  );
};
