<script lang="ts">
  import type { CostTimelinePoint } from '../../lib/messages';

  interface Props {
    timeline: readonly CostTimelinePoint[];
    activePointIndex: number | null;
    onActivePointChange: (index: number | null) => void;
  }

  const { timeline, activePointIndex, onActivePointChange }: Props = $props();

  const CHART_W = 640;
  const CHART_H = 180;
  const CHART_PAD = 12;
  const MAX_RENDERED_POINTS = 120;

  function sampleTimeline(points: readonly CostTimelinePoint[]): readonly CostTimelinePoint[] {
    if (points.length <= MAX_RENDERED_POINTS) return points;
    const sampled: CostTimelinePoint[] = [];
    let previousIndex = -1;
    for (let slot = 0; slot < MAX_RENDERED_POINTS; slot += 1) {
      const index = Math.round((slot * (points.length - 1)) / (MAX_RENDERED_POINTS - 1));
      if (index === previousIndex) continue;
      sampled.push(points[index]!);
      previousIndex = index;
    }
    return sampled;
  }

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

  const renderedTimeline = $derived(sampleTimeline(timeline));
  const timelineSampled = $derived(renderedTimeline.length < timeline.length);
  const maxCumulativeCostUsd = $derived(
    renderedTimeline.length > 0
      ? renderedTimeline[renderedTimeline.length - 1]!.cumulativeCostUsd
      : 0
  );
  const linePath = $derived.by(() =>
    renderedTimeline
      .map((point, index) =>
        `${index === 0 ? 'M' : 'L'} ${pointX(index, renderedTimeline.length)} ${pointY(point.cumulativeCostUsd, maxCumulativeCostUsd)}`
      )
      .join(' ')
  );
  const areaPath = $derived.by(() => {
    if (renderedTimeline.length === 0) return '';
    const baseline = CHART_H - CHART_PAD;
    return `${linePath} L ${pointX(renderedTimeline.length - 1, renderedTimeline.length)} ${baseline} L ${pointX(0, renderedTimeline.length)} ${baseline} Z`;
  });
  const activePoint = $derived(
    activePointIndex !== null ? (renderedTimeline[activePointIndex] ?? null) : null
  );

  let keyboardPointIndex = $state(0);

  $effect(() => {
    if (renderedTimeline.length === 0) {
      keyboardPointIndex = 0;
    } else if (keyboardPointIndex >= renderedTimeline.length) {
      keyboardPointIndex = renderedTimeline.length - 1;
    }
  });

  function pointId(index: number): string {
    return `metrics-cost-trend-point-${index}`;
  }

  function activatePoint(index: number, focus = false): void {
    keyboardPointIndex = index;
    onActivePointChange(index);
    if (focus) {
      queueMicrotask(() => document.getElementById(pointId(index))?.focus());
    }
  }

  function onPointKeydown(event: KeyboardEvent, index: number): void {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = Math.min(index + 1, renderedTimeline.length - 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = Math.max(index - 1, 0);
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = renderedTimeline.length - 1;
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activatePoint(index);
      return;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    activatePoint(nextIndex, true);
  }
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
      {#each renderedTimeline as point, index (point.date)}
        <circle
          id={pointId(index)}
          class="point"
          class:active={activePointIndex === index}
          cx={pointX(index, renderedTimeline.length)}
          cy={pointY(point.cumulativeCostUsd, maxCumulativeCostUsd)}
          r={activePointIndex === index ? 4 : 3}
          tabindex={keyboardPointIndex === index ? 0 : -1}
          role="button"
          aria-label={`${point.date}: daily ${formatCost(point.dailyCostUsd)}, cumulative ${formatCost(point.cumulativeCostUsd)}`}
          data-testid="metrics-cost-trend-point-{point.date}"
          onmouseenter={() => onActivePointChange(index)}
          onmouseleave={() => onActivePointChange(null)}
          onfocus={() => activatePoint(index)}
          onblur={() => onActivePointChange(null)}
          onkeydown={(event) => onPointKeydown(event, index)}
        ><title>{point.date}: {formatCost(point.dailyCostUsd)} (cumulative {formatCost(point.cumulativeCostUsd)})</title></circle>
      {/each}
    </svg>
    <p class="cost-trend-detail" data-testid="metrics-cost-trend-detail" aria-live="polite">
      {#if activePoint}
        {activePoint.date}: daily {formatCost(activePoint.dailyCostUsd)}, cumulative {formatCost(activePoint.cumulativeCostUsd)}
      {:else}
        Hover or focus a point on the chart for exact values.
        {#if timelineSampled} Showing {renderedTimeline.length} evenly sampled dates from {timeline.length}.{/if}
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
