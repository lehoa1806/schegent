import type { PausePhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { execAndAck } from './handler-helpers';

// FR-R3-154 (T1646) — `execAndAck`, not `exec` then `ack('accepted')`. The
// host command returns whether the pause was committed, refused, or broke, and
// this route reports that answer rather than the fact that it asked.
export const handler: CommandHandler<PausePhaseCommand> = async (ctx, cmd) => {
  await execAndAck(ctx, 'schegent.pausePhase', cmd.payload.queueId);
};
