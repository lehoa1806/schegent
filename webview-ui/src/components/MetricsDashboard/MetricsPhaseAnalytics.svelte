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

<!-- The mockup's step table: the step's name over its id, then the figures,
     right-aligned. The product shows every column the mockup puts under its
     Columns menu, so nothing is hidden behind it. -->
<section class="section steps" aria-labelledby="metrics-steps-heading" data-testid="metrics-phase-analytics">
  <h2 id="metrics-steps-heading">Steps</h2>
  {#if aggregates.length === 0}
    <p class="empty" data-testid="metrics-phase-analytics-empty">No Phase executions recorded yet.</p>
  {:else}
    <div class="table-wrap">
      <table class="t" data-testid="metrics-phase-analytics-table">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col" class="num">Runs</th>
            <th scope="col" class="num">Median</th>
            <th scope="col" class="num">p90</th>
            <th scope="col" class="num">p99</th>
            <th scope="col" class="num">Longest</th>
            <th scope="col" class="num">Shortest</th>
            <th scope="col" class="num">Average</th>
            <th scope="col" class="num">Total time</th>
            <th scope="col" class="num">Backend calls</th>
            <th scope="col" class="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {#each aggregates as agg (agg.phaseType)}
            <tr data-testid="metrics-phase-analytics-row-{agg.phaseType}">
              <td>{formatPhaseLabel(agg.phaseType)}<div class="sub mono">{agg.phaseType}</div></td>
              <td class="num">{agg.executionCount}</td>
              <td class="num">{formatDuration(agg.p50DurationMs)}</td>
              <td class="num">{formatDuration(agg.p90DurationMs)}</td>
              <td class="num">{formatDuration(agg.p99DurationMs)}</td>
              <td class="num">{formatDuration(agg.longestDurationMs)}</td>
              <td class="num">{formatDuration(agg.shortestDurationMs)}</td>
              <td class="num">{formatDuration(agg.avgDurationMs)}</td>
              <td class="num">{formatDuration(agg.totalDurationMs)}</td>
              <td class="num">{agg.totalBackendInvocations}</td>
              <td class="num" class:cost-not-recorded={agg.totalCostUsd === undefined}>{formatCost(agg.totalCostUsd)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .steps td.num {
    white-space: nowrap;
  }
</style>
