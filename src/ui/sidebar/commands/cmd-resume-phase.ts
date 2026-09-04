import type { ResumePhaseCommand } from '../messages';
import type { CommandHandler } from './handler-contract';
import { execAndAck } from './handler-helpers';

// FR-R3-154 (T1646) — see `cmd-pause-phase.ts`; the resume's own refusals
// (`no-active-run`, `ambiguous-run-target`) reach the webview instead of a
// blanket `accepted`.
export const handler: CommandHandler<ResumePhaseCommand> = async (ctx, cmd) => {
  // The prompt stays positional and optional; the queue is always sent, so a
  // resume with no operator prompt still says which Run it resumes.
  await execAndAck(ctx, 'schegent.resumePhase', cmd.payload.prompt, cmd.payload.queueId);
};
