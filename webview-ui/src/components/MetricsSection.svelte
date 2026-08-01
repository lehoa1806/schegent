<script lang="ts">
  import type { CostTimelinePoint, PhaseRecord, PhaseTypeAggregate, TaskRecord } from '../lib/messages';
  import { readMetrics } from '../lib/metrics-ipc';
  import { formatDuration } from '../lib/format-duration';
  import { formatAbsoluteTime, formatPhaseLabel } from '../lib/format';

  interface Props {
    active: boolean;
  }

  const { active }: Props = $props();

  const PAGE_SIZE = 200;
  const CHART_W = 640;
  const CHART_H = 180;
  const CHART_PAD = 12;

  type SortKey = 'description' | 'startTime' | 'endTime' | 'durationMs' | 'phasesTotal' | 'totalCostUsd' | 'status';

  let loading = $state(false);
  let loaded = $state(false);
  let tasks = $state<readonly TaskRecord[]>([]);
  let phaseTypeAggregates = $state<readonly PhaseTypeAggregate[]>([]);
  let costTimeline = $state<readonly CostTimelinePoint[]>([]);
  let oldestIncludedTimestamp = $state<string | undefined>(undefined);
  let includeArchived = $state(false);
  let sortKey = $state<SortKey>('startTime');
  let sortDir = $state<'asc' | 'desc'>('desc');
  let page = $state(0);
  let expandedRunIds = $state<ReadonlySet<string>>(new Set());
  let activePointIndex = $state<number | null>(null);

  async function fetchMetrics(): Promise<void> {
    loading = true;
    const result = await readMetrics({ includeArchived });
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
    if (active && !loaded && !loading) {
      void fetchMetrics();
    }
  });

  function onRefresh(): void {
    void fetchMetrics();
  }

  function onToggleArchived(): void {
    includeArchived = !includeArchived;
    void fetchMetrics();
  }

  function formatCost(value: number | undefined): string {
    return value === undefined ? 'Not recorded' : `$${value.toFixed(2)}`;
  }

  const totalTasksCompleted = $derived(tasks.filter((t) => t.status === 'completed').length);
  const totalElapsedMs = $derived(tasks.reduce((sum, t) => sum + t.durationMs, 0));
  const totalBackendInvocations = $derived(tasks.reduce((sum, t) => sum + t.totalBackendInvocations, 0));
  const totalCostUsd = $derived.by(() => {
    if (!tasks.some((t) => t.totalCostUsd !== undefined)) return undefined;
    return tasks.reduce((sum, t) => sum + (t.totalCostUsd ?? 0), 0);
  });

  function sortValue(task: TaskRecord, key: SortKey): string | number | undefined {
    switch (key) {
      case 'description':
        return task.description;
      case 'startTime':
        return Date.parse(task.startTime);
      case 'endTime':
        return task.endTime ? Date.parse(task.endTime) : undefined;
      case 'durationMs':
        return task.durationMs;
      case 'phasesTotal':
        return task.phasesTotal;
      case 'totalCostUsd':
        return task.totalCostUsd;
      case 'status':
        return task.status;
      default:
        return undefined;
    }
  }

  // Missing values always sort last regardless of direction — an in-progress
  // task or an unrecorded cost should never jump to the top of an ascending
  // sort just because `undefined` compares less than everything else.
  function compareTasks(a: TaskRecord, b: TaskRecord): number {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    if (av === bv) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    const dir = sortDir === 'asc' ? 1 : -1;
    return av < bv ? -dir : dir;
  }

  const sortedTasks = $derived.by(() => tasks.slice().sort(compareTasks));
  const pageCount = $derived(Math.max(1, Math.ceil(sortedTasks.length / PAGE_SIZE)));
  const currentPage = $derived(Math.min(page, pageCount - 1));
  const pagedTasks = $derived(sortedTasks.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE));

  function toggleSort(key: SortKey): void {
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = 'asc';
    }
    page = 0;
  }

  function ariaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
    if (sortKey !== key) return 'none';
    return sortDir === 'asc' ? 'ascending' : 'descending';
  }

  function goToPage(next: number): void {
    page = Math.max(0, Math.min(pageCount - 1, next));
  }

  function toggleExpand(runId: string): void {
    const next = new Set(expandedRunIds);
    if (next.has(runId)) {
      next.delete(runId);
    } else {
      next.add(runId);
    }
    expandedRunIds = next;
  }

  function onExpandToggleClick(event: MouseEvent, runId: string): void {
    // The row itself also toggles on click (mouse convenience) — stop the
    // bubble so this button press doesn't double-toggle back to closed.
    event.stopPropagation();
    toggleExpand(runId);
  }

  function formatPhaseOutcome(outcome: PhaseRecord['outcome']): string {
    switch (outcome) {
      case 'completed':
        return 'Completed';
      case 'failed':
        return 'Failed';
      case 'skipped':
        return 'Skipped';
      case 'jumped':
        return 'Jumped';
      case 'paused-at-breakpoint':
        return 'Breakpoint';
      default:
        return 'Running';
    }
  }

  function pointX(index: number, count: number): number {
    if (count <= 1) return CHART_W / 2;
    return CHART_PAD + (index / (count - 1)) * (CHART_W - 2 * CHART_PAD);
  }

  function pointY(value: number, max: number): number {
    const safeMax = max > 0 ? max : 1;
    return CHART_H - CHART_PAD - (value / safeMax) * (CHART_H - 2 * CHART_PAD);
  }

  const maxCumulativeCostUsd = $derived(
    costTimeline.length > 0 ? costTimeline[costTimeline.length - 1]!.cumulativeCostUsd : 0
  );

  const linePath = $derived.by(() =>
    costTimeline
      .map(
        (point, i) =>
          `${i === 0 ? 'M' : 'L'} ${pointX(i, costTimeline.length)} ${pointY(point.cumulativeCostUsd, maxCumulativeCostUsd)}`
      )
      .join(' ')
  );

  const areaPath = $derived.by(() => {
    if (costTimeline.length === 0) return '';
    const baseline = CHART_H - CHART_PAD;
    const lastX = pointX(costTimeline.length - 1, costTimeline.length);
    const firstX = pointX(0, costTimeline.length);
    return `${linePath} L ${lastX} ${baseline} L ${firstX} ${baseline} Z`;
  });

  const activePoint = $derived(activePointIndex !== null ? (costTimeline[activePointIndex] ?? null) : null);

  function setActivePoint(index: number | null): void {
    activePointIndex = index;
  }
