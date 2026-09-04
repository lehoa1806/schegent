import type { ClearCompletedCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ackGenericResult, requireOps } from './handler-helpers';

// FR-R3-150 (T1621) — the queue id is now required on the wire
// (`ClearCompletedCommand.payload.queueId`) and is forwarded verbatim; the
// sidebar route no longer relies on `QueueManager.clearCompleted`'s
// `DEFAULT_QUEUE_ID` default parameter, so selecting Queue B and confirming
// Clear Done clears only Queue B's completed tasks.
export const handler: CommandHandler<ClearCompletedCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  const result = await ops.clearCompleted(command.payload.queueId);
  await ackGenericResult(ctx, result);
};
