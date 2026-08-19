// Feature 073 (T004) — base envelope validation for `ReadMetricsResponse`
// (host→webview direction, the inverse of every other validator in
// runtime-validators.ts). The webview must not trust any field of a
// CMD_READ_METRICS ack result before this guard passes. Deep
// TaskRecord/PhaseRecord field validation is intentionally out of scope
// (contracts/cmd-read-metrics.md).
import { describe, expect, it } from 'vitest';
import { isValidReadMetricsResponse, validateInboundMessage } from '../../../src/contracts/runtime-validators';
import { CMD_READ_METRICS, isCmdReadMetrics } from '../../../src/contracts/sidebar-ipc';
import { buildMetricsCoverage, EMPTY_CUMULATIVE_TOTALS } from '../../../src/metrics/metrics-rollup';

// FR-R3-009 (T394) added `cumulative` and `coverage` as required members of the
// envelope, so the base fixture builds them the way the host does rather than
// hand-writing a literal — a hand-written one drifts silently the next time a
// counter is added, and the drift would show up as this file passing while the
// real response failed validation.
function validResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tasks: [],
    phaseTypeAggregates: [],
    costTimeline: [],
    meta: { includesArchives: false,
    totalScannedEntries: 0,
    parseWarnings: 0 },
    cumulative: EMPTY_CUMULATIVE_TOTALS,
    coverage: buildMetricsCoverage({ rollupAvailable: false, rollupRuns: 0, includesArchives: false }),
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
          },
          cumulative: { ...EMPTY_CUMULATIVE_TOTALS, runs: 9, completedRuns: 7, costUsd: 12.5, costUsdIsPartial: true },
          coverage: buildMetricsCoverage({
            rollupAvailable: true,
            rollupRuns: 9,
            rollupEarliest: '2026-01-01T00:00:00.000Z',
            rollupLatest: '2026-07-01T00:00:00.000Z',
            logEarliest: '2026-05-01T00:00:00.000Z',
            logLatest: '2026-07-01T00:00:00.000Z',
            includesArchives: false
          })
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

  // FR-R3-009 (T394) — cumulative totals and coverage are figures an operator
  // may quote out of the UI, so a missing or malformed one must fail the guard
  // rather than render as a zero the webview invented.
  it('rejects a missing cumulative block', () => {
    expect(isValidReadMetricsResponse(validResponse({ cumulative: undefined }))).toBe(false);
  });

  it('rejects a cumulative block missing a counter', () => {
    const { backendInvocations: _dropped, ...partial } = EMPTY_CUMULATIVE_TOTALS;
    expect(isValidReadMetricsResponse(validResponse({ cumulative: partial }))).toBe(false);
  });

  it('rejects a non-finite cumulative counter', () => {
    expect(
      isValidReadMetricsResponse(validResponse({ cumulative: { ...EMPTY_CUMULATIVE_TOTALS, costUsd: Number.NaN } }))
    ).toBe(false);
  });

  it('rejects a non-boolean costUsdIsPartial', () => {
    expect(
      isValidReadMetricsResponse(validResponse({ cumulative: { ...EMPTY_CUMULATIVE_TOTALS, costUsdIsPartial: 'no' } }))
    ).toBe(false);
  });

  it('rejects a missing coverage block', () => {
    expect(isValidReadMetricsResponse(validResponse({ coverage: undefined }))).toBe(false);
  });

  it('rejects a coverage block with no detail window', () => {
    expect(
      isValidReadMetricsResponse(validResponse({ coverage: { totals: { available: false, runs: 0 } } }))
    ).toBe(false);
  });

  it('rejects a non-boolean coverage.totals.available', () => {
    expect(
      isValidReadMetricsResponse(
        validResponse({ coverage: { totals: { available: 'yes', runs: 0 }, detail: { includesArchives: false } } })
      )
    ).toBe(false);
  });

  it('rejects a non-string coverage window bound', () => {
    expect(
      isValidReadMetricsResponse(
        validResponse({
          coverage: { totals: { available: true, runs: 1, earliest: 17 }, detail: { includesArchives: false } }
        })
      )
    ).toBe(false);
  });
});

// FR-014 — the archived-history opt-in must survive the real inbound
// validation path (webview -> validateInboundMessage), not just the
// handler's own pass-through of an already-constructed command.
describe('validateInboundMessage(CMD_READ_METRICS) — includeArchives threading (FR-014)', () => {
  it('keeps the discriminator guard aligned with the canonical includeArchives field', () => {
    expect(
      isCmdReadMetrics({
        type: CMD_READ_METRICS,
        correlationId: 'corr-guard',
        payload: { includeArchives: true }
      })
    ).toBe(true);
    expect(
      isCmdReadMetrics({
        type: CMD_READ_METRICS,
        correlationId: 'corr-guard-invalid',
        payload: { includeArchives: 'yes' }
      })
    ).toBe(false);
  });

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
