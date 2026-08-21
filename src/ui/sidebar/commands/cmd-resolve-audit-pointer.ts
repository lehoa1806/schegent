import type {
  HistoryEvidenceEntry,
  ResolveAuditPointerCommand,
  ResolveAuditPointerResponse
} from '../messages';
import type { HistoryEvidenceResolution } from '../../../services/history/history-evidence-service';
import { historyErrorCode } from '../../../services/history/error-code';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// FR-R3-010 (T410) — history evidence drill-down. Read-only: it MUST stay out
// of `MUTATING_COMMANDS` so a secondary window can still reach a completed
// Run's evidence, and it takes no primacy gate for the same reason.
//
// The handler owns the projection from the host's resolution union to the wire
// response, and that projection is where the payload is dropped. An audit
// payload carries phase notes and error summaries — operator-authored text —
// and this command answers reachability, not contents.
export const handler: CommandHandler<ResolveAuditPointerCommand> = async (ctx, command) => {
  if (!ctx.deps.historyEvidenceService) {
    await ack(ctx, 'rejected', 'internal-error', {
      outcome: 'failure',
      reason: 'internal-error'
    } satisfies ResolveAuditPointerResponse);
    return;
  }

  let resolution: HistoryEvidenceResolution;
  try {
    resolution = await ctx.deps.historyEvidenceService.resolve(command.payload.runId);
  } catch (err) {
    // Feature 103 (T080, FR-047) — the code, not the message. `sanitize`
    // redacts secret patterns and nothing else, so it left the absolute path an
    // fs error quotes intact; the resolver reads the audit corpus off disk, so
    // that path starts at the workspace root. The run id is already ack'd back
    // to the caller, which is the half of the message worth keeping.
    ctx.deps.logger.warn(
      `sidebar router: audit pointer resolution failed: ${historyErrorCode(err)}`
    );
    await ack(ctx, 'rejected', 'internal-error', {
      outcome: 'failure',
      reason: 'internal-error'
    } satisfies ResolveAuditPointerResponse);
    return;
  }

  const response = toResponse(resolution);
  // `evidence-expired`, `no-evidence-recorded` and `unaddressable` ack as
  // **accepted**. They are answers, not refusals: the host was asked a question
  // and gave the true one. Acking them as rejected would put them through the
  // webview's error path, which is the exact conflation T411 exists to prevent.
  await ack(
    ctx,
    response.outcome === 'failure' ? 'rejected' : 'accepted',
    response.outcome === 'failure' ? response.reason : undefined,
    response
  );
};

function toResponse(resolution: HistoryEvidenceResolution): ResolveAuditPointerResponse {
  switch (resolution.status) {
    case 'resolved':
      return {
        outcome: 'resolved',
        runId: resolution.runId,
        entries: resolution.entries.map(projectEvidenceEntry),
        truncated: resolution.truncated,
        parseWarnings: resolution.parseWarnings
      };
    case 'evidence-expired':
      return { outcome: 'evidence-expired', runId: resolution.runId };
    case 'no-evidence-recorded':
      return { outcome: 'no-evidence-recorded', runId: resolution.runId };
    case 'unaddressable':
      return { outcome: 'unaddressable' };
    case 'unknown-run':
      return { outcome: 'failure', reason: 'unknown-run' };
    case 'unavailable':
      // The resolver's reason is already a closed token chosen by the host —
      // never an adapter's message, which would name the path it tried to open.
      return { outcome: 'failure', reason: resolution.reason };
  }
}

function projectEvidenceEntry(entry: {
  readonly id: string;
  readonly timestamp: string;
  readonly eventType: string;
  readonly phase: string;
  readonly iteration: number;
  readonly outcome: string;
}): HistoryEvidenceEntry {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    eventType: entry.eventType,
    phase: entry.phase,
    iteration: entry.iteration,
    outcome: entry.outcome
  };
}
