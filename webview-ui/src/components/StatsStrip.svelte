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
    <span class="counter" data-testid="sidebar-stats-pending">
      <span class="num">{stats.pending}</span>
      <span class="lbl">pending</span>
    </span>
    <span class="counter" data-testid="sidebar-stats-failed">
      <span class="num">{stats.failed}</span>
      <span class="lbl">failed</span>
    </span>
  </div>
  <div class="phase-line">
    <div class="active-phase" data-testid="sidebar-active-phase" title={activeLine}>{activeLine}</div>
    <div
      class={`health health-${health.level}`}
      data-testid="sidebar-health"
      title={health.title}
    >
      {health.label}
    </div>
  </div>
</div>

<style>
  .stats-strip {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--schegent-divider);
    min-width: 0;
  }
  .counters {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    align-items: stretch;
    gap: 1px;
    font-variant-numeric: tabular-nums;
    background: var(--schegent-divider);
    border: 1px solid var(--schegent-divider);
    border-radius: 5px;
    overflow: hidden;
  }
  .counter {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 7px 6px;
    background: var(--schegent-surface);
  }
  .num {
    font-weight: 600;
    color: var(--schegent-fg);
  }
  .lbl {
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }
  .phase-line {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .active-phase {
    min-width: 0;
    flex: 1 1 auto;
    font-size: 0.85em;
    color: var(--schegent-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .health {
    flex: 0 0 auto;
    font-size: 0.78em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 600;
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
