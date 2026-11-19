// Egress response validators for reporting IPC.
// Inbound request validators are generated in `src/contracts/generated/validators/analytics-reporting.ts`.

import type { MutateReportResponse, ReadReportResponse } from '../sidebar-ipc';
import {
  FAILURE_REASONS,
  LIMIT_REASONS,
  REFUSAL_REASONS,
  type ReportResult
} from '../reporting/report-outcomes';

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
