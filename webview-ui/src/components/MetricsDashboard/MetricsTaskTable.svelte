<script lang="ts">
  import type { PhaseRecord, TaskRecord } from '../../lib/messages';
  import { formatDuration } from '../../lib/format-duration';
  import { formatAbsoluteTime, formatPhaseLabel } from '../../lib/format';

  export type MetricsSortKey =
    | 'description'
    | 'startTime'
    | 'endTime'
    | 'durationMs'
    | 'phasesTotal'
    | 'totalCostUsd'
    | 'status';

  interface Props {
    tasks: readonly TaskRecord[];
    expandedRunIds: ReadonlySet<string>;
    currentPage: number;
    pageCount: number;
    ariaSort: (key: MetricsSortKey) => 'ascending' | 'descending' | 'none';
    onSort: (key: MetricsSortKey) => void;
    onExpandToggleClick: (event: MouseEvent, runId: string) => void;
    onPageChange: (page: number) => void;
  }

  const {
    tasks,
    expandedRunIds,
    currentPage,
    pageCount,
    ariaSort,
    onSort,
    onExpandToggleClick,
    onPageChange
  }: Props = $props();

  function formatCost(value: number | undefined): string {
    return value === undefined ? 'Not recorded' : `$${value.toFixed(2)}`;
  }

  function formatPhaseOutcome(outcome: PhaseRecord['outcome']): string {
    switch (outcome) {
      case 'completed': return 'Completed';
      case 'failed': return 'Failed';
      case 'skipped': return 'Skipped';
      case 'jumped': return 'Jumped';
      case 'paused-at-breakpoint': return 'Breakpoint';
      default: return 'Running';
    }
  }

</script>

<div class="table-scroll">
  <table class="task-table" data-testid="metrics-task-table">
    <thead>
      <tr>
        <th class="expand-col"><span class="visually-hidden">Expand</span></th>
        <th aria-sort={ariaSort('description')}>
          <button type="button" class="sort-button" data-testid="metrics-sort-description" onclick={() => onSort('description')}>Description</button>
        </th>
        <th aria-sort={ariaSort('startTime')}>
          <button type="button" class="sort-button" data-testid="metrics-sort-startTime" onclick={() => onSort('startTime')}>Start Time</button>
        </th>
        <th aria-sort={ariaSort('endTime')}>
          <button type="button" class="sort-button" data-testid="metrics-sort-endTime" onclick={() => onSort('endTime')}>End Time</button>
        </th>
        <th aria-sort={ariaSort('durationMs')}>
          <button type="button" class="sort-button" data-testid="metrics-sort-durationMs" onclick={() => onSort('durationMs')}>Duration</button>
        </th>
        <th aria-sort={ariaSort('phasesTotal')}>
          <button type="button" class="sort-button" data-testid="metrics-sort-phasesTotal" onclick={() => onSort('phasesTotal')}>Phases</button>
        </th>
        <th aria-sort={ariaSort('totalCostUsd')}>
          <button type="button" class="sort-button" data-testid="metrics-sort-totalCostUsd" onclick={() => onSort('totalCostUsd')}>Cost</button>
        </th>
        <th aria-sort={ariaSort('status')}>
          <button type="button" class="sort-button" data-testid="metrics-sort-status" onclick={() => onSort('status')}>Status</button>
        </th>
      </tr>
    </thead>
    <tbody>
      {#each tasks as task (task.runId)}
        {@const expanded = expandedRunIds.has(task.runId)}
        <tr
          class="task-row"
          class:expanded
          data-testid="metrics-task-row-{task.runId}"
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
                  <!-- Array-position identity avoids collisions after host display truncation. -->
                  {#each task.phases as phase, phaseIndex (phaseIndex)}
                    <tr data-testid="metrics-phase-row-{task.runId}-{phaseIndex}">
                      <td>{formatPhaseLabel(phase.phaseType)} <span class="iteration-tag">#{phase.iteration}</span></td>
                      <td>{formatAbsoluteTime(phase.startTime)}</td>
                      <td>{phase.endTime ? formatAbsoluteTime(phase.endTime) : '—'}</td>
                      <td>{phase.durationMs !== undefined ? formatDuration(phase.durationMs) : '—'}</td>
                      <td>{phase.backendInvocations}</td>
                      <td class:cost-not-recorded={phase.costUsd === undefined}>{formatCost(phase.costUsd)}</td>
                      <td><span class="badge outcome-{phase.outcome ?? 'running'}">{formatPhaseOutcome(phase.outcome)}</span></td>
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
      onclick={() => onPageChange(currentPage - 1)}
    >Prev</button>
    <span class="page-indicator">Page {currentPage + 1} of {pageCount}</span>
    <button
      type="button"
      data-testid="metrics-page-next"
      disabled={currentPage >= pageCount - 1}
      aria-label="Next page"
      onclick={() => onPageChange(currentPage + 1)}
    >Next</button>
  </div>
{/if}

<style>
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
  .table-scroll { overflow-x: auto; }
  .expand-col,
  .expand-cell { width: 1.5em; }
  .sort-button,
  .expand-toggle {
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .sort-button {
    font-weight: 600;
    padding: 0;
  }
  .expand-toggle { padding: 0 4px; }
  .task-row { cursor: default; }
  .task-row:hover { background: var(--schegent-list-hover); }
  .task-row.expanded { background: var(--schegent-list-active); }
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
  .status-completed,
  .outcome-completed { color: var(--schegent-color-completed); border-color: currentColor; }
  .status-failed,
  .outcome-failed { color: var(--schegent-error-text); border-color: currentColor; }
  .status-canceled,
  .outcome-skipped { color: var(--schegent-muted-fg); border-color: currentColor; }
  .status-running,
  .outcome-running { color: var(--schegent-color-active); border-color: currentColor; }
  .outcome-jumped,
  .outcome-paused-at-breakpoint { color: var(--schegent-color-warning); border-color: currentColor; }
  .phase-detail-row td {
    padding: 0 8px 8px calc(1.5em + 8px);
    border-bottom: 1px solid var(--schegent-divider);
  }
  .phase-table { font-size: 0.95em; }
  .iteration-tag,
  .page-indicator { color: var(--schegent-muted-fg); }
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
  .pagination button:disabled { opacity: 0.5; cursor: not-allowed; }
  .page-indicator { font-size: 0.9em; }
</style>
