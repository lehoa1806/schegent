import { reportFailed, reportRefused } from '../../../contracts/reporting/report-outcomes';
import { historyErrorCode } from '../../../services/history/error-code';
import type { MutateReportCommand, MutateReportResponse } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// FR-R6-F11 (FR-016..FR-020) — gated concurrent report export and saved-report mutations.
//
// `export` obtains its destination exclusively from the host's native save dialog (`exportReportWithDialog`),
// so zero filesystem paths cross the webview IPC boundary in either direction.

export const handler: CommandHandler<MutateReportCommand> = async (ctx, command) => {
  const payload = command.payload;

  if (payload.op === 'export') {
    if (!ctx.deps.exportReportWithDialog) {
      const response: MutateReportResponse = {
        op: 'export',
        exportOutcome: {
          outcome: 'completed',
          result: reportRefused('accounting-unavailable')
        }
      };
      await ack(ctx, 'rejected', 'accounting-unavailable', response);
      return;
    }
    try {
      const exportOutcome = await ctx.deps.exportReportWithDialog({
        reportId: payload.reportId,
        format: payload.format
      });
      const response: MutateReportResponse = { op: 'export', exportOutcome };
      if (exportOutcome.outcome === 'dialog-canceled') {
        await ack(ctx, 'rejected', 'canceled', response);
        return;
      }
      await ack(
        ctx,
        exportOutcome.result.ok ? 'accepted' : 'rejected',
        exportOutcome.result.ok ? undefined : exportOutcome.result.outcome,
        response
      );
      return;
    } catch (err) {
      ctx.deps.logger.warn(`sidebar router: report export failed: ${historyErrorCode(err)}`);
      const response: MutateReportResponse = {
        op: 'export',
        exportOutcome: { outcome: 'completed', result: reportFailed('write-failed') }
      };
      await ack(ctx, 'rejected', 'write-failed', response);
      return;
    }
  }

  const api = ctx.deps.reportingApi?.();
  if (!api) {
    const unavailable = reportRefused('accounting-unavailable');
    const response: MutateReportResponse =
      payload.op === 'save'
        ? { op: 'save', result: unavailable }
        : { op: 'deleteSaved', result: unavailable };
    await ack(ctx, 'rejected', 'accounting-unavailable', response);
    return;
  }

  try {
    if (payload.op === 'save') {
      const result = api.saveReport({ reportId: payload.reportId });
      const response: MutateReportResponse = { op: 'save', result };
      await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.outcome, response);
      return;
    }
    const result = api.deleteSavedReport({ reportId: payload.reportId });
    const response: MutateReportResponse = { op: 'deleteSaved', result };
    await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.outcome, response);
  } catch (err) {
    ctx.deps.logger.warn(`sidebar router: saved report mutation failed: ${historyErrorCode(err)}`);
    const failedResult = reportFailed('write-failed');
    const response: MutateReportResponse =
      payload.op === 'save'
        ? { op: 'save', result: failedResult }
        : { op: 'deleteSaved', result: failedResult };
    await ack(ctx, 'rejected', 'write-failed', response);
  }
};
