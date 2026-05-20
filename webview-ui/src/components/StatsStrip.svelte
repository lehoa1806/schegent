<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { deriveSidebarStats, deriveActivePhase } from '../lib/derive-stats';
  import { deriveOperatorHealth } from '../lib/derive-operator-health';
  import { formatPhaseLabel } from '../lib/format';

  const stats = $derived(deriveSidebarStats(snapshotStore.phases, snapshotStore.queue));
  const active = $derived(deriveActivePhase(snapshotStore.phases));
  const activeLine = $derived(formatActiveLine(active));
  const health = $derived(deriveOperatorHealth(snapshotStore.snapshot));

  function formatActiveLine(a: ReturnType<typeof deriveActivePhase>): string {
    if (a === null) return 'no active phase';
    const name = formatPhaseLabel(a.name, a.displayName).toLowerCase();
    if (a.subProgress === null) return name;
    const { current, total, label } = a.subProgress;
    return `${name} · ${current}/${total} ${label}s`;
  }
</script>

<div class="stats-strip" data-testid="sidebar-stats-strip">
  <div class="counters">
    <span class="counter" data-testid="sidebar-stats-done">
      <span class="num">{stats.done}</span>
      <span class="lbl">done</span>
    </span>
    <span class="sep">·</span>
    <span class="counter" data-testid="sidebar-stats-pending">
      <span class="num">{stats.pending}</span>
      <span class="lbl">pending</span>
    </span>
    <span class="sep">·</span>
    <span class="counter" data-testid="sidebar-stats-failed">
      <span class="num">{stats.failed}</span>
      <span class="lbl">failed</span>
    </span>
  </div>
  <div class="active-phase" data-testid="sidebar-active-phase" title={activeLine}>{activeLine}</div>
  <div
    class={`health health-${health.level}`}
    data-testid="sidebar-health"
    title={health.title}
  >
    {health.label}
  </div>
</div>

<style>
  .stats-strip {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--schegent-pad);
    border-bottom: 1px solid var(--schegent-divider);
    min-width: 0;
  }
  .counters {
    display: flex;
    align-items: baseline;
    gap: var(--schegent-gap);
    font-variant-numeric: tabular-nums;
    flex-wrap: nowrap;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .counter {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
  }
  .num {
    font-weight: 600;
    color: var(--schegent-fg);
  }
  .lbl {
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }
  .sep {
    color: var(--schegent-muted-fg);
  }
  .active-phase {
    font-size: 0.85em;
    color: var(--schegent-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .health {
    font-size: 0.78em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-transform: uppercase;
    letter-spacing: 0;
  }
  .health-ok {
    color: var(--schegent-muted-fg);
  }
  .health-attention {
    color: var(--schegent-warning-fg, var(--schegent-fg));
  }
  .health-blocked {
    color: var(--schegent-error-fg, var(--schegent-fg));
  }
</style>
