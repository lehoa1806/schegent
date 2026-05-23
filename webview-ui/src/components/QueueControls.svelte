<script lang="ts">
  import { postCommand } from '../lib/vscode-api';
  import { CMD_START_QUEUE } from '../lib/messages';
  import type { QueueLifecycle } from '../lib/snapshot-types';

  interface Props {
    isPrimary: boolean;
    /** True when the queue is paused (manually or cascaded). */
    paused: boolean;
    /** Number of pending tasks in the queue. */
    pendingCount: number;
    /** True when a run is actively in-flight. */
    hasInFlight: boolean;
    clearDoneDisabled: boolean;
    cleanDisabled: boolean;
    /**
     * Feature 065 BUG-007 / FR-018 — when `queueLifecycle === 'idle-pending'`,
     * the `action === 'start'` branch resolves to `'idle'` so this
     * dashboard surface does not race with the FR-018 chooser in
     * `QueueListView.svelte`. Optional for backward compatibility with
     * callers that have not yet been threaded with the lifecycle.
     */
    queueLifecycle?: QueueLifecycle | null;
    onResume: (event: MouseEvent) => void;
    onPause: (event: MouseEvent) => void;
    onClearDone: (event: MouseEvent) => void;
    onClean: (event: MouseEvent) => void;
  }

  const {
    isPrimary,
    paused,
    pendingCount,
    hasInFlight,
    clearDoneDisabled,
    cleanDisabled,
    queueLifecycle = null,
    onResume,
    onPause,
    onClearDone,
    onClean
  }: Props = $props();

  // BUG-003 / FR-012a — tri-state derivation for the contextual button.
  //  - 'start':  pending tasks exist, no run in-flight, queue not paused
  //  - 'pause':  a run is in-flight and the queue is not paused
  //  - 'resume': the queue is paused (any cause)
  //  - 'idle':   nothing pending, nothing in-flight, not paused — hide button
  //
  // Feature 065 BUG-007 / FR-018 — `idle-pending` queues additionally
  // suppress the `start` branch; the FR-018 chooser in QueueListView is
  // the sole dispatcher of `CMD_START_QUEUE` for that lifecycle state.
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
      : action === 'pause' ? 'Pause'
        : action === 'resume' ? 'Resume'
          : ''
  );

  const actionTitle = $derived(
    action === 'start' ? 'Start processing the next pending task'
      : action === 'pause' ? 'Pause the queue'
        : action === 'resume' ? 'Resume the queue'
          : ''
  );

  const actionDisabled = $derived(!isPrimary || action === 'idle');

  function onAction(event: MouseEvent): void {
    if (actionDisabled) return;
    if (action === 'start') {
      postCommand(CMD_START_QUEUE);
    } else if (action === 'pause') {
      onPause(event);
    } else if (action === 'resume') {
      onResume(event);
    }
  }
</script>

<div class="queue-controls">
  {#if action !== 'idle'}
    <button
      type="button"
      class="btn"
      class:btn-start={action === 'start'}
      class:btn-primary={action === 'resume'}
      class:btn-secondary={action === 'pause'}
      data-testid="dashboard-queue-action"
      onclick={onAction}
      disabled={actionDisabled}
      title={actionTitle}
    >{actionLabel}</button>
  {/if}
  <button
    type="button"
    class="btn btn-ghost"
    data-testid="dashboard-queue-clear-done"
    onclick={onClearDone}
    disabled={clearDoneDisabled || !isPrimary}
    title="Clear completed tasks from Recent"
  >Clear Done</button>
  <button
    type="button"
    class="btn btn-destructive"
    data-testid="dashboard-queue-clean"
    data-action="clean-all"
    onclick={onClean}
    disabled={cleanDisabled || !isPrimary}
    title="Clear all tasks, in-flight work, pause state, active run, and watchdog backoff"
  >Clean All</button>
</div>

<style>
  .queue-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: var(--schegent-gap);
  }

  .btn {
    padding: 4px 12px;
    border-radius: var(--schegent-radius);
    font-size: 0.9em;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: transform 0.1s ease, opacity 0.1s ease;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn:active:not(:disabled) { transform: scale(0.93); opacity: 0.8; }
  .btn-start { background: var(--schegent-color-completed); color: var(--vscode-button-foreground); }
  .btn-start:hover:not(:disabled) { box-shadow: var(--sch-glow-success); }
  .btn-primary { background: var(--schegent-color-active); color: var(--vscode-button-foreground); }
  .btn-primary:hover:not(:disabled) { box-shadow: var(--sch-glow-active); }
  .btn-secondary { background: var(--schegent-button-secondary-bg); color: var(--schegent-button-secondary-fg); }
  .btn-ghost { background: transparent; color: var(--schegent-muted-fg); }
  .btn-ghost:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
  .btn-destructive { background: transparent; color: var(--schegent-color-error); border-color: var(--schegent-color-error); }
  .btn-destructive:hover:not(:disabled) { background: var(--schegent-color-error); color: var(--vscode-button-foreground); }
</style>
