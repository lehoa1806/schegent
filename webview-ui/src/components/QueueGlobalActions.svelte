<script lang="ts">
  import { postCommand } from '../lib/vscode-api';
  import {
    CMD_PAUSE_QUEUE,
    CMD_RESUME_QUEUE,
    CMD_START_QUEUE,
    CMD_CLEAR_COMPLETED,
    CMD_CLEAR_FAILED,
    CMD_OPEN_DASHBOARD
  } from '../lib/messages';
  import type { QueueLifecycle, QueueSummary } from '../lib/snapshot-types';

  interface Props {
    paused: boolean;
    isPrimary: boolean;
    completedCount: number;
    failedCount: number;
    /** BUG-003 / FR-012a — number of pending tasks in the queue. */
    pendingCount: number;
    /** BUG-003 / FR-012a — true when a run is actively in-flight. */
    hasInFlight: boolean;
    /**
     * Feature 028 — `'cascade'` when the pause is a side effect of a phase
     * pause (or breakpoint fire); `'operator'` when the operator paused the
     * queue directly; `null` when the queue is active.
     *
     * FR-R3-132 (T1502) — `'retry-cap'` was MISSING from this union, and from
     * the snapshot mirror above it. `src/contracts/queue-snapshot.ts` has
     * declared it since Feature 030 BUG-001 and says in the same breath that
     * *"UI uses this to label the queue badge as 'cascaded' / 'retry-cap'"* —
     * the label did not exist. A retry-handler pause therefore reached this
     * component as a value its own type said was impossible and rendered as an
     * unexplained pause. The type is now the contract's, and the badge below is
     * the label the contract promised.
     */
    pauseSource?: QueueSummary['pauseSource'];
    /**
     * Feature 065 BUG-007 / FR-018 — when `queueLifecycle === 'idle-pending'`,
     * the `action === 'start'` branch is suppressed so the FR-018 chooser
     * surface, now `QueueIdlePendingPanel.svelte`, remains the sole dispatcher
     * of `CMD_START_QUEUE` against an idle-pending queue. Pause/Resume are
     * unaffected; the suppression is intentionally narrow.
     */
    queueLifecycle?: QueueLifecycle | null;
  }

  const {
    paused,
    isPrimary,
    completedCount,
    failedCount,
    pendingCount,
    hasInFlight,
    pauseSource = null,
    queueLifecycle = null
  }: Props = $props();

  const showCascadedBadge = $derived(paused && pauseSource === 'cascade');
  const showRetryCapBadge = $derived(paused && pauseSource === 'retry-cap');

  const primaryDisabled = $derived(!isPrimary);
  const clearCompletedDisabled = $derived(primaryDisabled || completedCount === 0);
  const clearFailedDisabled = $derived(primaryDisabled || failedCount === 0);

  // BUG-003 / FR-012a — tri-state derivation for the contextual button.
  // Feature 065 BUG-007 / FR-018 — when `queueLifecycle === 'idle-pending'`,
  // the `start` branch is suppressed (resolves to `idle`) so this surface
  // does not race with the chooser, now QueueIdlePendingPanel.
  type QueueAction = 'start' | 'pause' | 'resume' | 'idle';

  const action = $derived<QueueAction>(
    paused
      ? 'resume'
      : hasInFlight
        ? 'pause'
        : pendingCount > 0 && queueLifecycle !== 'idle-pending'
          ? 'start'
          : 'idle'
  );

  const actionLabel = $derived(
    action === 'start' ? 'Start Queue'
      : action === 'pause' ? 'Pause Queue'
        : action === 'resume' ? 'Resume Queue'
          : ''
  );

  function aria(d: boolean): 'true' | 'false' {
    return d ? 'true' : 'false';
  }

  let resumePromptStr = $state('');

  function onAction(): void {
    if (primaryDisabled) return;
    if (action === 'start') {
      postCommand(CMD_START_QUEUE);
    } else if (action === 'pause') {
      postCommand(CMD_PAUSE_QUEUE);
    } else if (action === 'resume') {
      postCommand(CMD_RESUME_QUEUE, { prompt: resumePromptStr.trim() || undefined } as any);
      resumePromptStr = '';
    }
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
  {#if action !== 'idle'}
    {#if action === 'resume'}
      <input
        type="text"
        class="resume-prompt-input"
        aria-label="Resume queue prompt"
        placeholder="Custom prompt... (optional)"
        bind:value={resumePromptStr}
        onkeydown={(e) => e.key === 'Enter' && onAction()}
      />
    {/if}
    <button
      type="button"
      data-testid="queue-action-button"
      aria-label={actionLabel}
      aria-disabled={aria(primaryDisabled)}
      class:start-action={action === 'start'}
      onclick={onAction}
    >{actionLabel}</button>
    {#if showCascadedBadge}
      <span
        class="cascade-badge"
        data-testid="queue-cascade-badge"
        title="Paused as a side effect of a phase pause. Resuming the phase will resume the queue."
      >cascaded</span>
    {/if}
    {#if showRetryCapBadge}
      <span
        class="cascade-badge"
        data-testid="queue-retry-cap-badge"
        title="Paused by the retry handler: the delayed-retry budget for this queue is exhausted. Resuming retries the next item immediately."
      >retry cap</span>
    {/if}
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
  .start-action {
    background: var(--schegent-color-completed);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  .start-action:hover:not([aria-disabled='true']) {
    box-shadow: var(--sch-glow-success);
    color: var(--vscode-button-foreground);
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
  .resume-prompt-input {
    min-height: 20px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    padding: 0 8px;
    font: inherit;
    width: 200px;
    outline: none;
    transition: border-color 0.2s ease;
  }
  .resume-prompt-input:focus {
    border-color: var(--vscode-focusBorder);
  }
</style>
