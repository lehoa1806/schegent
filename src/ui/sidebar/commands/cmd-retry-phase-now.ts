import type { RetryPhaseNowCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { execAndAck } from './handler-helpers';

// FR-R3-154 (T1646) — the route where the false `accepted` was widest: the
// command returned early for a lost workspace lock and for every delayed-retry
// ineligibility (`no-active-run`, `not-pending-retry`, `already-retrying`), and
// all four resolved as a retry that had started.
export const handler: CommandHandler<RetryPhaseNowCommand> = async (ctx, cmd) => {
  await execAndAck(ctx, 'schegent.retryPhaseNow', cmd.payload.queueId);
};
