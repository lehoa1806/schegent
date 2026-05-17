import type { StartCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// Feature 017 — BUG-003. Dashboard submit is a pure enqueue. Route through
// `schegent.enqueue` so a submission while the controller is mid-pipeline
// lands as pending rather than returning the legacy already-in-flight reject.
// The host re-validates description, rerun pair, pipelineId, foreign-lock,
// queue-paused state, target queue id, position, and task-per-queue cap.
export const handler: CommandHandler<StartCommand> = async (ctx, command) => {
  const enqueueResult = (await Promise.resolve(
    ctx.deps.executeCommand('schegent.enqueue', {
      description: command.payload.description,
      pipelineId: command.payload.pipelineId,
      queueId: command.payload.queueId,
      position: command.payload.position
    })
  )) as
    | {
        readonly result: { outcome: string; reason?: string; queueItemId?: string };
        readonly queueId: string | null;
        readonly queueName: string | null;
      }
    | undefined;
  if (!enqueueResult) {
    await ack(ctx, 'rejected', 'no-result');
    return;
  }
  const outcome = enqueueResult.result.outcome;
  if (outcome === 'enqueued') {
    await ack(ctx, 'accepted', undefined, {
      outcome: 'enqueued',
      queueItemId: enqueueResult.result.queueItemId,
      queueId: enqueueResult.queueId,
      queueName: enqueueResult.queueName
    });
    return;
  }
  await ack(ctx, 'rejected', enqueueResult.result.reason ?? outcome);
};
