import type { MoveQueueItemUpCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ackMutationResult, dispatchArrowMove, requireOps } from './handler-helpers';

// Feature 030 (US2, T032) — route arrow-driven move through the unified-reorder
// helper so success AND every rejection branch emit the canonical
// `task-reordered` audit event with `source: 'arrow'`.
export const handler: CommandHandler<MoveQueueItemUpCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  if (ops.reorderTaskInUnifiedQueue) {
    await dispatchArrowMove(ctx, ops, command.payload.id, -1);
    return;
  }
  const result = await ops.moveUp(command.payload.id);
  await ackMutationResult(ctx, result, 'reorder');
};
