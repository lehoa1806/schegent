import type { ReadPhaseLogCommand, ReadPhaseLogResponse } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack, appendPhaseLogAudit } from './handler-helpers';

// Feature 020 T031 — read-only handler. MUST stay out of MUTATING_COMMANDS so
// secondary VS Code hosts can dispatch it too. The adapter resolves the
// selection tuple against the current snapshot and loads the manifest;
// sanitization happens inside the adapter at the IPC boundary
// (research.md §5). The audit event payload is paths-free per
// contracts/phase-log-ipc.md §1.
export const handler: CommandHandler<ReadPhaseLogCommand> = async (ctx, command) => {
  if (!ctx.deps.phaseLogService) {
    await ack(
      ctx,
      'rejected',
      'internal-error',
      { outcome: 'failure', reason: 'internal-error' } satisfies ReadPhaseLogResponse
    );
    return;
  }
  const req = command.payload;
  let response: ReadPhaseLogResponse;
  try {
    response = await ctx.deps.phaseLogService.read(req);
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: phase-log read failed: ${ctx.deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
    response = { outcome: 'failure', reason: 'internal-error' };
  }
  await ack(
    ctx,
    response.outcome === 'success' ? 'accepted' : 'rejected',
    response.outcome === 'success' ? undefined : response.reason,
    response
  );
  await appendPhaseLogAudit(ctx, 'phase-log-read', {
    selection: req.selection,
    response
  });
};
