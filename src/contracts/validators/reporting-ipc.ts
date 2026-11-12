import {
  CMD_MUTATE_REPORT,
  CMD_READ_REPORT,
  type MutateReportResponse,
  type ReadReportResponse,
  type SidebarCommand
} from '../sidebar-ipc';
import {
  FAILURE_REASONS,
  LIMIT_REASONS,
  REFUSAL_REASONS,
  type ReportResult
} from '../reporting/report-outcomes';
import {
  QUEUE_ID_MAX,
  fail,
  hasUnexpectedKeys,
  isSafePathSegment,
  ok as ipcOk,
  type IpcValidationResult
} from './shared';

type Plain = Record<string, unknown>;

const CURSOR_MAX = 512;

function isPlain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedId(value: unknown): value is string {
  return isSafePathSegment(value);
}

function isCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= CURSOR_MAX;
}

export function validateReadReport(obj: Plain, correlationId: string): IpcValidationResult {
  const context = { type: CMD_READ_REPORT, correlationId };
  const payload = obj['payload'];
  if (!isPlain(payload)) return fail('missing-payload', context);
  const op = payload['op'];
  if (typeof op !== 'string') return fail('missing-op', context);

  switch (op) {
    case 'run': {
      if (hasUnexpectedKeys(payload, ['op', 'query'])) {
        return fail('unexpected-payload-fields', context);
      }
      if (!Object.hasOwn(payload, 'query')) return fail('missing-query', context);
      return ipcOk({
        ...context,
        payload: { op: 'run', query: payload['query'] }
      } as SidebarCommand);
    }
    case 'page': {
      if (hasUnexpectedKeys(payload, ['op', 'cursor'])) {
        return fail('unexpected-payload-fields', context);
      }
      const cursor = payload['cursor'];
      if (!isCursor(cursor)) return fail('invalid-cursor', context);
      return ipcOk({
        ...context,
        payload: { op: 'page', cursor }
      } as SidebarCommand);
    }
    case 'drillDown': {
      if (hasUnexpectedKeys(payload, ['op', 'reportId', 'rootId'])) {
        return fail('unexpected-payload-fields', context);
      }
      const reportId = payload['reportId'];
      const rootId = payload['rootId'];
      if (!isBoundedId(reportId)) return fail('invalid-reportId', context);
      if (!isBoundedId(rootId)) return fail('invalid-rootId', context);
      return ipcOk({
        ...context,
        payload: { op: 'drillDown', reportId, rootId }
      } as SidebarCommand);
    }
    case 'close':
    case 'rerunSaved':
    case 'reproduceSaved': {
      if (hasUnexpectedKeys(payload, ['op', 'reportId'])) {
        return fail('unexpected-payload-fields', context);
      }
      const reportId = payload['reportId'];
      if (!isBoundedId(reportId)) return fail('invalid-reportId', context);
      return ipcOk({
        ...context,
        payload: { op, reportId }
      } as SidebarCommand);
    }
    case 'listSaved': {
      if (hasUnexpectedKeys(payload, ['op', 'request'])) {
        return fail('unexpected-payload-fields', context);
      }
      const request = payload['request'];
      return ipcOk({
        ...context,
        payload: request === undefined ? { op: 'listSaved' } : { op: 'listSaved', request }
      } as SidebarCommand);
    }
    case 'cancelActive': {
      if (hasUnexpectedKeys(payload, ['op'])) {
        return fail('unexpected-payload-fields', context);
      }
      return ipcOk({
        ...context,
        payload: { op: 'cancelActive' }
      } as SidebarCommand);
    }
    default:
      return fail('invalid-op', context);
  }
}

export function validateMutateReport(obj: Plain, correlationId: string): IpcValidationResult {
  const context = { type: CMD_MUTATE_REPORT, correlationId };
  const payload = obj['payload'];
  if (!isPlain(payload)) return fail('missing-payload', context);
  const op = payload['op'];
  if (typeof op !== 'string') return fail('missing-op', context);

  switch (op) {
    case 'export': {
      // FR-R6-F11 (FR-016): zero filesystem paths may cross webview IPC; destination comes solely
      // from the host's native save dialog.
      if (hasUnexpectedKeys(payload, ['op', 'reportId', 'format'])) {
        return fail('unexpected-payload-fields', context);
      }
      const reportId = payload['reportId'];
      if (!isBoundedId(reportId)) return fail('invalid-reportId', context);
      const format = payload['format'];
      if (format !== 'json' && format !== 'csv') return fail('invalid-format', context);
      return ipcOk({
        ...context,
        payload: { op: 'export', reportId, format }
      } as SidebarCommand);
    }
    case 'save': {
      if (hasUnexpectedKeys(payload, ['op', 'reportId'])) {
        return fail('unexpected-payload-fields', context);
      }
      const reportId = payload['reportId'];
      if (!isBoundedId(reportId)) return fail('invalid-reportId', context);
      return ipcOk({
        ...context,
        payload: { op: 'save', reportId }
      } as SidebarCommand);
    }
    case 'deleteSaved': {
      if (hasUnexpectedKeys(payload, ['op', 'reportId', 'confirmed'])) {
        return fail('unexpected-payload-fields', context);
      }
      const reportId = payload['reportId'];
      if (typeof reportId !== 'string' || reportId.length === 0 || reportId.length > QUEUE_ID_MAX || !isBoundedId(reportId)) {
        return fail('invalid-reportId', context);
      }
      if (payload['confirmed'] !== true) return fail('missing-confirmation', context);
      return ipcOk({
        ...context,
        payload: { op: 'deleteSaved', reportId, confirmed: true }
      } as SidebarCommand);
    }
    default:
      return fail('invalid-op', context);
  }
}

