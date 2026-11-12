import { reportFailed, reportRefused } from '../../../contracts/reporting/report-outcomes';
import { historyErrorCode } from '../../../services/history/error-code';
import type { ReadReportCommand, ReadReportResponse } from '../messages';
import type { CommandHandler } from './handler-contract';
import { ack } from './handler-helpers';

// FR-R6-F11 (FR-001..FR-022, NFR-006) — read-only historical reporting queries and active-query
// cancellation. Starts no process, writes no persisted state or file, and appends no audit row.

let activeReportAbort: AbortController | null = null;

function beginActiveQuery(): AbortController {
  if (activeReportAbort !== null) {
    activeReportAbort.abort();
  }
  const next = new AbortController();
  activeReportAbort = next;
  return next;
}

function finishActiveQuery(controller: AbortController): void {
  if (activeReportAbort === controller) {
    activeReportAbort = null;
  }
}

export const handler: CommandHandler<ReadReportCommand> = async (ctx, command) => {
  const payload = command.payload;

  if (payload.op === 'cancelActive') {
    const hadActive = activeReportAbort !== null && !activeReportAbort.signal.aborted;
    if (activeReportAbort !== null) {
      activeReportAbort.abort();
      activeReportAbort = null;
    }
    const response: ReadReportResponse = { op: 'cancelActive', canceled: hadActive };
    await ack(ctx, 'accepted', undefined, response);
    return;
  }

  const api = ctx.deps.reportingApi?.();
  if (!api) {
    const unavailable = reportRefused('accounting-unavailable');
    const response: ReadReportResponse =
      payload.op === 'run'
        ? { op: 'run', result: unavailable }
        : payload.op === 'page'
          ? { op: 'page', result: unavailable }
          : payload.op === 'drillDown'
            ? { op: 'drillDown', result: unavailable }
            : payload.op === 'close'
              ? { op: 'close', result: unavailable }
              : payload.op === 'listSaved'
                ? { op: 'listSaved', result: unavailable }
                : payload.op === 'rerunSaved'
                  ? { op: 'rerunSaved', result: unavailable }
                  : { op: 'reproduceSaved', result: unavailable };
    await ack(ctx, 'rejected', 'accounting-unavailable', response);
    return;
  }

  try {
    switch (payload.op) {
      case 'run': {
        const controller = beginActiveQuery();
        try {
          const result = await api.runReport(payload.query, controller.signal);
          const response: ReadReportResponse = { op: 'run', result };
          await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.outcome, response);
          return;
        } finally {
          finishActiveQuery(controller);
        }
      }
      case 'page': {
        const result = api.readPage({ cursor: payload.cursor });
        const response: ReadReportResponse = { op: 'page', result };
        await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.outcome, response);
        return;
      }
      case 'drillDown': {
        const result = api.drillDown({ reportId: payload.reportId, rootId: payload.rootId });
        const response: ReadReportResponse = { op: 'drillDown', result };
        await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.outcome, response);
        return;
      }
      case 'close': {
        const result = api.closeReport({ reportId: payload.reportId });
        const response: ReadReportResponse = { op: 'close', result };
        await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.outcome, response);
        return;
      }
      case 'listSaved': {
        const result = api.listSavedReports(payload.request ?? {});
        const response: ReadReportResponse = { op: 'listSaved', result };
        await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.outcome, response);
        return;
      }
      case 'rerunSaved': {
        const controller = beginActiveQuery();
        try {
          const result = await api.rerunSavedReport({ reportId: payload.reportId }, controller.signal);
          const response: ReadReportResponse = { op: 'rerunSaved', result };
          await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.outcome, response);
          return;
        } finally {
          finishActiveQuery(controller);
        }
      }
      case 'reproduceSaved': {
        const controller = beginActiveQuery();
        try {
          const result = await api.reproduceSavedReport({ reportId: payload.reportId }, controller.signal);
          const response: ReadReportResponse = { op: 'reproduceSaved', result };
          await ack(ctx, result.ok ? 'accepted' : 'rejected', result.ok ? undefined : result.outcome, response);
          return;
        } finally {
          finishActiveQuery(controller);
        }
      }
    }
  } catch (err) {
    ctx.deps.logger.warn(`sidebar router: report read failed: ${historyErrorCode(err)}`);
    const failed = reportFailed('source-read-failed');
    const response: ReadReportResponse =
      payload.op === 'run'
        ? { op: 'run', result: failed }
        : payload.op === 'page'
          ? { op: 'page', result: failed }
          : payload.op === 'drillDown'
            ? { op: 'drillDown', result: failed }
            : payload.op === 'close'
              ? { op: 'close', result: failed }
              : payload.op === 'listSaved'
                ? { op: 'listSaved', result: failed }
                : payload.op === 'rerunSaved'
                  ? { op: 'rerunSaved', result: failed }
                  : { op: 'reproduceSaved', result: failed };
    await ack(ctx, 'rejected', 'source-read-failed', response);
  }
};
