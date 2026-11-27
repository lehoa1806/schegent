import type {
  ResolveHistoryDescriptionCommand,
  ResolveHistoryDescriptionResponse
} from '../messages';
import type { DescriptionResolution } from '../../../services/history/history-description-resolver';
import { historyErrorCode } from '../../../services/history/error-code';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// FR-R3-071 (feature 152) — the sidebar's replay path resolves through the same
// single decision site the two host commands use.
//
// Read-only: it MUST stay out of `MUTATING_COMMANDS`, and it takes no primacy
// gate — reading a completed Run's own description mutates nothing, and a
// secondary window is entitled to it exactly as it is to the evidence
// drill-down. The command is not a launch; the panel still submits through
// `CMD_LAUNCH_PIPELINE`, which carries its own gates.
//
// `missing` and `unreadable` ack as **accepted**. They are the true answers to
// a question the host was asked — the sidecar was swept, or could not be read —
// and the panel renders them by keeping the honest preview it already shows.
// Acking them as rejected would route a true answer through the webview's error
// path, the conflation `cmd-resolve-audit-pointer.ts` records for its own
// no-evidence arms.
export const handler: CommandHandler<ResolveHistoryDescriptionCommand> = async (ctx, command) => {
  if (!ctx.deps.historyDescriptionService) {
    await ack(ctx, 'rejected', 'internal-error', {
      outcome: 'failure',
      reason: 'internal-error'
    } satisfies ResolveHistoryDescriptionResponse);
    return;
  }

  const { runId } = command.payload;
  let resolution: DescriptionResolution | null;
  try {
    resolution = await ctx.deps.historyDescriptionService.resolve(runId);
  } catch (err) {
    // The code, never the caught message: a filesystem error quotes the
    // absolute path it was addressing, and that path starts at the workspace
    // root. The run id is already ack'd back to the caller.
    ctx.deps.logger.warn(
      `sidebar router: history description resolution failed: ${historyErrorCode(err)}`
    );
    await ack(ctx, 'rejected', 'internal-error', {
      outcome: 'failure',
      reason: 'internal-error'
    } satisfies ResolveHistoryDescriptionResponse);
    return;
  }

  // `null` is "no such run in history", which the service answers rather than
  // the validator: an id that names no row is stale state, not a malformed
  // message (see `validators/history-description.ts`).
  if (resolution === null) {
    await ack(ctx, 'rejected', 'unknown-run', {
      outcome: 'failure',
      reason: 'unknown-run'
    } satisfies ResolveHistoryDescriptionResponse);
    return;
  }

  const response: ResolveHistoryDescriptionResponse =
    resolution.outcome === 'resolved' || resolution.outcome === 'legacy'
      ? { outcome: resolution.outcome, runId, description: resolution.description }
      : { outcome: resolution.outcome, runId };
  await ack(ctx, 'accepted', undefined, response);
};
