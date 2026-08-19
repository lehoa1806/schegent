import { CMD_READ_METRICS, type ReadMetricsResponse, type SidebarCommand } from '../sidebar-ipc';
import { fail, hasUnexpectedKeys, ok, type IpcValidationResult } from './shared';

// Covers the outer envelope the webview must trust before rendering. Deep
// TaskRecord/PhaseRecord validation remains outside this boundary.
export function isValidReadMetricsResponse(value: unknown): value is ReadMetricsResponse {
  if (value === null || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response['tasks'])) return false;
  if (!Array.isArray(response['phaseTypeAggregates'])) return false;
  if (!Array.isArray(response['costTimeline'])) return false;
  const oldestIncludedTimestamp = response['oldestIncludedTimestamp'];
  if (oldestIncludedTimestamp !== undefined && typeof oldestIncludedTimestamp !== 'string') {
    return false;
  }
  const meta = response['meta'];
  if (meta === null || typeof meta !== 'object') return false;
  const metadata = meta as Record<string, unknown>;
  if (typeof metadata['includesArchives'] !== 'boolean') return false;
  if (typeof metadata['totalScannedEntries'] !== 'number') return false;
  if (typeof metadata['parseWarnings'] !== 'number') return false;
  // FR-R3-009 — cumulative totals and coverage are rendered as figures an
  // operator may quote, so they are validated rather than trusted. A zero the
  // webview invented from a missing field would read exactly like a real total.
  if (!isValidCumulativeTotals(response['cumulative'])) return false;
  if (!isValidMetricsCoverage(response['coverage'])) return false;
  return true;
}

const CUMULATIVE_NUMBER_FIELDS = [
  'runs',
  'completedRuns',
  'failedRuns',
  'canceledRuns',
  'durationMs',
  'costUsd',
  'phasesTotal',
  'phasesCompleted',
  'phasesSkipped',
  'backendInvocations'
] as const;

function isValidCumulativeTotals(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const totals = value as Record<string, unknown>;
  for (const field of CUMULATIVE_NUMBER_FIELDS) {
    const candidate = totals[field];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return false;
  }
  return typeof totals['costUsdIsPartial'] === 'boolean';
}

function isValidMetricsCoverage(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const coverage = value as Record<string, unknown>;
  const totals = coverage['totals'];
  if (totals === null || typeof totals !== 'object') return false;
  const totalsWindow = totals as Record<string, unknown>;
  if (typeof totalsWindow['available'] !== 'boolean') return false;
  if (typeof totalsWindow['runs'] !== 'number' || !Number.isFinite(totalsWindow['runs'])) return false;
  if (!isOptionalString(totalsWindow['earliest']) || !isOptionalString(totalsWindow['latest'])) return false;

  const detail = coverage['detail'];
  if (detail === null || typeof detail !== 'object') return false;
  const detailWindow = detail as Record<string, unknown>;
  if (typeof detailWindow['includesArchives'] !== 'boolean') return false;
  return isOptionalString(detailWindow['earliest']) && isOptionalString(detailWindow['latest']);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function validateReadMetrics(
  obj: Record<string, unknown>,
  correlationId: string
): IpcValidationResult {
  const payload = obj['payload'];
  if (payload === null || typeof payload !== 'object') {
    return fail('missing-payload', { type: CMD_READ_METRICS, correlationId });
  }
  const value = payload as Record<string, unknown>;
  if (hasUnexpectedKeys(value, ['includeArchives'])) {
    return fail('unexpected-payload-fields', { type: CMD_READ_METRICS, correlationId });
  }
  const includeArchives = value['includeArchives'];
  if (includeArchives !== undefined && typeof includeArchives !== 'boolean') {
    return fail('invalid-payload-field', { type: CMD_READ_METRICS, correlationId });
  }
  return ok({
    type: CMD_READ_METRICS,
    correlationId,
    payload: includeArchives === undefined ? {} : { includeArchives }
  } as SidebarCommand);
}