function isReportResultShape(value: unknown, checkValue: (v: unknown) => boolean): value is ReportResult<unknown> {
  if (!isPlain(value)) return false;
  if (value['ok'] === true) return checkValue(value['value']);
  if (value['ok'] !== false) return false;
  const outcome = value['outcome'];
  if (outcome === 'cancelled') return true;
  if (outcome === 'expired') return value['instruction'] === 'restart-report-query';
  if (outcome === 'limited') {
    return typeof value['limit'] === 'string' && (LIMIT_REASONS as readonly string[]).includes(value['limit']);
  }
  if (outcome === 'failed') {
    return typeof value['reason'] === 'string' && (FAILURE_REASONS as readonly string[]).includes(value['reason']);
  }
  if (outcome === 'refused') {
    return typeof value['reason'] === 'string' && (REFUSAL_REASONS as readonly string[]).includes(value['reason']);
  }
  return false;
}

function isReportPageShape(value: unknown): boolean {
  return (
    isPlain(value) &&
    typeof value['reportId'] === 'string' &&
    typeof value['view'] === 'string' &&
    Array.isArray(value['rows']) &&
    (value['cursor'] === null || typeof value['cursor'] === 'string')
  );
}

function isDrillDownShape(value: unknown): boolean {
  return (
    isPlain(value) &&
    typeof value['reportId'] === 'string' &&
    isPlain(value['root']) &&
    typeof value['root']['rootId'] === 'string' &&
    Array.isArray(value['attempts']) &&
    typeof value['frozenDefinitionId'] === 'string' &&
    Array.isArray(value['outcomeLineage']) &&
    (value['usage'] === null || Array.isArray(value['usage'])) &&
    Array.isArray(value['omissions'])
  );
}

export function isValidReadReportResponse(value: unknown): value is ReadReportResponse {
  if (!isPlain(value) || typeof value['op'] !== 'string') return false;
  switch (value['op']) {
    case 'run':
    case 'page':
    case 'rerunSaved':
      return isReportResultShape(value['result'], isReportPageShape);
    case 'drillDown':
      return isReportResultShape(value['result'], isDrillDownShape);
    case 'close':
      return isReportResultShape(
        value['result'],
        (v) => isPlain(v) && typeof v['released'] === 'boolean'
      );
    case 'listSaved':
      return isReportResultShape(
        value['result'],
        (v) => isPlain(v) && Array.isArray(v['items']) && (v['cursor'] === null || typeof v['cursor'] === 'string')
      );
    case 'reproduceSaved':
      return isReportResultShape(
        value['result'],
        (v) => isPlain(v) && (v['verdict'] === 'reproduced' || v['verdict'] === 'source-no-longer-reproducible')
      );
    case 'cancelActive':
      return typeof value['canceled'] === 'boolean';
    default:
      return false;
  }
}

export function isValidMutateReportResponse(value: unknown): value is MutateReportResponse {
  if (!isPlain(value) || typeof value['op'] !== 'string') return false;
  switch (value['op']) {
    case 'export': {
      const eo = value['exportOutcome'];
      if (!isPlain(eo)) return false;
      if (eo['outcome'] === 'dialog-canceled') return true;
      if (eo['outcome'] !== 'completed') return false;
      return isReportResultShape(
        eo['result'],
        (v) =>
          isPlain(v) &&
          typeof v['exportId'] === 'string' &&
          typeof v['fileName'] === 'string' &&
          typeof v['manifestFileName'] === 'string'
      );
    }
    case 'save':
      return isReportResultShape(
        value['result'],
        (v) => isPlain(v) && typeof v['reportId'] === 'string' && isPlain(v['manifest'])
      );
    case 'deleteSaved':
      return isReportResultShape(
        value['result'],
        (v) => isPlain(v) && typeof v['deleted'] === 'boolean'
      );
    default:
      return false;
  }
}
