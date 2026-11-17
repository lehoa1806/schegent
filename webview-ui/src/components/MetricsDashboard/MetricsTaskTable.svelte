<script lang="ts">
  import type { PhaseRecord, TaskRecord } from '../../lib/messages';
  import { formatDuration } from '../../lib/format-duration';
  import { formatAbsoluteTime, formatPhaseLabel } from '../../lib/format';
  import { runStatusChip } from '../../lib/run-status-chip';

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

  interface SortColumn {
    readonly key: MetricsSortKey;
    readonly label: string;
    readonly numeric: boolean;
  }

  // The order is the table's: the visual suite masks the start and end columns by position.
  const SORT_COLUMNS: readonly SortColumn[] = [
    { key: 'description', label: 'Run', numeric: false },
    { key: 'startTime', label: 'Started', numeric: false },
    { key: 'endTime', label: 'Finished', numeric: false },
    { key: 'durationMs', label: 'Duration', numeric: true },
    { key: 'phasesTotal', label: 'Steps', numeric: true },
    { key: 'totalCostUsd', label: 'Cost', numeric: true },
    { key: 'status', label: 'Status', numeric: false }
  ];
  const COLUMN_COUNT = SORT_COLUMNS.length + 1;

  // A step's outcome takes the tone its run would: done, failed, passed over, or stopped short.
  const PHASE_OUTCOME_TONES: Readonly<Record<NonNullable<PhaseRecord['outcome']>, string>> = {
    completed: 's-ok',
    failed: 's-err',
    skipped: 's-idle',
    jumped: 's-warn',
    'paused-at-breakpoint': 's-warn'
  };

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

  function phaseTone(outcome: PhaseRecord['outcome']): string {
    return outcome === undefined ? 's-run' : PHASE_OUTCOME_TONES[outcome];
  }

  // History's chip for the same state, so a run reads alike on both pages. A run
  // that is neither running nor finished has no status to show.
  function taskChip(task: TaskRecord): ReturnType<typeof runStatusChip> | null {
    if (task.isRunning) return runStatusChip('running');
    return task.status === undefined ? null : runStatusChip(task.status);
  }
</script>

