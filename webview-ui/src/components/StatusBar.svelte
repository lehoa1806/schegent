<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { formatDuration } from '../lib/format-duration';
  import { postCommand } from '../lib/vscode-api';
  import { CMD_OPEN_DASHBOARD } from '../lib/messages';

  const status = $derived(snapshotStore.status);
  const defaultQueueName = $derived(snapshotStore.defaultQueueName);
  const queueScopeLabel = $derived(
    defaultQueueName.toLowerCase() === 'default'
      ? 'Default queue'
      : `Default queue · ${defaultQueueName}`
  );
  const featureLabel = $derived(snapshotStore.activeFeatureLabel);
  const isPrimary = $derived(snapshotStore.isPrimary);
  const elapsedMs = $derived(snapshotStore.workflowElapsedMs);
  const elapsedLabel = $derived(elapsedMs !== null ? formatDuration(elapsedMs) : null);
  const activeRunCount = $derived(snapshotStore.activeRunCount);
  const otherActiveRunCount = $derived(snapshotStore.otherActiveRunCount);
  const workspaceRunsSummary = $derived(
    formatWorkspaceRunsSummary(activeRunCount, otherActiveRunCount)
  );

  function formatWorkspaceRunsSummary(total: number, other: number): string {
    const runWord = total === 1 ? 'active run' : 'active runs';
    if (other > 0) {
      return `${total} ${runWord} (${other} in other queues)`;
    }
    return `${total} ${runWord} in workspace`;
  }

  function openDashboard(): void {
    postCommand(CMD_OPEN_DASHBOARD);
  }
</script>

<!-- FR-R7-14 (14-16) — the status row projects the default queue's Run and surfaces
     workspace-wide active run counts plus direct navigation to the queue-aware Dashboard
     so an idle default queue never hides active named-queue runs. -->
<section class="sb-sec" data-testid="sidebar-status-row">
  <h2 class="queue-scope" data-testid="sidebar-status-queue-scope" title={queueScopeLabel}>
    {queueScopeLabel}
  </h2>
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
  <div class="small workspace-runs" data-testid="sidebar-workspace-runs">
    <span
      class="workspace-runs-summary"
      class:muted={otherActiveRunCount === 0}
      class:workspace-runs-other={otherActiveRunCount > 0}
      data-testid="sidebar-active-run-count"
    >{workspaceRunsSummary}</span>
    <button
      type="button"
      class="linkbtn queue-view-link"
      data-testid="sidebar-status-open-dashboard"
      aria-label="View queues in Dashboard"
      onclick={openDashboard}
    >View queues</button>
  </div>
</section>

<style>
  .queue-scope {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
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
  .workspace-runs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--schegent-space-1-5);
    margin-top: var(--schegent-space-2);
  }
  .workspace-runs-summary {
    min-width: 0;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .workspace-runs-other {
    color: var(--schegent-status-active-text);
    font-weight: 600;
  }
  .queue-view-link {
    font-size: var(--schegent-text-secondary);
    white-space: nowrap;
    flex-shrink: 0;
  }
</style>
