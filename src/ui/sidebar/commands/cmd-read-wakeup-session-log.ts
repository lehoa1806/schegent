import type {
  ReadWakeupSessionLogCommand,
  ReadWakeupSessionLogResponse,
  ReadWakeupSessionLogResponseRejected
} from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, checkPrimary } from './handler-helpers';
import { UUIDV4_RE } from './constants';

// Feature 031 T036 — read-only IPC. MUST stay out of MUTATING_COMMANDS so
// secondary VS Code hosts can still inspect a previously captured session.
// Contract §5 demands an explicit primary-host check INSIDE the handler with
// the closed-vocabulary `'not-primary-host'` reason — distinct from the
// mutating gate's `'secondary-window-readonly'`.
export const handler: CommandHandler<ReadWakeupSessionLogCommand> = async (ctx, command) => {
  if (!checkPrimary(ctx)) {
    const failure: ReadWakeupSessionLogResponseRejected = {
      status: 'rejected',
      reason: 'not-primary-host'
    };
    await ack(ctx, 'rejected', 'not-primary-host', failure);
    return;
  }
  // Defense-in-depth UUIDv4 shape gate. The webview helper short-circuits on
  // a malformed id too, but the host re-validates so a misbehaved client (or
  // a future direct dispatcher) cannot reach the reader with a non-canonical
  // id. Same discipline as the 020 phase-log composer.
  const id = command.payload?.correlationId;
  if (typeof id !== 'string' || !UUIDV4_RE.test(id)) {
    const failure: ReadWakeupSessionLogResponseRejected = {
      status: 'rejected',
      reason: 'invalid-correlation-id'
    };
    await ack(ctx, 'rejected', 'invalid-correlation-id', failure);
    return;
  }
  if (!ctx.deps.wakeupSessionLogService) {
    const failure: ReadWakeupSessionLogResponseRejected = {
      status: 'rejected',
      reason: 'unknown-error'
    };
    await ack(ctx, 'rejected', 'unknown-error', failure);
    return;
  }
  let response: ReadWakeupSessionLogResponse;
  try {
    response = await ctx.deps.wakeupSessionLogService.read({ correlationId: id });
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: wakeup session-log read failed: ${ctx.deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
    response = { status: 'rejected', reason: 'unknown-error' };
  }
  await ack(
    ctx,
    response.status === 'success' ? 'accepted' : 'rejected',
    response.status === 'success' ? undefined : response.reason,
    response
  );
};
