<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { deriveSidebarStats, deriveActivePhase } from '../lib/derive-stats';
  import { deriveOperatorHealth } from '../lib/derive-operator-health';
  import { formatPhaseLabel } from '../lib/format';

  const stats = $derived(deriveSidebarStats(snapshotStore.phases, snapshotStore.queue));
  const active = $derived(deriveActivePhase(snapshotStore.phases));
  const activeLine = $derived(formatActiveLine(active));
  const health = $derived(deriveOperatorHealth(snapshotStore.snapshot));
  // The active phase's steps, drawn as the bar under its line. None when there is nothing to count.
  const steps = $derived(active?.subProgress && active.subProgress.total > 0 ? active.subProgress : null);

  /**
   * FR-R3-130 (T1496) — aggregate stream pressure, beside the health projection.
   *
   * The audit of 2026-08-27's point about the cap-20 ceiling was that an operator can
   * accept it without ever seeing it. `stream-pressure-advice.ts` warns at the moment
   * the cap is chosen; this is the other half — a loaded configuration observable
   * WHILE it is loaded.
   *
   * Rendered only when something is in flight. A permanent "0 MiB" would be furniture,
   * and furniture is what an operator stops reading.
   */
  const pressure = $derived(snapshotStore.snapshot?.streamPressure ?? null);
  const pressureLine = $derived.by(() => {
    if (pressure === null || pressure.liveBuffers === 0) return null;
    const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    return `${mib(pressure.retainedBytes)} buffered · ${pressure.liveBuffers} stream${
      pressure.liveBuffers === 1 ? '' : 's'
    }`;
  });
  const pressureTitle = $derived.by(() => {
    if (pressure === null) return '';
    return (
      `${(pressure.retainedBytes / 1024 / 1024).toFixed(1)} MiB retained across ` +
      `${pressure.liveBuffers} live stream buffer(s); those same buffers could reach ` +
      `${(pressure.ceilingBytes / 1024 / 1024).toFixed(0)} MiB under their own caps. ` +
      'Measured 2026-08-27: buffers retain what they accept, roughly 1:1, below the cap.'
    );
  });

  function formatActiveLine(a: ReturnType<typeof deriveActivePhase>): string {
    if (a === null) return 'no active phase';
    const name = formatPhaseLabel(a.name, a.displayName).toLowerCase();
    if (a.subProgress === null) return name;
    const { current, total, label } = a.subProgress;
    return `${name} · ${current}/${total} ${label}s`;
  }
</script>

<!-- The mockup's "Today" section, with the counts the sidebar has. They are not counts for a day,
     so the heading says "Progress". The icons are the sprite's check, dot and cross, drawn here
     because the sidebar does not load the sprite. -->
<section class="sb-sec" data-testid="sidebar-stats-strip">
  <h2>Progress</h2>
  <div class="small muted line" data-testid="sidebar-active-phase" title={activeLine}>{activeLine}</div>
  {#if steps}
    <progress class="prog" aria-label="Steps completed" max={steps.total} value={steps.current}></progress>
  {/if}
  <div class="sb-row" data-testid="sidebar-stats-done">
    <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3 3 7-7" /></svg>
    Done <span class="num">{stats.done}</span>
  </div>
  <div class="sb-row" data-testid="sidebar-stats-pending">
    <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.5" fill="currentColor" /></svg>
    Pending <span class="num">{stats.pending}</span>
  </div>
  <div class="sb-row" data-testid="sidebar-stats-failed">
    <svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
    Failed <span class="num">{stats.failed}</span>
  </div>
  {#if pressureLine !== null}
    <div class="small muted line" data-testid="sidebar-stream-pressure" title={pressureTitle}>
      {pressureLine}
    </div>
  {/if}
  <div
    class={`health health-${health.level}`}
    data-testid="sidebar-health"
    title={health.title}
  >
    {health.label}
  </div>
</section>

<style>
  .line {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .health {
    margin-top: var(--schegent-space-2);
    font-size: var(--schegent-text-secondary);
    overflow-wrap: anywhere;
  }
  .health-ok {
    color: var(--schegent-muted-fg);
  }
  /* Anything short of healthy is drawn as the mockup's attention notice (`.attn` in `sg-core.css`):
     the accent draws the frame and the tint, and the words keep the text colour. */
  .health-attention,
  .health-blocked {
    padding: var(--schegent-space-1-5) var(--schegent-space-2-5);
    border: 1px solid color-mix(in srgb, var(--schegent-color-warning) 55%, transparent);
    border-radius: var(--schegent-radius);
    background: color-mix(in srgb, var(--schegent-color-warning) 9%, transparent);
    font-weight: 600;
  }
  .health-blocked {
    border-color: color-mix(in srgb, var(--schegent-color-error) 55%, transparent);
    background: color-mix(in srgb, var(--schegent-color-error) 9%, transparent);
  }
</style>
