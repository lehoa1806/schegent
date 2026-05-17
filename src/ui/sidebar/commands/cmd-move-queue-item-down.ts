import type { MoveQueueItemDownCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ackMutationResult, dispatchArrowMove, requireOps } from './handler-helpers';

// Feature 030 (US2, T032) — see cmd-move-queue-item-up.
export const handler: CommandHandler<MoveQueueItemDownCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  if (ops.reorderTaskInUnifiedQueue) {
    await dispatchArrowMove(ctx, ops, command.payload.id, 1);
    return;
  }
  const result = await ops.moveDown(command.payload.id);
  await ackMutationResult(ctx, result, 'reorder');
};
