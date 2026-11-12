import { historyErrorCode } from '../../../services/history/error-code';
import type { DecidePhaseHandoffCommand, DecidePhaseHandoffResponse } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// FR-R6-F15 — gated serialized manual phase-to-phase context handoff decision (`approve` / `edit`).
// Enforces expected-revision compare-and-swap via `PhaseContextApi`.

export const handler: CommandHandler<DecidePhaseHandoffCommand> = async (ctx, command) => {
  const api = ctx.deps.phaseContextApi?.();
  if (!api) {
    const unavailable = {
      ok: false as const,
      failure: 'storage-unavailable' as const,
      detail: 'handoff-coordinator-unavailable'
    };
    const response: DecidePhaseHandoffResponse =
      command.payload.op === 'approve'
        ? { op: 'approve', result: unavailable }
        : { op: 'edit', result: unavailable };
    await ack(ctx, 'rejected', 'storage-unavailable', response);
    return;
  }

  try {
    if (command.payload.op === 'approve') {
      const result = api.approveHandoff(
        command.payload.handoffId,
        command.payload.expectedRevision,
        command.payload.decisionId
      );
      const response: DecidePhaseHandoffResponse = { op: 'approve', result };
      await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.failure, response);
      return;
    }
    const result = api.editHandoff(
      command.payload.handoffId,
      command.payload.baseRevision,
      command.payload.replacementSources
    );
    const response: DecidePhaseHandoffResponse = { op: 'edit', result };
    await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.failure, response);
  } catch (err) {
    ctx.deps.logger.warn(`sidebar router: phase handoff decision failed: ${historyErrorCode(err)}`);
    await ack(ctx, 'rejected', 'storage-unavailable');
  }
};
