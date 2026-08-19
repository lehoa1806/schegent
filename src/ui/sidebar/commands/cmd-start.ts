import { DEFAULT_QUEUE_ID } from '../../../queue/queue-registry';
import type { StartCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// Feature 017 — BUG-003. Dashboard submit is a pure enqueue. Route through
// `schegent.enqueue` so a submission while the controller is mid-pipeline
// lands as pending rather than returning the legacy already-in-flight reject.
// The host re-validates description, rerun pair, pipelineId, foreign-lock,
// queue-paused state, target queue id, position, and task-per-queue cap.
//
// Feature 065 — when the chooser commits a start-mode selection, the
// optional `startIntent` payload is threaded through to `schegent.enqueue`
// and ultimately to `GuardedRunService.scheduleOrEnqueue()`. `CMD_START`
// originates from a human-facing surface, so `callerKind` is `'human'` —
// omission of `startIntent` lands the task safely in `idle-pending` with
// `scheduledStartAt: null` (per FR-009 dismiss path).
//
// FR-R3-002 (T279) — this is the ingress boundary that resolves an unscoped
// submit. `StartCommand.payload.queueId` is optional because the webview's
// unscoped queue form has no queue in hand, and this handler's own contract
// already documents that absence as "the configured default queue". Resolving
// it here, once and explicitly, is what lets `runEnqueue` require a queue and
// refuse anything else: the meaning is applied at the layer that holds it,
// not inferred by a default parameter four calls deeper.
export const handler: CommandHandler<StartCommand> = async (ctx, command) => {
  const enqueueResult = (await Promise.resolve(
    ctx.deps.executeCommand('schegent.enqueue', {
      description: command.payload.description,
      pipelineId: command.payload.pipelineId,
      queueId: command.payload.queueId ?? DEFAULT_QUEUE_ID,
      position: command.payload.position,
      ...(command.payload.startIntent
        ? { startIntent: command.payload.startIntent }
        : {}),
      callerKind: 'human'
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
