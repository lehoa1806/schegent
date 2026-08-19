// Feature 073 (code-review MAJOR 5) — MetricsSection had zero test coverage.
// Covers the load lifecycle, empty/loaded states, summary derivations,
// sorting, pagination, expand/collapse, refresh, the include-archived
// toggle, and the phase-analytics / cost-trend sub-sections.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import type {
  CostTimelinePoint,
  CumulativeTotals,
  MetricsCoverage,
  PhaseRecord,
  PhaseTypeAggregate,
  ReadMetricsResponse,
  TaskRecord
} from '../../lib/messages';

const readMetricsSpy = vi.fn<(req: unknown) => Promise<{ outcome: 'success' } & ReadMetricsResponse>>();
vi.mock('../../lib/metrics-ipc', () => ({
  readMetrics: (req: unknown) => readMetricsSpy(req)
}));

// Late import after the vi.mock above so the component picks up the mocked
// metrics-ipc surface.
import MetricsDashboard from '../MetricsDashboard/MetricsDashboard.svelte';

const BASE_MS = Date.parse('2026-05-10T12:00:00.000Z');

function phase(overrides: Partial<PhaseRecord> = {}): PhaseRecord {
  return Object.freeze({
    runId: 'run-1',
    phaseType: 'speckit-plan',
    iteration: 1,
    startTime: new Date(BASE_MS).toISOString(),
    endTime: new Date(BASE_MS + 60_000).toISOString(),
    durationMs: 60_000,
    backendInvocations: 2,
    costUsd: 0.12,
    outcome: 'completed',
    ...overrides
  });
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return Object.freeze({
    runId: 'run-1',
    taskId: 'run-1',
    description: 'add feature X',
    startTime: new Date(BASE_MS).toISOString(),
    endTime: new Date(BASE_MS + 300_000).toISOString(),
    durationMs: 300_000,
    status: 'completed',
    isRunning: false,
    phasesTotal: 1,
    phasesCompleted: 1,
    phasesSkipped: 0,
    totalCostUsd: 0.12,
    totalBackendInvocations: 2,
    phases: [phase()],
    source: 'task-lifecycle',
    ...overrides
  });
}

function aggregate(overrides: Partial<PhaseTypeAggregate> = {}): PhaseTypeAggregate {
  return Object.freeze({
    phaseType: 'speckit-plan',
    executionCount: 1,
    totalDurationMs: 60_000,
    avgDurationMs: 60_000,
    p50DurationMs: 60_000,
    p90DurationMs: 60_000,
    p99DurationMs: 60_000,
    longestDurationMs: 60_000,
    shortestDurationMs: 60_000,
    totalBackendInvocations: 2,
    totalCostUsd: 0.12,
    ...overrides
  });
}

function costPoint(overrides: Partial<CostTimelinePoint> = {}): CostTimelinePoint {
  return Object.freeze({
    date: '2026-05-10',
    dailyCostUsd: 0.12,
    cumulativeCostUsd: 0.12,
    ...overrides
  });
}

// FR-R3-009 — the wire response now carries durable cumulative totals and two
// coverage windows. The default fixture is the pre-rollup shape (nothing durable
// recorded yet) so existing assertions keep testing the fold-derived detail.
const EMPTY_CUMULATIVE: CumulativeTotals = Object.freeze({
  runs: 0,
  completedRuns: 0,
  failedRuns: 0,
  canceledRuns: 0,
  durationMs: 0,
  costUsd: 0,
  costUsdIsPartial: false,
  phasesTotal: 0,
  phasesCompleted: 0,
  phasesSkipped: 0,
  backendInvocations: 0
});

function coverage(overrides: {
  totals?: Partial<MetricsCoverage['totals']>;
  detail?: Partial<MetricsCoverage['detail']>;
} = {}): MetricsCoverage {
  return {
    totals: { available: false, runs: 0, ...overrides.totals },
    detail: { includesArchives: false, ...overrides.detail }
  };
}

function successResult(overrides: Partial<ReadMetricsResponse> = {}): { outcome: 'success' } & ReadMetricsResponse {
  return {
    outcome: 'success',
    tasks: [],
    phaseTypeAggregates: [],
    costTimeline: [],
    oldestIncludedTimestamp: undefined,
    cumulative: EMPTY_CUMULATIVE,
    coverage: coverage(),
    meta: {
      includesArchives: false,
      totalScannedEntries: 0,
      parseWarnings: 0
    },
    ...overrides
  };
}

