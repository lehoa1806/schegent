import { historyErrorCode } from '../../../services/history/error-code';
import type {
  ReadExecutionVisibilityCommand,
  ReadExecutionVisibilityResponse
} from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// FR-R6-F12, F10, F13, F14, F15 — read-only execution visibility and runtime posture projections.
// Starts no process, writes no persisted state or file, and appends no audit row.

export const handler: CommandHandler<ReadExecutionVisibilityCommand> = async (ctx, command) => {
  const reader = ctx.deps.executionVisibility;
  if (!reader) {
    await ack(ctx, 'rejected', 'store-unavailable');
    return;
  }
  try {
    const payload = command.payload;
    const response: ReadExecutionVisibilityResponse =
      payload.op === 'attemptDetail'
        ? { op: 'attemptDetail', detail: reader.readAttemptVisibility(payload) }
        : { op: 'runtimePosture', posture: reader.readRuntimePosture() };
    await ack(ctx, 'accepted', undefined, response);
  } catch (err) {
    ctx.deps.logger.warn(`sidebar router: visibility read failed: ${historyErrorCode(err)}`);
    await ack(ctx, 'rejected', 'store-error');
  }
};
