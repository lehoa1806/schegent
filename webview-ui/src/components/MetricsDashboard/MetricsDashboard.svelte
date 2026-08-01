<script lang="ts">
  import type { CostTimelinePoint, PhaseTypeAggregate, TaskRecord } from '../../lib/messages';
  import { readMetrics } from '../../lib/metrics-ipc';
  import { formatAbsoluteTime } from '../../lib/format';
  import './metrics-shared.css';
  import MetricsSummary from './MetricsSummary.svelte';
  import MetricsTaskTable, { type MetricsSortKey } from './MetricsTaskTable.svelte';
  import MetricsPhaseAnalytics from './MetricsPhaseAnalytics.svelte';
  import MetricsCostChart from './MetricsCostChart.svelte';

  interface Props { active: boolean }
  const { active }: Props = $props();
  const PAGE_SIZE = 200;

  let loading = $state(false);
  let loaded = $state(false);
  let tasks = $state<readonly TaskRecord[]>([]);
  let phaseTypeAggregates = $state<readonly PhaseTypeAggregate[]>([]);
  let costTimeline = $state<readonly CostTimelinePoint[]>([]);
  let oldestIncludedTimestamp = $state<string | undefined>(undefined);
  let includeArchives = $state(false);
  let sortKey = $state<MetricsSortKey>('startTime');
  let sortDir = $state<'asc' | 'desc'>('desc');
  let page = $state(0);
  let expandedRunIds = $state<ReadonlySet<string>>(new Set());
  let activePointIndex = $state<number | null>(null);

  async function fetchMetrics(): Promise<void> {
    loading = true;
    const result = await readMetrics({ includeArchives });
    loading = false;
    loaded = true;
    if (result.outcome !== 'success') return;
    tasks = result.tasks;
    phaseTypeAggregates = result.phaseTypeAggregates;
    costTimeline = result.costTimeline;
    oldestIncludedTimestamp = result.oldestIncludedTimestamp;
    page = 0;
  }

  $effect(() => {
    if (active && !loaded && !loading) void fetchMetrics();
  });

  const totalTasksCompleted = $derived(tasks.filter((task) => task.status === 'completed').length);
  const totalElapsedMs = $derived(tasks.reduce((sum, task) => sum + task.durationMs, 0));
  const totalBackendInvocations = $derived(
    tasks.reduce((sum, task) => sum + task.totalBackendInvocations, 0)
  );
  const totalCostUsd = $derived.by(() => {
    if (!tasks.some((task) => task.totalCostUsd !== undefined)) return undefined;
    return tasks.reduce((sum, task) => sum + (task.totalCostUsd ?? 0), 0);
  });

  function sortValue(task: TaskRecord, key: MetricsSortKey): string | number | undefined {
    switch (key) {
      case 'description': return task.description;
      case 'startTime': return Date.parse(task.startTime);
      case 'endTime': return task.endTime ? Date.parse(task.endTime) : undefined;
      case 'durationMs': return task.durationMs;
      case 'phasesTotal': return task.phasesTotal;
      case 'totalCostUsd': return task.totalCostUsd;
      case 'status': return task.status;
    }
  }

  function compareTasks(a: TaskRecord, b: TaskRecord): number {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    if (av === bv) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    const direction = sortDir === 'asc' ? 1 : -1;
    return av < bv ? -direction : direction;
  }

  const sortedTasks = $derived.by(() => tasks.slice().sort(compareTasks));
  const pageCount = $derived(Math.max(1, Math.ceil(sortedTasks.length / PAGE_SIZE)));
  const currentPage = $derived(Math.min(page, pageCount - 1));
  const pagedTasks = $derived(
    sortedTasks.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  );

  function toggleSort(key: MetricsSortKey): void {
    if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortKey = key; sortDir = 'asc'; }
    page = 0;
  }

  function ariaSort(key: MetricsSortKey): 'ascending' | 'descending' | 'none' {
    if (sortKey !== key) return 'none';
    return sortDir === 'asc' ? 'ascending' : 'descending';
  }

  function goToPage(next: number): void {
    page = Math.max(0, Math.min(pageCount - 1, next));
  }

  function toggleExpand(runId: string): void {
    const next = new Set(expandedRunIds);
    if (next.has(runId)) next.delete(runId);
    else next.add(runId);
    expandedRunIds = next;
  }

  function onExpandToggleClick(event: MouseEvent, runId: string): void {
    event.stopPropagation();
    toggleExpand(runId);
  }
</script>

<section class="metrics" aria-label="Metrics" data-testid="metrics-section">
  <div class="metrics-toolbar" data-testid="metrics-toolbar">
    <button type="button" class="metrics-action" data-testid="metrics-refresh"
      disabled={loading} onclick={() => void fetchMetrics()}>
      {loading ? 'Scanning…' : 'Refresh'}
    </button>
    <label class="metrics-archived-toggle">
      <input type="checkbox" data-testid="metrics-include-archived"
        checked={includeArchives} onchange={() => { includeArchives = !includeArchives; void fetchMetrics(); }} />
      Include archived history
    </label>
    {#if oldestIncludedTimestamp}
      <span class="coverage-window" data-testid="metrics-coverage-window">
        Since {formatAbsoluteTime(oldestIncludedTimestamp)}
      </span>
    {/if}
  </div>

  {#if !loaded}
    <p class="status-line" data-testid="metrics-loading">Scanning audit history…</p>
  {:else if tasks.length === 0}
    <p class="empty" data-testid="metrics-empty">
      No workflow runs recorded yet. Metrics populate automatically once a Schegent task runs — start one from the Active Queue tab to see data here.
    </p>
  {:else}
    <MetricsSummary tasksCompleted={totalTasksCompleted} elapsedMs={totalElapsedMs}
      {totalCostUsd} backendInvocations={totalBackendInvocations} />
    <MetricsTaskTable tasks={pagedTasks} {expandedRunIds} {currentPage} {pageCount}
      {ariaSort} onSort={toggleSort} onToggleExpand={toggleExpand}
      {onExpandToggleClick} onPageChange={goToPage} />
    <MetricsPhaseAnalytics aggregates={phaseTypeAggregates} />
    <MetricsCostChart timeline={costTimeline} {activePointIndex}
      onActivePointChange={(index) => { activePointIndex = index; }} />
  {/if}
</section>

<style>
  .metrics {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--schegent-gap);
    box-sizing: border-box;
    padding: var(--schegent-pad);
    overflow-y: auto;
  }
  .status-line { margin: 0; color: var(--schegent-muted-fg); font-style: italic; }
  .metrics-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--schegent-gap); }
  .metrics-action {
    padding: 4px 10px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--schegent-button-secondary-bg);
    color: var(--schegent-button-secondary-fg);
    cursor: pointer;
  }
  .metrics-action:disabled { opacity: 0.6; cursor: not-allowed; }
  .metrics-archived-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--schegent-muted-fg);
    font-size: 0.9em;
  }
  .coverage-window { margin-left: auto; color: var(--schegent-muted-fg); font-size: 0.85em; }
</style>