beforeEach(() => {
  readMetricsSpy.mockReset();
  readMetricsSpy.mockResolvedValue(successResult());
});
afterEach(() => cleanup());

describe('MetricsDashboard', () => {
  it('does not fetch when inactive', async () => {
    render(MetricsDashboard, { props: { active: false } });
    await tick();
    await tick();
    expect(readMetricsSpy).not.toHaveBeenCalled();
  });

  it('fetches once activated, shows the loading state until the request resolves', async () => {
    let resolveFetch: (r: { outcome: 'success' } & ReadMetricsResponse) => void = () => {};
    readMetricsSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    );

    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();

    expect(readMetricsSpy).toHaveBeenCalledWith({ includeArchives: false });
    expect(getByTestId('metrics-loading')).not.toBeNull();

    resolveFetch(successResult());
    await tick();
    await tick();
    expect(getByTestId('metrics-empty')).not.toBeNull();
  });

  it('renders the empty state when there are no tasks', async () => {
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();
    expect(getByTestId('metrics-empty')).not.toBeNull();
  });

  it('renders summary cards derived from the fetched tasks', async () => {
    readMetricsSpy.mockResolvedValue(
      successResult({
        tasks: [
          task({ runId: 'run-1', status: 'completed', durationMs: 100_000, totalCostUsd: 0.5, totalBackendInvocations: 3 }),
          task({ runId: 'run-2', status: 'failed', durationMs: 50_000, totalCostUsd: 0.25, totalBackendInvocations: 2 })
        ]
      })
    );
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();

    const summary = getByTestId('metrics-summary-cards');
    expect(summary.tagName).toBe('DL');
    expect(summary.getAttribute('aria-label')).toBe('Retained run detail totals');
    expect(summary.querySelectorAll('.summary-card')).toHaveLength(0);
    expect(getByTestId('metrics-summary-tasks-completed').textContent).toBe('1');
    expect(getByTestId('metrics-summary-invocations').textContent).toBe('5');
    expect(getByTestId('metrics-summary-cost').textContent).toBe('$0.75');
    expect(getByTestId('metrics-summary-elapsed').textContent).toMatch(/2m\s+30s/);
  });

  it('shows "Not recorded" for total cost when no task has a recorded cost', async () => {
    readMetricsSpy.mockResolvedValue(successResult({ tasks: [task({ totalCostUsd: undefined })] }));
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();
    expect(getByTestId('metrics-summary-cost').textContent).toBe('Not recorded');
  });

  it('sorts the task table by column on header click, toggling direction on repeat click', async () => {
    readMetricsSpy.mockResolvedValue(
      successResult({
        tasks: [
          task({ runId: 'run-a', description: 'bbb' }),
          task({ runId: 'run-b', description: 'aaa' })
        ]
      })
    );
    const { getByTestId, container } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();

    const rowOrder = (): (string | null)[] =>
      Array.from(container.querySelectorAll('[data-testid^="metrics-task-row-"]')).map((el) =>
        el.getAttribute('data-testid')
      );

    await fireEvent.click(getByTestId('metrics-sort-description'));
    await tick();
    expect(rowOrder()).toEqual(['metrics-task-row-run-b', 'metrics-task-row-run-a']);

    await fireEvent.click(getByTestId('metrics-sort-description'));
    await tick();
    expect(rowOrder()).toEqual(['metrics-task-row-run-a', 'metrics-task-row-run-b']);
  });

  it('expands and collapses phase detail from the explicit expand button', async () => {
    readMetricsSpy.mockResolvedValue(successResult({ tasks: [task({ runId: 'run-1' })] }));
    const { getByTestId, queryByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();

    expect(queryByTestId('metrics-phase-table-run-1')).toBeNull();

    const row = getByTestId('metrics-task-row-run-1');
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('tabindex')).toBeNull();
    await fireEvent.click(getByTestId('metrics-task-expand-run-1'));
    await tick();
    expect(getByTestId('metrics-phase-table-run-1')).not.toBeNull();

    await fireEvent.click(getByTestId('metrics-task-expand-run-1'));
    await tick();
    expect(queryByTestId('metrics-phase-table-run-1')).toBeNull();
  });

  it('renders both phase rows without a duplicate-key crash when two phases share the same (phaseType, iteration) pair', async () => {
    // Regression: phaseType is truncated for display (FR-017) before it
    // reaches the webview, so two distinct long phase-type names in the
    // same task/iteration can arrive here already collapsed to an
    // identical string — the each-block must not key on phaseType+iteration.
    const collidedType = `${'x'.repeat(297)}...`;
    const phaseA = phase({ phaseType: collidedType, iteration: 1, outcome: 'completed' });
    const phaseB = phase({
      phaseType: collidedType,
      iteration: 1,
      outcome: 'failed',
      startTime: new Date(BASE_MS + 60_000).toISOString(),
      endTime: new Date(BASE_MS + 120_000).toISOString()
    });
    readMetricsSpy.mockResolvedValue(
      successResult({
        tasks: [task({ runId: 'run-1', phases: [phaseA, phaseB], phasesTotal: 2, phasesCompleted: 1 })]
      })
    );
    const { getByTestId, container } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();

    await fireEvent.click(getByTestId('metrics-task-expand-run-1'));
    await tick();

    const rows = container.querySelectorAll('[data-testid^="metrics-phase-row-run-1-"]');
    expect(rows.length).toBe(2);
  });

  it('paginates when task count exceeds the page size', async () => {
    const tasks = Array.from({ length: 201 }, (_, i) =>
      task({ runId: `run-${i}`, startTime: new Date(BASE_MS + i * 1000).toISOString() })
    );
    readMetricsSpy.mockResolvedValue(successResult({ tasks }));
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();

    expect(getByTestId('metrics-pagination')).not.toBeNull();
    const prevBtn = getByTestId('metrics-page-prev') as HTMLButtonElement;
    const nextBtn = getByTestId('metrics-page-next') as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(false);

    await fireEvent.click(nextBtn);
    await tick();
    expect(prevBtn.disabled).toBe(false);
    expect(nextBtn.disabled).toBe(true);
  });

  it('the refresh button re-invokes readMetrics', async () => {
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();
    expect(readMetricsSpy).toHaveBeenCalledTimes(1);

    await fireEvent.click(getByTestId('metrics-refresh'));
    await tick();
    await tick();
    expect(readMetricsSpy).toHaveBeenCalledTimes(2);
  });

  it('toggling include-archived re-fetches with includeArchived: true and shows the coverage window', async () => {
    readMetricsSpy.mockResolvedValueOnce(successResult());
    readMetricsSpy.mockResolvedValueOnce(
      successResult({ meta: { includesArchives: true, totalScannedEntries: 0, parseWarnings: 0 }, oldestIncludedTimestamp: '2026-01-01T00:00:00.000Z' })
    );
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();

    await fireEvent.click(getByTestId('metrics-include-archived'));
    await tick();
    await tick();

    expect(readMetricsSpy).toHaveBeenLastCalledWith({ includeArchives: true });
    expect(getByTestId('metrics-coverage-window')).not.toBeNull();
  });

  it('renders phase analytics rows when aggregates are present', async () => {
    readMetricsSpy.mockResolvedValue(
      successResult({ tasks: [task()], phaseTypeAggregates: [aggregate({ phaseType: 'speckit-plan' })] })
    );
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();
    expect(getByTestId('metrics-phase-analytics-row-speckit-plan')).not.toBeNull();
  });

  it('shows the phase-analytics empty state when there are tasks but no aggregates', async () => {
    readMetricsSpy.mockResolvedValue(successResult({ tasks: [task()], phaseTypeAggregates: [] }));
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();
    expect(getByTestId('metrics-phase-analytics-empty')).not.toBeNull();
  });

  it('renders the cost trend chart when cost timeline data is present', async () => {
    readMetricsSpy.mockResolvedValue(
      successResult({
        tasks: [task()],
        costTimeline: [costPoint({ date: '2026-05-10' }), costPoint({ date: '2026-05-11', cumulativeCostUsd: 0.24 })]
      })
    );
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();
    expect(getByTestId('metrics-cost-trend-svg')).not.toBeNull();
    expect(getByTestId('metrics-cost-trend-point-2026-05-10')).not.toBeNull();
  });

  it('shows the cost-trend empty state when there is no cost timeline data', async () => {
    readMetricsSpy.mockResolvedValue(successResult({ tasks: [task()], costTimeline: [] }));
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();
    expect(getByTestId('metrics-cost-trend-empty')).not.toBeNull();
  });

  it('marks phase-reconstruction tasks with the "Reconstructed" badge', async () => {
    readMetricsSpy.mockResolvedValue(successResult({ tasks: [task({ runId: 'run-r', source: 'phase-reconstruction' })] }));
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();
    expect(getByTestId('metrics-task-row-run-r').textContent).toContain('Reconstructed');
  });
});

