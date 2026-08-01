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
  return true;
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
