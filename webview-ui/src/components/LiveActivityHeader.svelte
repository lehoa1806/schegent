<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { formatDuration } from '../lib/format-duration';

  const liveActivity = $derived(snapshotStore.liveActivity);
  const workflowElapsedMs = $derived(snapshotStore.workflowElapsedMs);
  const freshness = $derived(liveActivity?.freshness ?? 'idle');
  const summary = $derived(liveActivity?.summary ?? null);
  const staleSeconds = $derived(liveActivity?.staleSeconds ?? null);
  const elapsedLabel = $derived(workflowElapsedMs !== null ? formatDuration(workflowElapsedMs) : null);
  const freshnessLabel = $derived(formatFreshness(freshness, staleSeconds));

  function formatFreshness(state: string, staleSeconds: number | null): string {
    if (state === 'idle') return 'idle';
    if (state === 'paused') return 'paused';
    if (state === 'live') return 'live';
    if (state === 'slowing') {
      return staleSeconds !== null ? `slowing — ${staleSeconds}s` : 'slowing';
    }
    if (state === 'stalled') {
      return staleSeconds !== null ? `stalled — ${staleSeconds}s` : 'stalled';
    }
    return state;
  }
</script>

<section
  class="live-activity freshness-{freshness}"
  data-testid="live-activity-header"
  aria-label="Live activity"
>
  <div class="row">
    <span
      class="freshness-dot"
      data-testid="freshness-dot"
      data-freshness={freshness}
      aria-hidden="true"
    ></span>
    <span class="freshness-label" data-testid="freshness-label">{freshnessLabel}</span>
    {#if elapsedLabel !== null}
      <span class="elapsed" data-testid="workflow-elapsed">{elapsedLabel}</span>
    {/if}
  </div>
  <div class="summary" data-testid="live-activity-summary">
    {#if summary}
      <span class="summary-text">{summary}</span>
    {:else}
      <span class="summary-empty">no activity yet</span>
    {/if}
  </div>
</section>

<style>
  .live-activity {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--schegent-pad);
    border-bottom: 1px solid var(--schegent-divider);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--schegent-gap);
  }
  .freshness-dot {
    width: 0.65em;
    height: 0.65em;
    border-radius: 50%;
    background: var(--schegent-color-system);
  }
  .freshness-live .freshness-dot {
    background: var(--schegent-color-active);
  }
  .freshness-slowing .freshness-dot {
    background: var(--schegent-color-warning);
  }
  .freshness-stalled .freshness-dot {
    background: var(--schegent-color-error);
  }
  .freshness-paused .freshness-dot {
    background: var(--schegent-color-warning);
  }
  .freshness-label {
    font-weight: 600;
    font-size: 0.9em;
  }
  .freshness-stalled .freshness-label {
    color: var(--schegent-error-text);
  }
  .freshness-slowing .freshness-label {
    color: var(--schegent-color-warning);
  }
  .elapsed {
    margin-left: auto;
    font-size: 0.8em;
    color: var(--schegent-muted-fg);
    font-variant-numeric: tabular-nums;
    border: 1px solid var(--schegent-border);
    border-radius: 999px;
    padding: 0 6px;
  }
  .summary {
    font-size: 0.85em;
    color: var(--schegent-muted-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .summary-text {
    color: var(--schegent-fg);
  }
  .summary-empty {
    font-style: italic;
  }
</style>
