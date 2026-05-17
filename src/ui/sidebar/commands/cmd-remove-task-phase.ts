import type { RemoveTaskPhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, ackGenericResult, appendPhaseAudit } from './handler-helpers';

export const handler: CommandHandler<RemoveTaskPhaseCommand> = async (ctx, command) => {
  if (!ctx.deps.phaseOps?.removeTaskPhase) {
    await ack(ctx, 'rejected', 'phase-ops-unavailable');
    return;
  }
  const result = await ctx.deps.phaseOps.removeTaskPhase(
    command.payload.taskId,
    command.payload.phaseId
  );
  await ackGenericResult(ctx, result);
  if (result.ok) {
    await appendPhaseAudit(ctx, 'phase-removed', {
      taskId: command.payload.taskId,
      phaseId: command.payload.phaseId,
      runId: result.runId ?? null,
      priorPhaseState: result.priorPhaseState ?? null,
      cause: 'operator'
    });
  }
};
