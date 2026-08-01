import type { ReadMetricsCommand, ReadMetricsResponse } from '../messages';
import type { CommandHandler, HandlerContext } from './handler-contract';
import { ack, checkPrimary } from './handler-helpers';

// Feature 073 T010 — handler MUST gate on isPrimaryHost() to prevent multi-window
// races during archive scans.
// Workspace root reaches this handler only via ctx.deps.metricsService,
// which wireStage2() constructs once at activation with a resolved
// workspaceRoot — this file never reads workspaceFolders directly.
export const handler: CommandHandler<ReadMetricsCommand> = async (ctx, command) => {
  await checkPrimary(ctx);
  await emitViewOpenedOnce(ctx);

  const req = command.payload ?? {};
  const includesArchives = req.includeArchives ?? false;
  const emptyResponse: ReadMetricsResponse = {
    tasks: [],
    phaseTypeAggregates: [],
    costTimeline: [],
    meta: {
      includesArchives,
      totalScannedEntries: 0,
      parseWarnings: 0
    }
  };

  if (!ctx.deps.metricsService) {
    await ack(ctx, 'rejected', 'internal-error', emptyResponse);
    return;
  }

  let response: ReadMetricsResponse;
  try {
    response = await ctx.deps.metricsService.read(req);
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: metrics read failed: ${ctx.deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
    await ack(ctx, 'rejected', 'internal-error', emptyResponse);
    return;
  }

  await ack(ctx, 'accepted', undefined, response);
};

// contracts/metrics-view-opened-event.md — emitted at most once per
// session (first CMD_READ_METRICS dispatch this activation). The tracker
// object is constructed once in wireStage2() alongside sessionId, so its
// lifetime matches "session" as defined by the contract.
async function emitViewOpenedOnce(ctx: HandlerContext): Promise<void> {
  const state = ctx.deps.metricsViewOpenedState;
  if (!state || state.emitted) return;
  if (!ctx.deps.audit || !ctx.deps.sessionId) return;
  state.emitted = true;
  try {
    await ctx.deps.audit.append({
      runId: 'metrics-dashboard',
      phase: 'metrics',
      iteration: 0,
      eventType: 'metrics-view-opened',
      payload: { sessionId: ctx.deps.sessionId },
      outcome: 'info',
      correlationId: ctx.correlationId
    });
  } catch (err) {
    ctx.deps.logger.warn(
      `sidebar router: metrics-view-opened audit append failed: ${ctx.deps.logger.sanitize(
        (err as Error).message ?? 'unknown error'
      )}`
    );
  }
}
