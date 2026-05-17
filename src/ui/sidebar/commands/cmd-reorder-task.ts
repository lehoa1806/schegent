import type { ReorderTaskCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import {
  ack,
  ackGenericResult,
  appendQueueAudit,
  emitReorderAudit,
  requireOps
} from './handler-helpers';

// Feature 030 (US2, T032) — route drag-driven reorder through the unified-
// reorder helper so success AND every rejection branch emit the canonical
// `task-reordered` audit event with `source: 'drag'`. Falls back to the legacy
// boolean `reorderTask` adapter when the structured helper is not wired
// (preserves test harnesses that haven't migrated yet).
export const handler: CommandHandler<ReorderTaskCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  if (ops.reorderTaskInUnifiedQueue) {
    const decision = await ops.reorderTaskInUnifiedQueue(
      command.payload.taskId,
      command.payload.newPosition
    );
    await emitReorderAudit(ctx, command.payload.taskId, 'drag', decision);
    if (decision.outcome === 'success') {
      await ack(ctx, 'accepted');
    } else {
      await ack(ctx, 'rejected', decision.cause ?? 'reorder-rejected');
    }
    return;
  }
  if (!ops.reorderTask) {
    await ack(ctx, 'rejected', 'queue-ops-unavailable');
    return;
  }
  const result = await ops.reorderTask(
    command.payload.taskId,
    command.payload.newPosition
  );
  await ackGenericResult(ctx, result);
  if (result.ok) {
    await appendQueueAudit(ctx, 'task-reordered', {
      taskId: command.payload.taskId,
      queueId: result.queueId ?? null,
      newPosition: command.payload.newPosition
    });
  }
};
