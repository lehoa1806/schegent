<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { formatStatus } from '../lib/format';

  const status = $derived(snapshotStore.status);
  const featureLabel = $derived(snapshotStore.activeFeatureLabel);
  const isPrimary = $derived(snapshotStore.isPrimary);
</script>

<header class="header status-{status}" data-testid="status-header">
  <div class="row">
    <span class="dot" aria-hidden="true"></span>
    <span class="label" data-testid="status-label">{formatStatus(status)}</span>
    {#if !isPrimary}
      <span class="not-primary" data-testid="not-primary-badge" title="Another window is the primary controller">
        secondary
      </span>
    {/if}
  </div>
  <div class="feature" data-testid="active-feature">
    {#if featureLabel}
      <span class="feature-label">{featureLabel}</span>
    {:else}
      <span class="feature-empty">no active feature</span>
    {/if}
  </div>
</header>

<style>
  .header {
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
  .dot {
    width: 0.65em;
    height: 0.65em;
    border-radius: 50%;
    background: var(--schegent-color-system);
  }
  .status-running .dot {
    background: var(--schegent-color-active);
  }
  .status-paused .dot {
    background: var(--schegent-color-warning);
  }
  .status-completed .dot {
    background: var(--schegent-color-completed);
  }
  .status-failed .dot {
    background: var(--schegent-color-error);
  }
  .status-canceled .dot {
    background: var(--schegent-muted-fg);
  }
  .label {
    font-weight: 600;
  }
  .not-primary {
    margin-left: auto;
    font-size: 0.8em;
    color: var(--schegent-color-warning);
    border: 1px solid currentColor;
    border-radius: 999px;
    padding: 0 6px;
  }
  .feature-label {
    color: var(--schegent-fg);
    font-size: 0.9em;
  }
  .feature-empty {
    color: var(--schegent-muted-fg);
    font-style: italic;
    font-size: 0.9em;
  }
</style>
