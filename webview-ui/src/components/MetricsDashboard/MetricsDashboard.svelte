<script lang="ts">
  import type {
    CostTimelinePoint,
    CumulativeTotals,
    MetricsCoverage,
    PhaseTypeAggregate,
    TaskRecord
  } from '../../lib/messages';
  import { readMetrics, type ReadMetricsResult } from '../../lib/metrics-ipc';
  import { formatAbsoluteTime } from '../../lib/format';
  import '../../lib/sg/sg-metrics.css';
  import './metrics-shared.css';
  import MetricsCumulativeTotals from './MetricsCumulativeTotals.svelte';
  import MetricsSummary from './MetricsSummary.svelte';
  import MetricsTaskTable, { type MetricsSortKey } from './MetricsTaskTable.svelte';
  import MetricsPhaseAnalytics from './MetricsPhaseAnalytics.svelte';
  import MetricsCostChart from './MetricsCostChart.svelte';
  import HistoricalReportsPanel from './HistoricalReportsPanel.svelte';

  interface Props { active: boolean }
  const { active }: Props = $props();
  const PAGE_SIZE = 200;

  type SurfaceMode = 'rollup' | 'reports';
  /** The tab order, which the arrow keys walk. */
  const SURFACE_MODES: readonly SurfaceMode[] = ['rollup', 'reports'];
  let surfaceMode = $state<SurfaceMode>('rollup');

  let loading = $state(false);
  // FR-R4-F05 (O1, O7) — the sentence for a refused read, or null. Only a refusal sets it:
  // a read that fails for any other reason keeps showing what it showed before.
  let refusal = $state<string | null>(null);
  let loaded = $state(false);
  let tasks = $state<readonly TaskRecord[]>([]);
  let phaseTypeAggregates = $state<readonly PhaseTypeAggregate[]>([]);
  let costTimeline = $state<readonly CostTimelinePoint[]>([]);
  let oldestIncludedTimestamp = $state<string | undefined>(undefined);
  // FR-R3-009 — the durable cumulative totals and the two coverage windows.
  // Undefined until the first response lands; the totals strip is not rendered
  // from a locally invented zero, because a zero shown as an all-time figure is
  // the defect this feature exists to remove.
  let cumulative = $state<CumulativeTotals | undefined>(undefined);
  let coverage = $state<MetricsCoverage | undefined>(undefined);
  let includeArchives = $state(false);
  let sortKey = $state<MetricsSortKey>('startTime');
  let sortDir = $state<'asc' | 'desc'>('desc');
  let page = $state(0);
  let expandedRunIds = $state<ReadonlySet<string>>(new Set());
  let activePointIndex = $state<number | null>(null);

  // FR-R4-F05 (I6, I8, FR-024) — a late answer replaces the not-yet-known text through the same
  // path as an on-time one; unmounting aborts the wait.
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());

  async function fetchMetrics(): Promise<void> {
    loading = true;
    const result = await readMetrics(
      { includeArchives },
      { signal: lifetime.signal, onLateOutcome: showMetrics }
    );
    loading = false;
    loaded = true;
    showMetrics(result);
  }

  function showMetrics(result: ReadMetricsResult): void {
    if (result.outcome !== 'success') {
      refusal = result.refusalText ?? null;
      return;
    }
    refusal = null;
    tasks = result.tasks;
    phaseTypeAggregates = result.phaseTypeAggregates;
    costTimeline = result.costTimeline;
    oldestIncludedTimestamp = result.oldestIncludedTimestamp;
    cumulative = result.cumulative;
    coverage = result.coverage;
    page = 0;
  }

  $effect(() => {
    if (active && !loaded && !loading) void fetchMetrics();
  });

  // The scope switch has two settings; pressing the one already set reads nothing.
  function setIncludeArchives(next: boolean): void {
    if (includeArchives === next) return;
    includeArchives = next;
    void fetchMetrics();
  }

  // Arrow keys move along the tabs, Home and End jump to either end, and focus
  // follows the selection.
  function onTabKeydown(event: KeyboardEvent): void {
    const current = SURFACE_MODES.indexOf(surfaceMode);
    let next: number;
    if (event.key === 'ArrowRight') next = (current + 1) % SURFACE_MODES.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + SURFACE_MODES.length) % SURFACE_MODES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = SURFACE_MODES.length - 1;
    else return;
    const mode = SURFACE_MODES.at(next);
    if (mode === undefined) return;
    event.preventDefault();
    surfaceMode = mode;
    queueMicrotask(() => document.getElementById(`metrics-tab-${mode}`)?.focus());
  }

  const totalTasksCompleted = $derived(tasks.filter((task) => task.status === 'completed').length);
  const totalElapsedMs = $derived(tasks.reduce((sum, task) => sum + task.durationMs, 0));
  const totalBackendInvocations = $derived(
    tasks.reduce((sum, task) => sum + task.totalBackendInvocations, 0)
  );
  const totalCostUsd = $derived.by(() => {
    if (!tasks.some((task) => task.totalCostUsd !== undefined)) return undefined;
    return tasks.reduce((sum, task) => sum + (task.totalCostUsd ?? 0), 0);
  });

  // FR-R3-009 T396 — the detail window is stated separately from the totals
  // window above it, and is narrower by construction: everything below the
  // totals strip is a fold over an audit corpus that retention prunes.
  const detailWindow = $derived.by(() => {
    const earliest = coverage?.detail.earliest ?? oldestIncludedTimestamp;
    const scope = (coverage?.detail.includesArchives ?? includeArchives)
      ? 'live log and archives'
      : 'live log only';
    if (earliest === undefined) return `Run detail: ${scope}`;
    return `Run detail since ${formatAbsoluteTime(earliest)} (${scope})`;
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

<main class="metrics" aria-label="Metrics" data-testid="metrics-section">
  <div class="page">
    <div class="phead">
      <div>
        <h1>Metrics</h1>
        <div class="purpose">Throughput, time and cost from the audit log.</div>
      </div>
    </div>

    {#if refusal !== null}
      <div class="attn warn metrics-refusal" role="status" data-testid="metrics-refusal">
        <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
        <p class="body small">{refusal}</p>
      </div>
    {/if}

    <div class="tabs" role="tablist" aria-label="Metrics views">
      <button type="button" role="tab" id="metrics-tab-rollup" class="tab"
        aria-selected={surfaceMode === 'rollup'} aria-controls="metrics-panel"
        tabindex={surfaceMode === 'rollup' ? 0 : -1} data-testid="metrics-mode-rollup"
        onkeydown={onTabKeydown} onclick={() => { surfaceMode = 'rollup'; }}>Overview</button>
      <button type="button" role="tab" id="metrics-tab-reports" class="tab"
        aria-selected={surfaceMode === 'reports'} aria-controls="metrics-panel"
        tabindex={surfaceMode === 'reports' ? 0 : -1} data-testid="metrics-mode-reports"
        onkeydown={onTabKeydown} onclick={() => { surfaceMode = 'reports'; }}>Reports</button>
    </div>

    <div role="tabpanel" id="metrics-panel" aria-labelledby="metrics-tab-{surfaceMode}">
      {#if surfaceMode === 'reports'}
        <HistoricalReportsPanel />
      {:else}
        <!-- Overview-only scope switch and refresh live inside the Overview tab toolbar so
             switching between Overview and Reports leaves the page header unchanged. -->
        <div class="toolbar metrics-toolbar" data-testid="metrics-toolbar">
          <div class="seg" role="group" aria-label="Run detail scope">
            <button type="button" aria-pressed={!includeArchives}
              onclick={() => setIncludeArchives(false)}>Live log</button>
            <button type="button" aria-pressed={includeArchives} data-testid="metrics-include-archived"
              onclick={() => setIncludeArchives(true)}>With archives</button>
          </div>
          <div class="push">
            <button type="button" class="icon-btn refresh" aria-label="Refresh metrics" title="Refresh"
              data-testid="metrics-refresh" disabled={loading} onclick={() => void fetchMetrics()}>
              <svg class="i" aria-hidden="true"><use href="#i-refresh"></use></svg>
            </button>
          </div>
        </div>
        {#if !loaded}
        <div class="metrics-loading" data-testid="metrics-loading" role="status">
          <span class="muted">Scanning audit history…</span>
          <div class="grid g4 metrics-skeleton" aria-hidden="true">
            <span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span>
          </div>
        </div>
        {:else}
        <!-- FR-R3-009 — cumulative totals stand above the log-derived detail and
             survive a retention prune, so they are rendered whenever the rollup has
             anything to report, including when the detail below is empty. -->
        {#if cumulative !== undefined && coverage !== undefined && (cumulative.runs > 0 || coverage.totals.available)}
          <MetricsCumulativeTotals {cumulative} {coverage} />
        {/if}

        <!-- Everything from here down is folded from the retained audit log, which
             retention prunes: the line says how far back it reaches. -->
        <div class="detail-head">
          <p class="small muted" data-testid="metrics-coverage-window">{detailWindow}</p>
          {#if tasks.length > 0}
            <MetricsSummary tasksCompleted={totalTasksCompleted} elapsedMs={totalElapsedMs}
              {totalCostUsd} backendInvocations={totalBackendInvocations} />
          {/if}
        </div>

        {#if tasks.length === 0}
          <p class="empty" data-testid="metrics-empty">
            {#if cumulative !== undefined && cumulative.runs > 0}
              Per-run detail for the runs counted above is no longer in the retained
              audit log. Cumulative totals remain available; the runs themselves have
              been pruned by retention.
            {:else}
              No Workflow runs recorded yet. Start a task from Queues to populate this view.
            {/if}
          </p>
        {:else}
          <MetricsCostChart timeline={costTimeline} {activePointIndex}
            onActivePointChange={(index) => { activePointIndex = index; }} />
          <MetricsPhaseAnalytics aggregates={phaseTypeAggregates} />
          <MetricsTaskTable tasks={pagedTasks} {expandedRunIds} {currentPage} {pageCount}
            {ariaSort} onSort={toggleSort}
            {onExpandToggleClick} onPageChange={goToPage} />
        {/if}
        {/if}
      {/if}
    </div>
  </div>
</main>

<style>
  /* The page scrolls inside the route, as on History. */
  .metrics {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .tabs { align-items: center; }
  .tab:hover { color: var(--schegent-fg); }
  .metrics-refusal { margin-bottom: var(--schegent-space-3); }
  .metrics-refusal .body { margin: 0; }
  /* Turns while a read is in flight, which is exactly while the button is disabled. */
  @media (prefers-reduced-motion: no-preference) {
    .refresh:disabled .i { animation: metrics-turn 0.9s linear infinite; }
  }
  @keyframes metrics-turn {
    to { transform: rotate(360deg); }
  }
  .metrics-loading {
    display: grid;
    gap: var(--schegent-space-3);
  }
  /* As tall as a loaded tile at any font size: its border and padding, the value's margins, and
     the label, value and context lines at the sheet's 1.45 line height. */
  .metrics-skeleton .tile {
    height: calc(
      2px + 2 * var(--schegent-space-3) + 2 * var(--schegent-space-0-5) +
        1.45 * (2 * var(--schegent-text-secondary) + var(--schegent-text-display))
    );
    box-sizing: border-box;
    background: var(--schegent-surface-subtle);
  }
  .detail-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--schegent-space-1) var(--schegent-space-4);
    margin-top: var(--schegent-space-4-5);
  }
  .detail-head p { margin: 0; }
  .page .empty {
    margin-top: var(--schegent-space-3);
  }
</style>
