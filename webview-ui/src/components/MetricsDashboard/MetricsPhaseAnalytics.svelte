<script lang="ts">
  import type { PhaseTypeAggregate } from '../../lib/messages';
  import { formatDuration } from '../../lib/format-duration';
  import { formatPhaseLabel } from '../../lib/format';

  interface Props {
    aggregates: readonly PhaseTypeAggregate[];
  }

  const { aggregates }: Props = $props();

  function formatCost(value: number | undefined): string {
    return value === undefined ? 'Not recorded' : `$${value.toFixed(2)}`;
  }
</script>

<section class="phase-analytics" aria-label="Phase analytics" data-testid="metrics-phase-analytics">
  <h2 class="section-title">Phase Analytics</h2>
  {#if aggregates.length === 0}
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
          {#each aggregates as agg (agg.phaseType)}
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

<style>
  .table-scroll { overflow-x: auto; }
</style>
