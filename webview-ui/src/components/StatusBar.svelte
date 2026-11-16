<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { formatDuration } from '../lib/format-duration';

  const status = $derived(snapshotStore.status);
  const featureLabel = $derived(snapshotStore.activeFeatureLabel);
  const isPrimary = $derived(snapshotStore.isPrimary);
  const elapsedMs = $derived(snapshotStore.workflowElapsedMs);
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

<!-- The mockup heads this section "Now running"; the product says "Current run", because the
     section also shows a run that is idle, paused or over. -->
<section class="sb-sec" data-testid="sidebar-status-row">
  <h2>Current run</h2>
  <!-- FR-R3-131 — `aria-label` is PROHIBITED on a generic span, and axe says so
       (`aria-prohibited-attr`) now that the scan reaches this webview. The dot is
       decorative twice over: the status is already the chip's own text, so labelling
       the dot made a screen reader announce the status twice. Hidden rather than given
       `role="img"` for that reason. -->
  <span class="chip status-{status}"><span class="dot" aria-hidden="true"></span>{status}</span>
  <div class="now-title" class:muted={!featureLabel} title={featureLabel || undefined}>
    {featureLabel || 'no active feature'}
  </div>
  <div class="small muted meta">
    {#if featureLabel && elapsedLabel !== null}
      <span data-testid="sidebar-elapsed-pill">{elapsedLabel}</span>
    {/if}
    {#if !isPrimary}
      <span
        class="push chip s-warn"
        data-testid="sidebar-secondary-badge"
        title="Another window is the primary controller"
      >secondary</span>
    {/if}
  </div>
</section>

<style>
  /* The status word is written in lower case, as the host sends it, and shown capitalised. */
  .chip {
    text-transform: capitalize;
  }
  /* The status colours of `sg-core.css` (`.s-run` and its siblings), keyed to the host's own
     status words. The word stays in the text colour of its status, and the accent draws only
     the dot. */
  .status-running {
    color: var(--schegent-status-active-text);
    --sg-status-color: var(--schegent-color-active);
  }
  .status-paused {
    color: var(--schegent-status-warning-text);
    --sg-status-color: var(--schegent-color-warning);
  }
  .status-completed {
    color: var(--schegent-status-completed-text);
    --sg-status-color: var(--schegent-color-completed);
  }
  .status-failed {
    color: var(--schegent-status-error-text);
    --sg-status-color: var(--schegent-color-error);
  }
  .status-idle,
  .status-canceled {
    color: var(--schegent-muted-fg);
  }
  .now-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: var(--schegent-space-2);
    font-variant-numeric: tabular-nums;
  }
</style>
