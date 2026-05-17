import type { CancelCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ackGenericResult } from './handler-helpers';

// Feature 017 — BUG-001. Thread the operator-selected taskId through the host
// command so identity survives `globalConcurrencyCap > 1` and post-pause/resume
// swaps. The host resolves the target by FeatureRequest id rather than the
// singular store.getRun() projection.
export const handler: CommandHandler<CancelCommand> = async (ctx, command) => {
  const result = (await Promise.resolve(
    ctx.deps.executeCommand('schegent.cancel', { taskId: command.payload.taskId })
  )) as { ok: boolean; reason?: string } | undefined;
  await ackGenericResult(ctx, result ?? { ok: true });
};
