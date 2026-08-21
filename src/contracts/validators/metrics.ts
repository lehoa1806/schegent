import {
  CMD_READ_METRICS,
  isReadMetricsRunIdList,
  type ReadMetricsRequest,
  type ReadMetricsResponse,
  type SidebarCommand
} from '../sidebar-ipc';
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
  // Feature 103 (T092) — for the same reason. The run detail quotes one run's
  // cost, and FR-026 turns on the difference between "not reported" and a
  // figure; a malformed record admitted here would render as one or the other
  // with nothing to say it was neither. Absent stays legal — the field is only
  // present when the request asked for it.
  const runSummaries = response['runSummaries'];
  if (runSummaries !== undefined && !isValidRunSummaryList(runSummaries)) return false;
  return true;
}

const RUN_SUMMARY_NUMBER_FIELDS = [
  'durationMs',
  'phasesTotal',
  'phasesCompleted',
  'phasesSkipped',
  'backendInvocations'
] as const;

const RUN_SUMMARY_TERMINAL_STATUSES: readonly string[] = ['completed', 'failed', 'canceled'];

function isValidRunSummaryList(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((entry) => isValidRunSummary(entry));
}

function isValidRunSummary(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const summary = value as Record<string, unknown>;
  if (typeof summary['runId'] !== 'string' || summary['runId'].length === 0) return false;
  if (!RUN_SUMMARY_TERMINAL_STATUSES.includes(summary['terminalStatus'] as string)) return false;
  if (typeof summary['startedAt'] !== 'string' || typeof summary['endedAt'] !== 'string') {
    return false;
  }
  for (const field of RUN_SUMMARY_NUMBER_FIELDS) {
    const candidate = summary[field];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return false;
  }
  // Optional, and absent rather than zero when nothing reported. A `null` here
  // would be a third state the reader has no branch for.
  const costUsd = summary['costUsd'];
  return costUsd === undefined || (typeof costUsd === 'number' && Number.isFinite(costUsd));
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
  if (hasUnexpectedKeys(value, ['includeArchives', 'runIds'])) {
    return fail('unexpected-payload-fields', { type: CMD_READ_METRICS, correlationId });
  }
  const includeArchives = value['includeArchives'];
  if (includeArchives !== undefined && typeof includeArchives !== 'boolean') {
    return fail('invalid-payload-field', { type: CMD_READ_METRICS, correlationId });
  }
  // Feature 103 (T092, FR-023) — `runIds` arrives from the webview, so it is
  // checked here and not merely where it is used. The bound matters as much as
  // the shape: the host filters the rollup by this list, and an unbounded list
  // is an unbounded scan the webview chose.
  const runIds = value['runIds'];
  if (runIds !== undefined && !isReadMetricsRunIdList(runIds)) {
    return fail('invalid-payload-field', { type: CMD_READ_METRICS, correlationId });
  }

  // Rebuilt field by field rather than passed through, so an absent field stays
  // absent instead of arriving as `undefined` on a key that exists.
  const request: { -readonly [K in keyof ReadMetricsRequest]: ReadMetricsRequest[K] } = {};
  if (includeArchives !== undefined) request.includeArchives = includeArchives;
  if (runIds !== undefined) request.runIds = runIds;

  return ok({ type: CMD_READ_METRICS, correlationId, payload: request } as SidebarCommand);
}
