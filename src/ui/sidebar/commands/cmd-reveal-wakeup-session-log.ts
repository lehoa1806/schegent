import type {
  RevealWakeupSessionLogCommand,
  RevealWakeupSessionLogResponse,
  RevealWakeupSessionLogResponseRejected
} from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, checkPrimary } from './handler-helpers';

// Feature 031 T050 — read-only IPC. MUST stay out of MUTATING_COMMANDS so
// secondary VS Code hosts can still attempt the reveal — but the primary-host
// gate INSIDE this handler keeps the host-side side effect (opening the OS
// file manager) sourced from a single window, matching the contract
// requirement at specs/031-advanced-wakeup-logs-models/contracts/wakeup-reveal-session-log-ipc.md.
export const handler: CommandHandler<RevealWakeupSessionLogCommand> = async (ctx) => {
  if (!checkPrimary(ctx)) {
    const failure: RevealWakeupSessionLogResponseRejected = {
      status: 'rejected',
      reason: 'not-primary-host'
    };
    await ack(ctx, 'rejected', 'not-primary-host', failure);
    return;
  }
  if (!ctx.deps.revealWakeupSessionLog) {
    const failure: RevealWakeupSessionLogResponseRejected = {
      status: 'rejected',
      reason: 'unknown-error'
    };
    await ack(ctx, 'rejected', 'unknown-error', failure);
    return;
  }
  let response: RevealWakeupSessionLogResponse;
  try {
    response = await ctx.deps.revealWakeupSessionLog();
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: wakeup session-log reveal failed: ${ctx.deps.logger.sanitize(
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