</script>

<section class="metrics" aria-label="Metrics" data-testid="metrics-section">
  <div class="metrics-toolbar" data-testid="metrics-toolbar">
    <button
      type="button"
      class="metrics-action"
      data-testid="metrics-refresh"
      disabled={loading}
      onclick={onRefresh}
    >
      {loading ? 'Scanning…' : 'Refresh'}
    </button>
    <label class="metrics-archived-toggle">
      <input
        type="checkbox"
        data-testid="metrics-include-archived"
        checked={includeArchived}
        onchange={onToggleArchived}
      />
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
      No workflow runs recorded yet. Metrics populate automatically once a Schegent task runs — start one from the
      Active Queue tab to see data here.
    </p>
  {:else}
    <div class="summary-cards" data-testid="metrics-summary-cards">
      <div class="summary-card">
        <span class="summary-label">Tasks Completed</span>
        <span class="summary-value" data-testid="metrics-summary-tasks-completed">{totalTasksCompleted}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Total Elapsed</span>
        <span class="summary-value" data-testid="metrics-summary-elapsed">{formatDuration(totalElapsedMs)}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Total Cost</span>
        <span
          class="summary-value"
          class:cost-not-recorded={totalCostUsd === undefined}
          data-testid="metrics-summary-cost"
        >{formatCost(totalCostUsd)}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Backend Calls</span>
        <span class="summary-value" data-testid="metrics-summary-invocations">{totalBackendInvocations}</span>
      </div>
    </div>

    <div class="table-scroll">
      <table class="task-table" data-testid="metrics-task-table">
        <thead>
          <tr>
            <th class="expand-col"><span class="visually-hidden">Expand</span></th>
            <th aria-sort={ariaSort('description')}>
              <button type="button" class="sort-button" data-testid="metrics-sort-description" onclick={() => toggleSort('description')}>Description</button>
            </th>
            <th aria-sort={ariaSort('startTime')}>
              <button type="button" class="sort-button" data-testid="metrics-sort-startTime" onclick={() => toggleSort('startTime')}>Start Time</button>
            </th>
            <th aria-sort={ariaSort('endTime')}>
              <button type="button" class="sort-button" data-testid="metrics-sort-endTime" onclick={() => toggleSort('endTime')}>End Time</button>
            </th>
            <th aria-sort={ariaSort('durationMs')}>
              <button type="button" class="sort-button" data-testid="metrics-sort-durationMs" onclick={() => toggleSort('durationMs')}>Duration</button>
            </th>
            <th aria-sort={ariaSort('phasesTotal')}>
              <button type="button" class="sort-button" data-testid="metrics-sort-phasesTotal" onclick={() => toggleSort('phasesTotal')}>Phases</button>
            </th>
            <th aria-sort={ariaSort('totalCostUsd')}>
              <button type="button" class="sort-button" data-testid="metrics-sort-totalCostUsd" onclick={() => toggleSort('totalCostUsd')}>Cost</button>
            </th>
            <th aria-sort={ariaSort('status')}>
              <button type="button" class="sort-button" data-testid="metrics-sort-status" onclick={() => toggleSort('status')}>Status</button>
            </th>
          </tr>
        </thead>
        <tbody>
          {#each pagedTasks as task (task.runId)}
            {@const expanded = expandedRunIds.has(task.runId)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <tr
              class="task-row"
              class:expanded
              data-testid="metrics-task-row-{task.runId}"
              onclick={() => toggleExpand(task.runId)}
            >
              <td class="expand-cell">
                <button
                  type="button"
                  class="expand-toggle"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} phase detail for ${task.description}`}
                  data-testid="metrics-task-expand-{task.runId}"
                  onclick={(event) => onExpandToggleClick(event, task.runId)}
                >{expanded ? '▾' : '▸'}</button>
              </td>
              <td class="description-cell">
                {task.description}
                {#if task.source === 'phase-reconstruction'}
                  <span
                    class="badge reconstructed-badge"
                    title="Reconstructed from phase activity — no direct task record"
                  >Reconstructed</span>
                {/if}
              </td>
              <td>{formatAbsoluteTime(task.startTime)}</td>
              <td>{task.endTime ? formatAbsoluteTime(task.endTime) : '—'}</td>
              <td>{formatDuration(task.durationMs)}</td>
              <td>{task.phasesCompleted}/{task.phasesTotal}</td>
              <td class:cost-not-recorded={task.totalCostUsd === undefined}>{formatCost(task.totalCostUsd)}</td>
              <td>
                {#if task.isRunning}
                  <span class="badge status-running">Running</span>
                {:else}
                  <span class="badge status-{task.status}">{task.status}</span>
                {/if}
              </td>
            </tr>
            {#if expanded}
              <tr class="phase-detail-row">
                <td colspan="8">
                  <table class="phase-table" data-testid="metrics-phase-table-{task.runId}">
                    <thead>
                      <tr>
                        <th>Phase</th>
                        <th>Start Time</th>
                        <th>End Time</th>
                        <th>Duration</th>
                        <th>Backend Calls</th>
                        <th>Cost</th>
                        <th>Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      <!-- Keyed on array position, not phaseType+iteration: phaseType is
                           truncated for display (FR-017), so two distinct long phase-type
                           names in the same task can render identically, which would make
                           a content-derived key non-unique. task.phases is replaced
                           wholesale on every scan, so index identity is safe. -->
                      {#each task.phases as phase, phaseIndex (phaseIndex)}
                        <tr data-testid="metrics-phase-row-{task.runId}-{phaseIndex}">
                          <td>{formatPhaseLabel(phase.phaseType)} <span class="iteration-tag">#{phase.iteration}</span></td>
                          <td>{formatAbsoluteTime(phase.startTime)}</td>
                          <td>{phase.endTime ? formatAbsoluteTime(phase.endTime) : '—'}</td>
                          <td>{phase.durationMs !== undefined ? formatDuration(phase.durationMs) : '—'}</td>
                          <td>{phase.backendInvocations}</td>
                          <td class:cost-not-recorded={phase.costUsd === undefined}>{formatCost(phase.costUsd)}</td>
                          <td>
                            <span class="badge outcome-{phase.outcome ?? 'running'}">{formatPhaseOutcome(phase.outcome)}</span>
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>

    {#if pageCount > 1}
      <div class="pagination" data-testid="metrics-pagination">
        <button
          type="button"
          data-testid="metrics-page-prev"
          disabled={currentPage === 0}
          aria-label="Previous page"
          onclick={() => goToPage(currentPage - 1)}
        >Prev</button>
        <span class="page-indicator">Page {currentPage + 1} of {pageCount}</span>
        <button
          type="button"
          data-testid="metrics-page-next"
          disabled={currentPage >= pageCount - 1}
          aria-label="Next page"
          onclick={() => goToPage(currentPage + 1)}
        >Next</button>
      </div>
    {/if}

    <section class="phase-analytics" aria-label="Phase analytics" data-testid="metrics-phase-analytics">
      <h2 class="section-title">Phase Analytics</h2>
      {#if phaseTypeAggregates.length === 0}
        <p class="empty" data-testid="metrics-phase-analytics-empty">No phase executions recorded yet.</p>
      {:else}
        <div class="table-scroll">
          <table class="phase-analytics-table" data-testid="metrics-phase-analytics-table">
            <thead>
              <tr>
                <th>Phase Type</th>
                <th>Executions</th>
                <th>Total Duration</th>
                <th>Avg Duration</th>
                <th>p50</th>
                <th>p90</th>
                <th>p99</th>
                <th>Longest</th>
                <th>Shortest</th>
                <th>Backend Calls</th>
                <th>Total Cost</th>
              </tr>
            </thead>
            <tbody>
              {#each phaseTypeAggregates as agg (agg.phaseType)}
                <tr data-testid="metrics-phase-analytics-row-{agg.phaseType}">
                  <td>{formatPhaseLabel(agg.phaseType)}</td>
                  <td>{agg.executionCount}</td>
                  <td>{formatDuration(agg.totalDurationMs)}</td>
                  <td>{formatDuration(agg.avgDurationMs)}</td>
                  <td>{formatDuration(agg.p50DurationMs)}</td>
                  <td>{formatDuration(agg.p90DurationMs)}</td>
                  <td>{formatDuration(agg.p99DurationMs)}</td>
                  <td>{formatDuration(agg.longestDurationMs)}</td>
                  <td>{formatDuration(agg.shortestDurationMs)}</td>
                  <td>{agg.totalBackendInvocations}</td>
                  <td class:cost-not-recorded={agg.totalCostUsd === undefined}>{formatCost(agg.totalCostUsd)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class="cost-trend" aria-label="Cost trend" data-testid="metrics-cost-trend">
      <h2 class="section-title">Cost Trend</h2>
      {#if costTimeline.length === 0}
        <p class="empty" data-testid="metrics-cost-trend-empty">No cost data available.</p>
      {:else}
        <svg
          class="cost-trend-svg"
          viewBox="0 0 {CHART_W} {CHART_H}"
          role="group"
          aria-label="Cumulative cost trend over time"
          data-testid="metrics-cost-trend-svg"
        >
          <path class="area" d={areaPath}></path>
          <path class="line" d={linePath}></path>
          {#each costTimeline as point, i (point.date)}
            <circle
              class="point"
              class:active={activePointIndex === i}
              cx={pointX(i, costTimeline.length)}
              cy={pointY(point.cumulativeCostUsd, maxCumulativeCostUsd)}
              r={activePointIndex === i ? 4 : 3}
              tabindex="0"
              role="button"
              aria-label={`${point.date}: daily ${formatCost(point.dailyCostUsd)}, cumulative ${formatCost(point.cumulativeCostUsd)}`}
              data-testid="metrics-cost-trend-point-{point.date}"
              onmouseenter={() => setActivePoint(i)}
              onmouseleave={() => setActivePoint(null)}
              onfocus={() => setActivePoint(i)}
              onblur={() => setActivePoint(null)}
            ><title>{point.date}: {formatCost(point.dailyCostUsd)} (cumulative {formatCost(point.cumulativeCostUsd)})</title></circle>
          {/each}
        </svg>
        <p class="cost-trend-detail" data-testid="metrics-cost-trend-detail" aria-live="polite">
          {#if activePoint}
            {activePoint.date}: daily {formatCost(activePoint.dailyCostUsd)}, cumulative {formatCost(activePoint.cumulativeCostUsd)}
          {:else}
            Hover or focus a point on the chart for exact values.
          {/if}
        </p>
      {/if}
    </section>
  {/if}
</section>

<style>
  .metrics {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-gap);
    padding: 0;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .status-line,
  .empty {
    color: var(--schegent-muted-fg);
    font-style: italic;
    margin: 0;
  }
  .metrics-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--schegent-gap);
  }
  .metrics-action {
    background: var(--schegent-button-secondary-bg);
    color: var(--schegent-button-secondary-fg);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    padding: 4px 10px;
    cursor: pointer;
  }
  .metrics-action:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .metrics-archived-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--schegent-muted-fg);
    font-size: 0.9em;
  }
  .coverage-window {
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
    margin-left: auto;
  }

  .summary-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--schegent-gap);
  }
  .summary-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--schegent-pad);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    background: var(--sch-glass-bg);
    box-shadow: var(--sch-card-shadow);
  }
  .summary-label {
    color: var(--schegent-muted-fg);
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .summary-value {
    font-size: 1.3em;
    font-weight: 600;
  }
  .cost-not-recorded {
    color: var(--schegent-muted-fg);
    font-style: italic;
    font-weight: normal;
  }

  .table-scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9em;
  }
  th,
  td {
    padding: 6px 8px;
    text-align: left;
    border-bottom: 1px solid var(--schegent-divider);
    white-space: nowrap;
  }
  .expand-col {
    width: 1.5em;
  }
  .sort-button {
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    font-weight: 600;
    padding: 0;
    cursor: pointer;
  }
  .task-row {
    cursor: pointer;
  }
  .task-row:hover {
    background: var(--schegent-list-hover);
  }
  .task-row.expanded {
    background: var(--schegent-list-active);
  }
  .expand-cell {
    width: 1.5em;
  }
  .expand-toggle {
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 0 4px;
  }
  .description-cell {
    white-space: normal;
    word-break: break-word;
  }
  .badge {
    display: inline-block;
    border: 1px solid var(--schegent-border);
    border-radius: 999px;
    padding: 0 6px;
    font-size: 0.85em;
  }
  .reconstructed-badge {
    margin-left: 6px;
    color: var(--schegent-color-disabled);
    border-color: currentColor;
  }
  .status-completed {
    color: var(--schegent-color-completed);
    border-color: currentColor;
  }
  .status-failed {
    color: var(--schegent-color-error);
    border-color: currentColor;
  }
  .status-canceled {
    color: var(--schegent-muted-fg);
    border-color: currentColor;
  }
  .status-running {
    color: var(--schegent-color-active);
    border-color: currentColor;
  }
  .outcome-completed {
    color: var(--schegent-color-completed);
    border-color: currentColor;
  }
  .outcome-failed {
    color: var(--schegent-color-error);
    border-color: currentColor;
  }
  .outcome-skipped {
    color: var(--schegent-muted-fg);
    border-color: currentColor;
  }
  .outcome-jumped {
    color: var(--schegent-color-warning);
    border-color: currentColor;
  }
  .outcome-paused-at-breakpoint {
    color: var(--schegent-color-warning);
    border-color: currentColor;
  }
  .outcome-running {
    color: var(--schegent-color-active);
    border-color: currentColor;
  }

  .phase-detail-row td {
    padding: 0 8px 8px calc(1.5em + 8px);
    border-bottom: 1px solid var(--schegent-divider);
  }
  .phase-table {
    font-size: 0.95em;
  }
  .iteration-tag {
    color: var(--schegent-muted-fg);
  }

  .pagination {
    display: flex;
    align-items: center;
    gap: var(--schegent-gap);
  }
  .pagination button {
    background: var(--schegent-button-secondary-bg);
    color: var(--schegent-button-secondary-fg);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    padding: 2px 8px;
    cursor: pointer;
  }
  .pagination button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .page-indicator {
    color: var(--schegent-muted-fg);
    font-size: 0.9em;
  }

  .section-title {
    font-size: 1em;
    font-weight: 600;
    margin: 0 0 8px 0;
  }

  .cost-trend-svg {
    width: 100%;
    height: 180px;
  }
  .cost-trend-svg .area {
    fill: color-mix(in srgb, var(--schegent-color-active) 18%, transparent);
    stroke: none;
  }
  .cost-trend-svg .line {
    fill: none;
    stroke: var(--schegent-color-active);
    stroke-width: 2;
  }
  .cost-trend-svg .point {
    fill: var(--schegent-color-active);
    cursor: pointer;
  }
  .cost-trend-svg .point.active {
    fill: var(--schegent-fg);
  }
  .cost-trend-detail {
    margin: 4px 0 0 0;
    color: var(--schegent-muted-fg);
    font-size: 0.9em;
  }
</style>
