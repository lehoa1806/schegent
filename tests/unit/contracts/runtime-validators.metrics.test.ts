// Feature 073 (T004) — base envelope validation for `ReadMetricsResponse`
// (host→webview direction, the inverse of every other validator in
// runtime-validators.ts). The webview must not trust any field of a
// CMD_READ_METRICS ack result before this guard passes. Deep
// TaskRecord/PhaseRecord field validation is intentionally out of scope
// (contracts/cmd-read-metrics.md).
import { describe, expect, it } from 'vitest';
import { isValidReadMetricsResponse, validateInboundMessage } from '../../../src/contracts/runtime-validators';
import { CMD_READ_METRICS } from '../../../src/contracts/sidebar-ipc';

function validResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tasks: [],
    phaseTypeAggregates: [],
    costTimeline: [],
    meta: { includesArchives: false,
    totalScannedEntries: 0,
    parseWarnings: 0 },
    ...overrides
  };
}

describe('isValidReadMetricsResponse (Feature 073, T004)', () => {
  it('accepts the empty-state envelope', () => {
    expect(isValidReadMetricsResponse(validResponse())).toBe(true);
  });

  it('accepts a populated envelope with oldestIncludedTimestamp present', () => {
    expect(
      isValidReadMetricsResponse(
        validResponse({
          tasks: [{ runId: 'run-1' }],
          phaseTypeAggregates: [{ phaseType: 'plan' }],
          costTimeline: [{ date: '2026-07-01', dailyCostUsd: 1.5, cumulativeCostUsd: 1.5 }],
          oldestIncludedTimestamp: '2026-05-01T00:00:00.000Z',
          meta: {
            includesArchives: false,
            totalScannedEntries: 42,
            parseWarnings: 2
          }
        })
      )
    ).toBe(true);
  });

  it('rejects null and non-object values', () => {
    expect(isValidReadMetricsResponse(null)).toBe(false);
    expect(isValidReadMetricsResponse(undefined)).toBe(false);
    expect(isValidReadMetricsResponse('not-an-object')).toBe(false);
    expect(isValidReadMetricsResponse(42)).toBe(false);
  });

  it('rejects when tasks is not an array', () => {
    expect(isValidReadMetricsResponse(validResponse({ tasks: {} }))).toBe(false);
  });

  it('rejects when phaseTypeAggregates is not an array', () => {
    expect(isValidReadMetricsResponse(validResponse({ phaseTypeAggregates: 'nope' }))).toBe(false);
  });

  it('rejects when costTimeline is not an array', () => {
    expect(isValidReadMetricsResponse(validResponse({ costTimeline: null }))).toBe(false);
  });

  it('rejects a non-string, non-undefined oldestIncludedTimestamp', () => {
    expect(isValidReadMetricsResponse(validResponse({ oldestIncludedTimestamp: 12345 }))).toBe(false);
  });

  it('rejects a non-boolean includesArchived', () => {
    expect(isValidReadMetricsResponse(validResponse({ meta: { includesArchives: 'false', totalScannedEntries: 0, parseWarnings: 0 } }))).toBe(false);
  });

  it('rejects a non-numeric totalScannedEntries', () => {
    expect(isValidReadMetricsResponse(validResponse({ meta: { includesArchives: false, totalScannedEntries: '0', parseWarnings: 0 } }))).toBe(false);
  });

  it('rejects a non-numeric parseWarnings', () => {
    expect(isValidReadMetricsResponse(validResponse({ meta: { includesArchives: false, totalScannedEntries: 0, parseWarnings: null } }))).toBe(false);
  });
});

// FR-014 — the archived-history opt-in must survive the real inbound
// validation path (webview -> validateInboundMessage), not just the
// handler's own pass-through of an already-constructed command.
describe('validateInboundMessage(CMD_READ_METRICS) — includeArchives threading (FR-014)', () => {
  it('threads includeArchives: true from the raw payload into the validated command', () => {
    const result = validateInboundMessage({
      type: CMD_READ_METRICS,
      correlationId: 'corr-1',
      payload: { includeArchives: true }
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command).toEqual({
        type: CMD_READ_METRICS,
        correlationId: 'corr-1',
        payload: { includeArchives: true }
      });
    }
  });

  it('accepts an empty payload and omits includeArchives rather than forcing a default', () => {
    const result = validateInboundMessage({
      type: CMD_READ_METRICS,
      correlationId: 'corr-2',
      payload: {}
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command).toEqual({
        type: CMD_READ_METRICS,
        correlationId: 'corr-2',
        payload: {}
      });
    }
  });

  it('rejects a missing payload', () => {
    const result = validateInboundMessage({ type: CMD_READ_METRICS, correlationId: 'corr-3' });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-boolean includeArchives', () => {
    const result = validateInboundMessage({
      type: CMD_READ_METRICS,
      correlationId: 'corr-4',
      payload: { includeArchives: 'yes' }
    });
    expect(result.ok).toBe(false);
  });

  it('rejects unexpected payload fields', () => {
    const result = validateInboundMessage({
      type: CMD_READ_METRICS,
      correlationId: 'corr-5',
      payload: { includeArchives: true, workspaceRoot: '/etc/passwd' }
    });
    expect(result.ok).toBe(false);
  });
});