<section class="section runs" aria-labelledby="metrics-runs-heading">
  <h2 id="metrics-runs-heading">Runs</h2>
  <div class="table-wrap">
    <table class="t" data-testid="metrics-task-table">
      <thead>
        <tr>
          <th scope="col" class="expand-col"><span class="sr-only">Expand</span></th>
          {#each SORT_COLUMNS as column (column.key)}
            {@const sort = ariaSort(column.key)}
            <th scope="col" class:num={column.numeric} aria-sort={sort}>
              <button type="button" data-testid="metrics-sort-{column.key}" onclick={() => onSort(column.key)}
                >{column.label}{#if sort !== 'none'}<svg class="i" aria-hidden="true"><use href="#i-chev"></use></svg>{/if}</button>
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each tasks as task (task.runId)}
          {@const expanded = expandedRunIds.has(task.runId)}
          {@const chip = taskChip(task)}
          <tr
            class="task-row"
            class:expanded
            data-testid="metrics-task-row-{task.runId}"
          >
            <td class="expand-cell">
              <button
                type="button"
                class="icon-btn expand-toggle"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} phase detail for ${task.description}`}
                data-testid="metrics-task-expand-{task.runId}"
                onclick={(event) => onExpandToggleClick(event, task.runId)}
              ><svg class="i" aria-hidden="true"><use href="#i-chev"></use></svg></button>
            </td>
            <td class="description-cell">
              {task.description}
              {#if task.source === 'phase-reconstruction'}
                <span class="tag" title="Reconstructed from Phase activity — no direct task record"
                  >Reconstructed</span>
              {/if}
            </td>
            <td class="nowrap">{formatAbsoluteTime(task.startTime)}</td>
            <td class="nowrap">{task.endTime ? formatAbsoluteTime(task.endTime) : '—'}</td>
            <td class="num">{formatDuration(task.durationMs)}</td>
            <td class="num">{task.phasesCompleted}/{task.phasesTotal}</td>
            <td class="num" class:cost-not-recorded={task.totalCostUsd === undefined}>{formatCost(task.totalCostUsd)}</td>
            <td>
              {#if chip}
                <span class="chip {chip.tone}"
                  >{#if chip.icon}<svg class="i" aria-hidden="true"><use href={chip.icon}></use></svg>{:else}<span
                      class="dot"
                      aria-hidden="true"
                    ></span>{/if}{chip.label}</span>
              {/if}
            </td>
          </tr>
          {#if expanded}
            <tr class="phase-detail-row">
              <td colspan={COLUMN_COUNT}>
                <div class="table-wrap">
                <table class="t fit" data-testid="metrics-phase-table-{task.runId}">
                  <thead>
                    <tr>
                      <th scope="col">Step</th>
                      <th scope="col">Started</th>
                      <th scope="col">Finished</th>
                      <th scope="col" class="num">Duration</th>
                      <th scope="col" class="num">Backend calls</th>
                      <th scope="col" class="num">Cost</th>
                      <th scope="col">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    <!-- Array-position identity avoids collisions after host display truncation. -->
                    {#each task.phases as phase, phaseIndex (phaseIndex)}
                      <tr data-testid="metrics-phase-row-{task.runId}-{phaseIndex}">
                        <td>{formatPhaseLabel(phase.phaseType)} <span class="muted">#{phase.iteration}</span></td>
                        <td class="nowrap">{formatAbsoluteTime(phase.startTime)}</td>
                        <td class="nowrap">{phase.endTime ? formatAbsoluteTime(phase.endTime) : '—'}</td>
                        <td class="num">{phase.durationMs !== undefined ? formatDuration(phase.durationMs) : '—'}</td>
                        <td class="num">{phase.backendInvocations}</td>
                        <td class="num" class:cost-not-recorded={phase.costUsd === undefined}>{formatCost(phase.costUsd)}</td>
                        <td><span class="chip {phaseTone(phase.outcome)}"
                          ><span class="dot" aria-hidden="true"></span>{formatPhaseOutcome(phase.outcome)}</span></td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  </div>

  {#if pageCount > 1}
    <div class="pager" data-testid="metrics-pagination">
      <span class="small muted">Page {currentPage + 1} of {pageCount}</span>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        data-testid="metrics-page-prev"
        disabled={currentPage === 0}
        aria-label="Previous page"
        onclick={() => onPageChange(currentPage - 1)}
      >Previous</button>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        data-testid="metrics-page-next"
        disabled={currentPage >= pageCount - 1}
        aria-label="Next page"
        onclick={() => onPageChange(currentPage + 1)}
      >Next</button>
    </div>
  {/if}
</section>

<style>
  .expand-col,
  .expand-cell {
    width: 1px;
    padding-right: 0;
  }
  /* Centred on the first line of the row's text, which the cells align to. */
  .expand-toggle {
    width: 22px;
    height: 22px;
    margin-block: -2px;
    color: var(--schegent-muted-fg);
  }
  /* The chevron points right while the row is closed and down once it is open. */
  .expand-toggle .i {
    transform: rotate(-90deg);
  }
  .task-row.expanded .expand-toggle .i {
    transform: none;
  }
  @media (prefers-reduced-motion: no-preference) {
    .expand-toggle .i {
      transition: transform 150ms ease-out;
    }
  }
  /* A sorted column's chevron points down for descending and up for ascending. */
  th[aria-sort='ascending'] .i {
    transform: rotate(180deg);
  }
  .task-row.expanded {
    background: var(--schegent-list-active);
  }
  .description-cell {
    min-width: 200px;
    overflow-wrap: anywhere;
  }
  .description-cell .tag {
    margin-left: var(--schegent-space-1-5);
  }
  .nowrap,
  td.num {
    white-space: nowrap;
  }
  .phase-detail-row > td {
    padding: 0 var(--schegent-space-3) var(--schegent-space-3) 34px;
    background: var(--schegent-surface-subtle);
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--schegent-space-2);
    margin-top: var(--schegent-space-2);
  }
  .pager .muted {
    margin-right: auto;
  }
</style>
