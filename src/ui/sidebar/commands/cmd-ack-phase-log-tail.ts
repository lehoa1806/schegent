import type { AckPhaseLogTailCommand, AckPhaseLogTailResponse } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// FR-R6-F07 (FR-009) — a consumer's acknowledgement of live-log batches: the ready
// ack (batch 0), credit up to a batch, a resync after a gap, or a duplicate report.
// Gated like the start that opened the tail (FR-R4-F05, FR-003); it appends no
// audit row. An ack for a stale session is a no-op failure.
export const handler: CommandHandler<AckPhaseLogTailCommand> = async (ctx, command) => {
  const request = command.payload;
  const service = ctx.deps.phaseLogTailService;
  if (!service) {
    await ack(ctx, 'rejected', 'internal-error', { outcome: 'failure', sessionId: request.sessionId });
    return;
  }
  let response: AckPhaseLogTailResponse;
  try {
    response = await service.ack(request);
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: phase-log tail ack failed: ${ctx.deps.logger.sanitize(
        err instanceof Error ? err.message : 'unknown error'
      )}`
    );
    await ack(ctx, 'rejected', 'internal-error', { outcome: 'failure', sessionId: request.sessionId });
    return;
  }
  await ack(
    ctx,
    response.outcome === 'success' ? 'accepted' : 'rejected',
    response.outcome === 'success' ? undefined : response.reason,
    response
  );
};
