<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { formatDuration } from '../lib/format-duration';

  const status = $derived(snapshotStore.status);
  const featureLabel = $derived(snapshotStore.activeFeatureLabel);
  const isPrimary = $derived(snapshotStore.isPrimary);
  const elapsedMs = $derived(snapshotStore.snapshot?.workflowElapsedMs ?? null);
  const elapsedLabel = $derived(elapsedMs !== null ? formatElapsed(elapsedMs) : null);

  function formatElapsed(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '0s';
    if (ms >= 3_600_000) {
      // For >= 1h, formatDuration returns "Xh Ym" — use that for compactness.
      return formatDuration(ms);
    }
    return formatDuration(ms);
  }
</script>

<div class="status-row status-{status}" data-testid="sidebar-status-row">
  <span class="dot" aria-label={`Status: ${status}`}></span>
  {#if featureLabel}
    <span class="feature-label" title={featureLabel}>{featureLabel}</span>
  {:else}
    <em class="feature-empty">no active feature</em>
  {/if}
  {#if featureLabel && elapsedLabel !== null}
    <span class="elapsed-pill" data-testid="sidebar-elapsed-pill">{elapsedLabel}</span>
  {/if}
  {#if !isPrimary}
    <span
      class="secondary-badge"
      data-testid="sidebar-secondary-badge"
      title="Another window is the primary controller"
    >secondary</span>
  {/if}
</div>

<style>
  .status-row {
    display: flex;
    align-items: center;
    gap: var(--schegent-gap);
    padding: var(--schegent-pad);
    border-bottom: 1px solid var(--sch-glass-border);
    min-width: 0;
    background: var(--vscode-list-hoverBackground);
  }
  .dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--schegent-color-system);
    transition: box-shadow 0.3s;
  }
  .status-running .dot { background: var(--schegent-color-active); box-shadow: var(--sch-glow-active); }
  .status-paused .dot { background: var(--schegent-color-warning); }
  .status-completed .dot { background: var(--schegent-color-completed); box-shadow: var(--sch-glow-success); }
  .status-failed .dot { background: var(--schegent-color-error); }
  .status-canceled .dot { background: var(--schegent-muted-fg); }
  .feature-label {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--schegent-fg);
  }
  .feature-empty {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--schegent-muted-fg);
    font-style: italic;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .elapsed-pill {
    flex: 0 0 auto;
    margin-left: auto;
    font-size: 0.8em;
    color: var(--vscode-charts-blue);
    background: color-mix(in srgb, var(--vscode-charts-blue) 15%, transparent);
    font-variant-numeric: tabular-nums;
    border-radius: 999px;
    padding: 2px 8px;
    font-weight: 600;
  }
  .secondary-badge {
    flex: 0 0 auto;
    font-size: 0.8em;
    color: var(--schegent-color-warning);
    border: 1px solid currentColor;
    border-radius: 999px;
    padding: 2px 8px;
    background: var(--vscode-charts-yellow);
  }
</style>
