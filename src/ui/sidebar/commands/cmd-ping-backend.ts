import type { PingBackendCommand } from '../messages';
import type { BackendRunnerKind } from '../../../contracts/backend-kinds';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

const RUNNERS: ReadonlySet<string> = new Set(['claude', 'codex', 'agy']);

export const handler: CommandHandler<PingBackendCommand> = async (ctx, command) => {
  const payload = command.payload;
  if (
    payload === null
    || typeof payload !== 'object'
    || Object.keys(payload).length !== 1
    || !RUNNERS.has(payload.runner)
  ) {
    await ack(ctx, 'rejected', 'invalid-payload');
    return;
  }
  if (!ctx.deps.backendPingService) {
    await ack(ctx, 'rejected', 'workspace-required');
    return;
  }
  const result = await ctx.deps.backendPingService.ping(
    payload.runner as BackendRunnerKind,
    ctx.correlationId
  );
  await ack(
    ctx,
    result.accepted ? 'accepted' : 'rejected',
    result.accepted ? undefined : 'already-in-progress',
    result.state
  );
};
