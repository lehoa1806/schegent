import { failed } from '../../../contracts/command-outcome';
import { errorMessage } from '../../../lib/errors';
import type { SkipPhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import {
  ack,
  ackCommandOutcome,
  ackGenericResult,
  DISPATCH_FAILED_REASON
} from './handler-helpers';

export const handler: CommandHandler<SkipPhaseCommand> = async (ctx, command) => {
  if (!ctx.deps.phaseOps) {
    await ack(ctx, 'rejected', 'phase-ops-unavailable');
    return;
  }
  let result: { ok: boolean; reason?: string };
  try {
    result = await ctx.deps.phaseOps.skipPhase(
      command.payload.runId,
      command.payload.phaseId,
      command.payload.queueId
    );
  } catch (err) {
    // FR-R4-F20 — the webview reads this ACK now, so a throw is answered with a code like the
    // palette-routed lifecycle routes' (`execForOutcome`), not with the router's sanitized message.
    const message = ctx.deps.logger.sanitize(errorMessage(err));
    ctx.deps.logger.warn(`sidebar router: ${command.type} dispatch failed: ${message}`);
    await ackCommandOutcome(ctx, failed(DISPATCH_FAILED_REASON));
    return;
  }
  await ackGenericResult(ctx, result);
};
