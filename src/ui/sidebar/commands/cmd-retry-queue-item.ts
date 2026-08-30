import type { RetryQueueItemCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ackGenericResult } from './handler-helpers';

// This handler used to call `queueOps.retry()` directly, which returned the row
// to `pending` and stopped there. That is the whole defect: `AutoDrainCoordinator`
// is edge-triggered, so nothing started the retried Task. Delegating to the host
// command — the shape `cmd-restart-canceled-task` already had — puts the sidebar's
// Retry (↻) on the one path that owns the drain trigger, so the fix cannot be
// half-applied to one of the two retry affordances.
//
// The refusal reason still reaches the operator: `runRetryQueuedItem` warns
// through the host notifier before returning `{ ok: false }`, which is what
// `ackMutationResult`'s `handleIllegalState` branch used to do here.
export const handler: CommandHandler<RetryQueueItemCommand> = async (ctx, command) => {
  const result = (await Promise.resolve(
    ctx.deps.executeCommand('schegent.retryQueuedItem', { id: command.payload.id })
  )) as { ok: boolean; reason?: string } | undefined;
  await ackGenericResult(ctx, result ?? { ok: true });
};
