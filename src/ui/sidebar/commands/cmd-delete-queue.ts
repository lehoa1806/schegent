import type { DeleteQueueCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, appendQueueAudit, requireOps } from './handler-helpers';

/**
 * Feature 092 (T031, US1, FR-004, FR-014 – FR-016a) — delete a queue.
 *
 * Two-phase, because the host cannot open a modal from here and the impact
 * count must come from the host: an unconfirmed command answers `rejected` /
 * `confirmation-required` with the pending-Task count and every bound
 * connected run, and only a `confirmed: true` command deletes.
 *
 * The refusals are ordered and the first match wins — default queue, then
 * in-flight Task, then the confirmation gate — and that order is the contract
 * of contracts/queue-registry-and-migration.md §1. `confirmed: true` answers
 * the confirmation gate only; it is not an override for the two refusals
 * ahead of it, which is why the impact read happens before the branch.
 */
export const handler: CommandHandler<DeleteQueueCommand> = async (ctx, command) => {
  const ops = requireOps(ctx);
  if (!ops) return;
  if (!ops.deleteQueue || !ops.queueDeletionImpact) {
    await ack(ctx, 'rejected', 'unsupported');
    return;
  }
  const queueId = command.payload?.queueId ?? '';
  const impact = ops.queueDeletionImpact(queueId);
  if (impact.outcome === 'refused') {
    await ack(ctx, 'rejected', impact.reason);
    return;
  }
  if (command.payload?.confirmed !== true) {
    await ack(ctx, 'rejected', 'confirmation-required', {
      queueId: impact.queueId,
      pendingTaskCount: impact.pendingTaskCount,
      boundConnectedRunIds: impact.boundConnectedRunIds
    });
    return;
  }
  const result = await ops.deleteQueue(queueId);
  if (!result.ok) {
    await ack(ctx, 'rejected', result.reason ?? 'operation-rejected');
    return;
  }
  await ack(ctx, 'accepted');
  await appendQueueAudit(ctx, 'queue-deleted', {
    queueId: result.queueId ?? queueId,
    pendingTaskCount: impact.pendingTaskCount,
    boundConnectedRunIds: impact.boundConnectedRunIds
  });
};
