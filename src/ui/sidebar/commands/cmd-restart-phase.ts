import type { RestartPhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { execAndAck } from './handler-helpers';

// FR-R3-154 (T1646) — see `cmd-pause-phase.ts`.
export const handler: CommandHandler<RestartPhaseCommand> = async (ctx, cmd) => {
  await execAndAck(ctx, 'schegent.restartPhase', cmd.payload.queueId);
};
