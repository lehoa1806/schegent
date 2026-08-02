<script lang="ts">
  import type { CostTimelinePoint } from '../../lib/messages';
  import { t } from '../../lib/i18n';

  interface Props {
    timeline: readonly CostTimelinePoint[];
    activePointIndex: number | null;
    onActivePointChange: (index: number | null) => void;
  }

  const { timeline, activePointIndex, onActivePointChange }: Props = $props();

  const CHART_W = 640;
  const CHART_H = 180;
  const CHART_PAD = 12;

  function formatCost(value: number | undefined): string {
    return value === undefined ? 'Not recorded' : `$${value.toFixed(2)}`;
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
    timeline.length > 0 ? timeline[timeline.length - 1]!.cumulativeCostUsd : 0
  );
  const linePath = $derived.by(() =>
    timeline
      .map((point, index) =>
        `${index === 0 ? 'M' : 'L'} ${pointX(index, timeline.length)} ${pointY(point.cumulativeCostUsd, maxCumulativeCostUsd)}`
      )
      .join(' ')
  );
  const areaPath = $derived.by(() => {
    if (timeline.length === 0) return '';
    const baseline = CHART_H - CHART_PAD;
    return `${linePath} L ${pointX(timeline.length - 1, timeline.length)} ${baseline} L ${pointX(0, timeline.length)} ${baseline} Z`;
  });
  const activePoint = $derived(
    activePointIndex !== null ? (timeline[activePointIndex] ?? null) : null
  );
</script>

<section class="cost-trend" aria-label="Cost trend" data-testid="metrics-cost-trend">
  <h2 class="section-title">Cost Trend</h2>
  {#if timeline.length === 0}
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
      {#each timeline as point, index (point.date)}
        <circle
          class="point"
          class:active={activePointIndex === index}
          cx={pointX(index, timeline.length)}
          cy={pointY(point.cumulativeCostUsd, maxCumulativeCostUsd)}
          r={activePointIndex === index ? 4 : 3}
          tabindex="0"
          role="button"
          aria-label={`${point.date}: daily ${formatCost(point.dailyCostUsd)}, cumulative ${formatCost(point.cumulativeCostUsd)}`}
          data-testid="metrics-cost-trend-point-{point.date}"
          onmouseenter={() => onActivePointChange(index)}
          onmouseleave={() => onActivePointChange(null)}
          onfocus={() => onActivePointChange(index)}
          onblur={() => onActivePointChange(null)}
          onkeydown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onActivePointChange(index);
            }
          }}
        ><title>{point.date}: {formatCost(point.dailyCostUsd)} (cumulative {formatCost(point.cumulativeCostUsd)})</title></circle>
      {/each}
    </svg>
    <p class="cost-trend-detail" data-testid="metrics-cost-trend-detail" aria-live="polite">
      {#if activePoint}
        {activePoint.date}: daily {formatCost(activePoint.dailyCostUsd)}, cumulative {formatCost(activePoint.cumulativeCostUsd)}
      {:else}
        {t('metrics.chart.hint')}
      {/if}
    </p>
  {/if}
</section>

<style>
  .cost-trend-svg { width: 100%; height: 180px; }
  .cost-trend-svg .area {
    fill: color-mix(in srgb, var(--schegent-color-active) 18%, transparent);
    stroke: none;
  }
  .cost-trend-svg .line {
    fill: none;
    stroke: var(--schegent-color-active);
    stroke-width: 2;
  }
  .cost-trend-svg .point { fill: var(--schegent-color-active); cursor: pointer; }
  .cost-trend-svg .point.active { fill: var(--schegent-fg); }
  .cost-trend-detail {
    margin: 4px 0 0 0;
    color: var(--schegent-muted-fg);
    font-size: 0.9em;
  }
</style>
