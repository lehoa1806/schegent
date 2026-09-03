<script lang="ts">
  import { postCommand } from '../lib/vscode-api';
  import { correlatedLifecycle, lifecycleMessage } from '../lib/lifecycle-control-ipc';
  import { CMD_START_QUEUE } from '../lib/messages';
  import type { QueueItem, QueueLifecycle } from '../lib/snapshot-types';
  import QueueItemActions from './QueueItemActions.svelte';

  interface Props {
    isPrimary: boolean;
    /**
     * The queue these controls act on. Named on the Start dispatch, because a
     * `CMD_START_QUEUE` with no `queueId` is read by the host as the default
     * queue — so an unnamed Start started a queue the operator was not looking
     * at (hard rule 56).
     */
    queueId: string;
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
     * dashboard surface does not race with the FR-018 chooser, now
     * `QueueIdlePendingPanel.svelte`. Optional for backward compatibility with
     * callers that have not yet been threaded with the lifecycle.
     */
    queueLifecycle?: QueueLifecycle | null;
    /**
     * Feature 195 (T031, FR-009) — the row this queue's halt names, or
     * `null` when the queue is not halted. Required-and-nullable like
     * `QueueRuntime.startFailure` itself (FR-007): always present, so this
     * component gains no existence guard and the caller cannot silently
     * omit it. Rendered here, in the queue header, so "the halt has a
     * stated way out" (FR-009) reads from the same surface that reports
     * the halt (`QueueStartFailureNotice`) rather than only from the row
     * list. Retry and remove are dispatched through `QueueItemActions`,
     * unmodified — this header adds no IPC call of its own.
     */
    haltedTask: QueueItem | null;
    onResume: (event: MouseEvent) => void;
    onPause: (event: MouseEvent) => void;
    onClearDone: (event: MouseEvent) => void;
    onClean: (event: MouseEvent) => void;
  }

  const {
    isPrimary,
    queueId,
    paused,
    pendingCount,
    hasInFlight,
    clearDoneDisabled,
    cleanDisabled,
    queueLifecycle = null,
    haltedTask,
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
  // suppress the `start` branch; the FR-018 chooser, now
  // `QueueIdlePendingPanel`, is the sole dispatcher of `CMD_START_QUEUE`
  // for that lifecycle state.
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

  // FR-R3-154 (T1646) — what the host answered about the last Start, as one
  // sentence, or `null` when it committed. Pause and Resume are the parent's
  // callbacks, not this component's posts, so they are not reported here.
  let startMessage = $state<string | null>(null);

  async function onAction(event: MouseEvent): Promise<void> {
    if (actionDisabled) return;
    if (action === 'start') {
      startMessage = null;
      startMessage = lifecycleMessage(
        await correlatedLifecycle(
          () => postCommand(CMD_START_QUEUE, { queueId } as never).correlationId
        )
      );
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
    class="btn btn-secondary"
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
  {#if startMessage !== null}
    <p class="start-message" role="alert" data-testid="dashboard-queue-start-message">{startMessage}</p>
  {/if}
  {#if haltedTask !== null}
    <!-- Feature 195 (T031, FR-007, FR-008, FR-009) — the header states the
         same fact and the same name `QueueStartFailureNotice` already
         reports, with retry and remove reachable here too (contract §3). -->
    <div class="halted-actions" data-testid="dashboard-queue-halted-actions">
      <span class="halted-actions-label">
        Halted: <strong>{haltedTask.label}</strong> failed
      </span>
      <QueueItemActions item={haltedTask} {isPrimary} />
    </div>
  {/if}
</div>

<style>
  .queue-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  /* Takes the whole row: the controls wrap, so an inline sentence would reflow
     the button it is reporting on. Colour matches `QueueDetailTier`'s
     `.refusal`. */
  .start-message {
    flex-basis: 100%;
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--vscode-errorForeground);
  }

  /* Takes the whole row for the same reason `.start-message` does — the
     controls wrap, so an inline sentence would reflow the button row. */
  .halted-actions {
    flex-basis: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 0 0;
  }
  .halted-actions-label {
    font-size: 12px;
    color: var(--vscode-errorForeground);
  }

  .btn {
    min-height: var(--schegent-control-height-compact);
    padding: 3px 8px;
    border-radius: var(--schegent-radius-sm);
    font-size: var(--schegent-text-caption);
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition:
      background-color var(--schegent-duration-fast) var(--schegent-ease-out),
      border-color var(--schegent-duration-fast) var(--schegent-ease-out),
      color var(--schegent-duration-fast) var(--schegent-ease-out),
      opacity var(--schegent-duration-fast) var(--schegent-ease-out);
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn:active:not(:disabled) { opacity: 0.8; }
  .btn-start { background: var(--schegent-color-completed); color: var(--vscode-button-foreground); }
  .btn-start:hover:not(:disabled) { background: color-mix(in srgb, var(--schegent-color-completed) 86%, black); }
  .btn-primary { background: var(--schegent-color-active); color: var(--vscode-button-foreground); }
  .btn-primary:hover:not(:disabled) { background: var(--schegent-button-hover); }
  .btn-secondary { background: var(--schegent-button-secondary-bg); color: var(--schegent-button-secondary-fg); }
  .btn-destructive { background: transparent; color: var(--schegent-error-text); border-color: var(--schegent-color-error); }
  .btn-destructive:hover:not(:disabled) { background: var(--schegent-color-error); color: var(--vscode-button-foreground); }
</style>
