import type { CancelCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { execAndAck } from './handler-helpers';

// Feature 017 — BUG-001. Thread the operator-selected taskId through the host
// command so identity survives `globalConcurrencyCap > 1` and post-pause/resume
// swaps. The host resolves the target by FeatureRequest id rather than the
// singular store.getRun() projection.
export const handler: CommandHandler<CancelCommand> = async (ctx, command) => {
  await execAndAck(ctx, 'schegent.cancel', { taskId: command.payload.taskId });
};
