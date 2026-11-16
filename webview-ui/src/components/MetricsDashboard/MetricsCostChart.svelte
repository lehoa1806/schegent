<script lang="ts">
  import type { CostTimelinePoint } from '../../lib/messages';

  interface Props {
    timeline: readonly CostTimelinePoint[];
    activePointIndex: number | null;
    onActivePointChange: (index: number | null) => void;
  }

  const { timeline, activePointIndex, onActivePointChange }: Props = $props();

  // The mockup's bar chart: a gutter on the left for the cost axis, one below
  // for the day labels, and a bar per day growing up from the baseline.
  const CHART_H = 220;
  const AXIS_LEFT = 40;
  const AXIS_BOTTOM = 24;
  const PLOT_TOP = 8;
  const BASELINE = CHART_H - AXIS_BOTTOM;
  const BAR_GAP = 2;
  const MAX_BAR_W = 48;
  const CORNER_R = 4;
  const Y_TICK_COUNT = 3;
  const NICE_STEPS = [1, 2, 2.5, 5, 10];
  /** The drawing width until the chart has been measured, and the floor after. */
  const DEFAULT_VIEW_W = 760;
  const MIN_VIEW_W = 240;
  /** Day labels stand at least this far apart, weekly where that fits, as in the mockup. */
  const LABEL_MIN_PX = 96;
  const LABEL_STRIDES = [1, 2, 7, 14, 28];
  /** A label closer than this to the right edge is anchored at its end. */
  const LABEL_EDGE_PX = 24;
  const MAX_TICK_DECIMALS = 4;
  const TIP_OFFSET_PX = 8;
  const MAX_RENDERED_POINTS = 120;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(\d{2})$/;

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

  // 'YYYY-MM-DD' as 'May 10', the mockup's day label; any other shape as it came. The pattern
  // takes only months 01 to 12, so the month is always in the list.
  function dayLabel(date: string): string {
    const match = ISO_DAY.exec(date);
    if (match === null) return date;
    return `${MONTHS[Number(match[1]) - 1]} ${Number(match[2])}`;
  }

  // The axis step: the smallest of 1, 2, 2.5, 5 or 10 times a power of ten that is at least `raw`.
  function niceStep(raw: number): number {
    if (raw <= 0 || !Number.isFinite(raw)) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = NICE_STEPS.find((candidate) => candidate * magnitude >= raw) ?? 10;
    return step * magnitude;
  }

  // Whole-dollar steps print as "$4"; finer ones keep the cents, or the places a step of $0.025 needs.
  function decimalsFor(step: number): number {
    if (Number.isInteger(step)) return 0;
    let places = 2;
    while (places < MAX_TICK_DECIMALS && Math.abs(step * 10 ** places - Math.round(step * 10 ** places)) > 1e-6) {
      places += 1;
    }
    return places;
  }

  function strideFor(slot: number): number {
    return LABEL_STRIDES.find((stride) => stride * slot >= LABEL_MIN_PX) ?? Math.ceil(LABEL_MIN_PX / slot);
  }

  const renderedTimeline = $derived(sampleTimeline(timeline));
  const timelineSampled = $derived(renderedTimeline.length < timeline.length);
  const activePoint = $derived(
    activePointIndex !== null ? (renderedTimeline[activePointIndex] ?? null) : null
  );

  let chart = $state<HTMLDivElement | null>(null);
  let tip = $state<HTMLDivElement | null>(null);
  let chartWidth = $state(DEFAULT_VIEW_W);
  let showTable = $state(false);

  // The chart draws at its own width, as the mockup's does, so neither the bars
  // nor the labels are stretched. jsdom has no ResizeObserver and keeps the default.
  $effect(() => {
    const element = chart;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      chartWidth = element.clientWidth;
    });
    observer.observe(element);
    return () => observer.disconnect();
  });

  const viewWidth = $derived(Math.max(MIN_VIEW_W, Math.round(chartWidth)));
  const slotWidth = $derived((viewWidth - AXIS_LEFT) / Math.max(1, renderedTimeline.length));
  const barWidth = $derived(Math.max(1, Math.min(MAX_BAR_W, slotWidth - BAR_GAP)));
  const labelStride = $derived(strideFor(slotWidth));
  const tickStep = $derived(
    niceStep(renderedTimeline.reduce((max, point) => Math.max(max, point.dailyCostUsd), 0) / Y_TICK_COUNT)
  );
  const tickDecimals = $derived(decimalsFor(tickStep));
  const yTicks = $derived(Array.from({ length: Y_TICK_COUNT + 1 }, (_, index) => index * tickStep));
  const yMax = $derived(tickStep * Y_TICK_COUNT);

  const rangeLabel = $derived.by(() => {
    const first = timeline.at(0);
    const last = timeline.at(-1);
    if (first === undefined || last === undefined) return '';
    return first === last ? first.date : `${first.date} to ${last.date}`;
  });
  const chartLabel = $derived.by(() => {
    const peak = timeline.reduce<CostTimelinePoint | undefined>(
      (best, point) => (best === undefined || point.dailyCostUsd > best.dailyCostUsd ? point : best),
      undefined
    );
    if (peak === undefined) return 'Cost per day';
    return `Cost per day, ${rangeLabel}. Highest on ${peak.date}: ${formatCost(peak.dailyCostUsd)}.`;
  });

  function barLeft(index: number): number {
    return AXIS_LEFT + index * slotWidth + (slotWidth - barWidth) / 2;
  }

  function barTop(value: number): number {
    const clamped = Math.min(Math.max(value, 0), yMax);
    return PLOT_TOP + (BASELINE - PLOT_TOP) * (1 - clamped / yMax);
  }

  // A bar with its two top corners rounded, as the mockup draws them.
  function barPath(index: number, value: number): string {
    const left = barLeft(index);
    const right = left + barWidth;
    const top = barTop(value);
    const radius = Math.min(CORNER_R, BASELINE - top, barWidth / 2);
    return `M${left} ${BASELINE}V${top + radius}Q${left} ${top} ${left + radius} ${top}H${right - radius}Q${right} ${top} ${right} ${top + radius}V${BASELINE}Z`;
  }

  // The last day is always labelled; the others every `labelStride` days, short
  // of the last so two labels never collide.
  function showsDayLabel(index: number): boolean {
    const last = renderedTimeline.length - 1;
    return index === last || (index % labelStride === 0 && last - index >= Math.ceil(labelStride / 2));
  }

  // The tip stands above the active bar, held inside the chart's width. The CSP
  // refuses a style attribute, so it is placed through the CSSOM.
  $effect(() => {
    if (tip === null || activePointIndex === null || activePoint === null) return;
    // Narrower than MIN_VIEW_W, the drawing shrinks from its top-left corner.
    const scale = Math.min(1, chartWidth / viewWidth);
    const half = tip.offsetWidth / 2;
    const centre = (barLeft(activePointIndex) + barWidth / 2) * scale;
    tip.style.left = `${Math.min(Math.max(centre, half), Math.max(half, chartWidth - half))}px`;
    tip.style.top = `${barTop(activePoint.dailyCostUsd) * scale - TIP_OFFSET_PX}px`;
  });

  function toggleTable(): void {
    showTable = !showTable;
    onActivePointChange(null);
  }

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