// FR-R3-009 T396 — the two coverage windows are rendered separately. The totals
// window describes the durable rollup's range; the detail window describes the
// audit corpus the per-run sections were folded from, and is narrower whenever
// retention has pruned anything.
describe('MetricsDashboard — coverage windows for totals and detail (FR-R3-009, T396)', () => {
  it('renders the rollup-backed totals with their own window, distinct from the detail window', async () => {
    readMetricsSpy.mockResolvedValue(
      successResult({
        tasks: [task({ runId: 'run-1' })],
        oldestIncludedTimestamp: '2026-05-01T00:00:00.000Z',
        cumulative: {
          ...EMPTY_CUMULATIVE,
          runs: 40,
          completedRuns: 38,
          failedRuns: 2,
          durationMs: 4_000_000,
          costUsd: 12.5,
          backendInvocations: 190
        },
        coverage: coverage({
          totals: { available: true, runs: 40, earliest: '2026-01-01T00:00:00.000Z' },
          detail: { earliest: '2026-05-01T00:00:00.000Z', includesArchives: false }
        })
      })
    );
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();

    expect(getByTestId('metrics-cumulative-runs').textContent).toBe('40');
    expect(getByTestId('metrics-cumulative-completed').textContent).toBe('38');
    expect(getByTestId('metrics-cumulative-failed').textContent).toBe('2');
    expect(getByTestId('metrics-cumulative-cost').textContent).toBe('$12.50');
    expect(getByTestId('metrics-cumulative-invocations').textContent).toBe('190');

    const totalsWindow = getByTestId('metrics-totals-coverage-window').textContent ?? '';
    const detailWindow = getByTestId('metrics-coverage-window').textContent ?? '';
    expect(totalsWindow).toContain('40 runs');
    expect(totalsWindow).toContain('2026');
    expect(detailWindow).toContain('Run detail since');
    expect(detailWindow).toContain('live log only');
    expect(totalsWindow).not.toBe(detailWindow);
  });

  it('marks a partial cumulative cost as a floor rather than an exact total', async () => {
    readMetricsSpy.mockResolvedValue(
      successResult({
        tasks: [task()],
        cumulative: { ...EMPTY_CUMULATIVE, runs: 3, costUsd: 1.25, costUsdIsPartial: true },
        coverage: coverage({ totals: { available: true, runs: 3 } })
      })
    );
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();
    expect(getByTestId('metrics-cumulative-cost').textContent).toBe('$1.25+');
  });

  it('says so plainly when no durable rollup has been recorded yet', async () => {
    readMetricsSpy.mockResolvedValue(
      successResult({
        tasks: [task()],
        cumulative: { ...EMPTY_CUMULATIVE, runs: 1, completedRuns: 1 },
        coverage: coverage({ totals: { available: false, runs: 0 } })
      })
    );
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();
    expect(getByTestId('metrics-totals-coverage-window').textContent).toContain(
      'No durable rollup recorded yet'
    );
  });

  it('keeps cumulative totals visible when retention has pruned every run detail', async () => {
    readMetricsSpy.mockResolvedValue(
      successResult({
        tasks: [],
        cumulative: { ...EMPTY_CUMULATIVE, runs: 12, completedRuns: 12 },
        coverage: coverage({ totals: { available: true, runs: 12, earliest: '2026-01-01T00:00:00.000Z' } })
      })
    );
    const { getByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();

    expect(getByTestId('metrics-cumulative-runs').textContent).toBe('12');
    expect(getByTestId('metrics-empty').textContent).toContain('pruned by retention');
  });

  it('does not render a cumulative strip before the first response lands', async () => {
    readMetricsSpy.mockImplementation(() => new Promise(() => {}));
    const { queryByTestId } = render(MetricsDashboard, { props: { active: true } });
    await tick();
    await tick();
    expect(queryByTestId('metrics-cumulative')).toBeNull();
    expect(queryByTestId('metrics-coverage-window')).toBeNull();
  });
});
