<script lang="ts">
  import { postCommand } from '../lib/vscode-api';
  import {
    CMD_PAUSE_QUEUE,
    CMD_RESUME_QUEUE,
    CMD_CLEAR_COMPLETED,
    CMD_CLEAR_FAILED,
    CMD_OPEN_DASHBOARD
  } from '../lib/messages';

  interface Props {
    paused: boolean;
    isPrimary: boolean;
    completedCount: number;
    failedCount: number;
    /**
     * Feature 028 — `'cascade'` when the pause is a side effect of a phase
     * pause (or breakpoint fire); `'operator'` when the operator paused the
     * queue directly; `null` when the queue is active.
     */
    pauseSource?: 'operator' | 'cascade' | null;
  }

  // Feature 030 (US3, T042) — single-queue mode. The `queueId` prop was
  // removed: there is exactly one queue and CMD_PAUSE_QUEUE /
  // CMD_RESUME_QUEUE carry no payload. Per-queue payload branches were
  // deleted alongside the multi-queue surfaces.
  const { paused, isPrimary, completedCount, failedCount, pauseSource = null }: Props = $props();
  const showCascadedBadge = $derived(paused && pauseSource === 'cascade');

  const primaryDisabled = $derived(!isPrimary);
  const clearCompletedDisabled = $derived(primaryDisabled || completedCount === 0);
  const clearFailedDisabled = $derived(primaryDisabled || failedCount === 0);
  const dashboardDisabled = $derived(false);

  function aria(d: boolean): 'true' | 'false' {
    return d ? 'true' : 'false';
  }

  function onPause(): void {
    if (primaryDisabled) return;
    postCommand(CMD_PAUSE_QUEUE);
  }
  function onResume(): void {
    if (primaryDisabled) return;
    postCommand(CMD_RESUME_QUEUE);
  }
  function onClearCompleted(): void {
    if (clearCompletedDisabled) return;
    postCommand(CMD_CLEAR_COMPLETED);
  }
  function onClearFailed(): void {
    if (clearFailedDisabled) return;
    postCommand(CMD_CLEAR_FAILED);
  }
  function onOpenDashboard(): void {
    postCommand(CMD_OPEN_DASHBOARD);
  }
</script>

<div class="global-actions" data-testid="queue-global-actions">
  {#if paused}
    <button
      type="button"
      data-testid="queue-resume-button"
      aria-label="Resume queue"
      aria-disabled={aria(primaryDisabled)}
      onclick={onResume}
    >Resume Queue</button>
    {#if showCascadedBadge}
      <span
        class="cascade-badge"
        data-testid="queue-cascade-badge"
        title="Paused as a side effect of a phase pause. Resuming the phase will resume the queue."
      >cascaded</span>
    {/if}
  {:else}
    <button
      type="button"
      data-testid="queue-pause-button"
      aria-label="Pause queue"
      aria-disabled={aria(primaryDisabled)}
      onclick={onPause}
    >Pause Queue</button>
  {/if}
  <button
    type="button"
    data-testid="queue-clear-completed-button"
    aria-label="Clear completed items"
    aria-disabled={aria(clearCompletedDisabled)}
    onclick={onClearCompleted}
  >Clear Completed</button>
  <button
    type="button"
    data-testid="queue-clear-failed-button"
    aria-label="Clear failed items"
    aria-disabled={aria(clearFailedDisabled)}
    onclick={onClearFailed}
  >Clear Failed</button>
  <button
    type="button"
    data-testid="queue-open-dashboard-button"
    aria-label="Open dashboard"
    aria-disabled={aria(dashboardDisabled || primaryDisabled)}
    onclick={onOpenDashboard}
  >Open Dashboard</button>
</div>

<style>
  .global-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px var(--schegent-pad);
  }
  button {
    background: transparent;
    color: var(--schegent-muted-fg);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    padding: 0 6px;
    font: inherit;
    cursor: pointer;
    transition: transform 0.1s ease, opacity 0.1s ease;
  }
  button[aria-disabled='true'] {
    opacity: 0.55;
    cursor: not-allowed;
  }
  button:hover:not([aria-disabled='true']) {
    color: var(--schegent-fg);
  }
  button:active:not([aria-disabled='true']) {
    transform: scale(0.93);
    opacity: 0.8;
  }
  .cascade-badge {
    display: inline-flex;
    align-items: center;
    padding: 0 6px;
    border: 1px solid var(--schegent-warn, var(--schegent-border));
    border-radius: var(--schegent-radius);
    color: var(--schegent-warn-fg, var(--schegent-muted-fg));
    background: transparent;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
</style>