<section class="section card cost-trend" aria-labelledby="metrics-cost-heading" data-testid="metrics-cost-trend">
  <div class="titlerow">
    <h2 id="metrics-cost-heading">Cost per day</h2>
    {#if timeline.length > 0}
      <span class="small muted">{rangeLabel}</span>
      <button type="button" class="btn btn-ghost btn-sm push" data-testid="metrics-cost-view-toggle"
        onclick={toggleTable}>
        <svg class="i" aria-hidden="true"><use href="#i-table"></use></svg>{showTable ? 'Show chart' : 'Show as table'}
      </button>
    {/if}
  </div>
  {#if timeline.length === 0}
    <p class="empty" data-testid="metrics-cost-trend-empty">No cost data available.</p>
  {:else if showTable}
    <!-- A scroll box with nothing focusable inside takes the tab stop itself, so
         the keyboard can scroll it. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="table-wrap cost-table" role="region" aria-label="Cost per day, as a table" tabindex="0"
      data-testid="metrics-cost-table">
      <table class="t fit">
        <thead>
          <tr><th scope="col">Day</th><th scope="col" class="num">Cost</th><th scope="col" class="num">Cumulative</th></tr>
        </thead>
        <tbody>
          {#each timeline as point (point.date)}
            <tr>
              <td>{point.date}</td>
              <td class="num">{formatCost(point.dailyCostUsd)}</td>
              <td class="num">{formatCost(point.cumulativeCostUsd)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="chart" bind:this={chart}>
      <svg
        viewBox="0 0 {viewWidth} {CHART_H}"
        preserveAspectRatio="xMinYMin meet"
        role="group"
        aria-label={chartLabel}
        data-testid="metrics-cost-trend-svg"
      >
        {#each yTicks as tick (tick)}
          <g>
            <line class="gl" x1={AXIS_LEFT} x2={viewWidth} y1={barTop(tick)} y2={barTop(tick)}></line>
            <text class="ax" x={AXIS_LEFT - 6} y={barTop(tick) + 4} text-anchor="end">${tick.toFixed(tickDecimals)}</text>
          </g>
        {/each}
        {#each renderedTimeline as point, index (point.date)}
          {@const centre = barLeft(index) + barWidth / 2}
          {@const nearEdge = viewWidth - centre < LABEL_EDGE_PX}
          <g
            role="presentation"
            onmouseenter={() => onActivePointChange(index)}
            onmouseleave={() => onActivePointChange(null)}
          >
            <path class="b" class:hot={activePointIndex === index} d={barPath(index, point.dailyCostUsd)}></path>
            <rect class="hit" x={AXIS_LEFT + index * slotWidth} y={PLOT_TOP} width={slotWidth}
              height={BASELINE - PLOT_TOP}></rect>
            <circle
              id={pointId(index)}
              class="point"
              class:active={activePointIndex === index}
              cx={centre}
              cy={barTop(point.dailyCostUsd)}
              r={activePointIndex === index ? 4 : 3}
              tabindex={keyboardPointIndex === index ? 0 : -1}
              role="button"
              aria-label={`${point.date}: daily ${formatCost(point.dailyCostUsd)}, cumulative ${formatCost(point.cumulativeCostUsd)}`}
              data-testid="metrics-cost-trend-point-{point.date}"
              onfocus={() => activatePoint(index)}
              onblur={() => onActivePointChange(null)}
              onkeydown={(event) => onPointKeydown(event, index)}
            ><title>{point.date}: {formatCost(point.dailyCostUsd)} (cumulative {formatCost(point.cumulativeCostUsd)})</title></circle>
            {#if showsDayLabel(index)}
              <text class="ax" x={nearEdge ? viewWidth : centre} y={CHART_H - 6}
                text-anchor={nearEdge ? 'end' : 'middle'}>{dayLabel(point.date)}</text>
            {/if}
          </g>
        {/each}
      </svg>
      {#if activePoint}
        <div class="tip" aria-hidden="true" bind:this={tip}>
          <b>{dayLabel(activePoint.date)}</b><br />{formatCost(activePoint.dailyCostUsd)} · {formatCost(activePoint.cumulativeCostUsd)} to date
        </div>
      {/if}
    </div>
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
  .titlerow {
    margin-bottom: var(--schegent-space-2);
  }
  .titlerow h2 {
    margin: 0;
    font-size: var(--schegent-text-subheading);
  }
  /* A point is the bar's keyboard stop: it shows when its bar is active or it has focus. */
  .chart .point {
    fill: var(--schegent-fg);
    opacity: 0;
    pointer-events: none;
  }
  .chart .point.active,
  .chart .point:focus-visible {
    opacity: 1;
  }
  .chart .point:focus-visible {
    stroke: var(--schegent-focus-border);
    stroke-width: 2px;
  }
  .chart .ax {
    pointer-events: none;
  }
  /* The table takes the chart's height, so switching views does not move the page. */
  .cost-table {
    max-height: 220px;
    overflow: auto;
  }
  .cost-table th {
    position: sticky;
    top: 0;
  }
  .cost-trend-detail {
    margin: var(--schegent-space-1-5) 0 0;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-secondary);
  }
</style>
