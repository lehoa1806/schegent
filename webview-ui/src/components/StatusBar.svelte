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

<div class="status-row status-{status}" data-testid="sidebar-status-row">
  <!-- FR-R3-131 — `aria-label` is PROHIBITED on a generic span, and axe says so
       (`aria-prohibited-attr`) now that the scan reaches this webview. The dot is
       decorative twice over: the status is already text three elements along
       (`.status-word`), so labelling the dot made a screen reader announce the
       status twice. Hidden rather than given `role="img"` for that reason. -->
  <span class="dot" aria-hidden="true"></span>
  {#if featureLabel}
    <span class="feature-label" title={featureLabel}>{featureLabel}</span>
  {:else}
    <em class="feature-empty">no active feature</em>
  {/if}
  <span class="status-word">{status}</span>
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
    gap: 8px;
    min-height: 40px;
    padding: 7px 10px;
    border-bottom: 1px solid var(--sch-glass-border);
    min-width: 0;
    background: var(--schegent-surface);
  }
  .dot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--schegent-color-system);
    transition: box-shadow 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .status-running .dot { background: var(--schegent-color-active); box-shadow: var(--sch-glow-active); }
  .status-paused .dot { background: var(--schegent-color-warning); }
  .status-completed .dot { background: var(--schegent-color-completed); box-shadow: var(--sch-glow-success); }
  .status-failed .dot { background: var(--schegent-color-error); }
  .status-canceled .dot { background: var(--schegent-muted-fg); }
  .feature-label {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--schegent-text-secondary);
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
    font-family: var(--schegent-mono-font);
    font-size: var(--schegent-text-caption);
    /* FR-R3-131 (T1498) — the same pair as the 24 baselined dashboard findings:
       the accent as small text on a tint of itself. Measured at 3 findings, one
       per theme, the first time the scan was pointed at this webview. The tinted
       background stays; only the text moves to the safe foreground. */
    color: var(--schegent-color-active-fg);
    background: color-mix(in srgb, var(--schegent-color-active) 12%, var(--schegent-surface));
    font-variant-numeric: tabular-nums;
    border-radius: var(--schegent-radius-sm);
    padding: 2px 5px;
    font-weight: 600;
  }
  .status-word {
    flex: 0 0 auto;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .secondary-badge {
    flex: 0 0 auto;
    font-size: 0.8em;
    color: var(--schegent-color-warning);
    border: 1px solid currentColor;
    border-radius: 999px;
    padding: 2px 8px;
    background: color-mix(in srgb, var(--schegent-color-warning) 12%, transparent);
  }
</style>
