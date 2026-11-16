<script lang="ts">
  import type { Snippet } from 'svelte';
  import { postCommand } from '../lib/vscode-api';
  import { correlatedLifecycle, lifecycleMessage, lifecycleWait } from '../lib/lifecycle-control-ipc';
  import { CMD_START_QUEUE } from '../lib/messages';
  import type { QueueItem, QueueLifecycle } from '../lib/snapshot-types';
  import QueueItemActions from './QueueItemActions.svelte';
  import SgMenu from './sg/SgMenu.svelte';

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
    /**
     * Where the header's other actions go. It is called with the two clear
     * actions as menu items, so a page header that keeps a single "More queue
     * actions" menu places them among its own items. Without it, these
     * controls draw that menu themselves.
     */
    actions?: Snippet<[Snippet]>;
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
    onClean,
    actions
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
  // FR-R4-F05 (O4, FR-024, FR-026) — a late answer replaces the interim text; unmounting aborts the wait.
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());
  const wait = lifecycleWait(lifetime.signal, (message) => (startMessage = message));

  async function onAction(event: MouseEvent): Promise<void> {
    if (actionDisabled) return;
    if (action === 'start') {
      startMessage = null;
      startMessage = lifecycleMessage(
        await correlatedLifecycle(CMD_START_QUEUE, { queueId }, (correlationId, payload) => {
          postCommand(CMD_START_QUEUE, payload as never, { correlationId });
        }, wait)
      );
    } else if (action === 'pause') {
      onPause(event);
    } else if (action === 'resume') {
      onResume(event);
    }
  }
</script>

<!-- The redesign's names for Clear Done and Clean All. Each asks before acting,
     which the trailing ellipsis says; Clean All is last and red because it is
     the destructive one. -->
{#snippet clearItems()}
  <button
    type="button"
    role="menuitem"
    data-testid="dashboard-queue-clear-done"
    onclick={onClearDone}
    aria-disabled={clearDoneDisabled || !isPrimary}
    title="Clear completed tasks from Recent"
  >Clear completed tasks…</button>
  <button
    type="button"
    role="menuitem"
    class="danger"
    data-testid="dashboard-queue-clean"
    data-action="clean-all"
    onclick={onClean}
    aria-disabled={cleanDisabled || !isPrimary}
    title="Clear all tasks, in-flight work, pause state, active run, and watchdog backoff"
  >Clear everything…</button>
{/snippet}

<div class="queue-controls">
  <!-- A secondary button, as the redesign draws Pause: the page's one primary
       action is adding a task. -->
  {#if action !== 'idle'}
    <button
      type="button"
      class="btn btn-secondary"
      data-testid="dashboard-queue-action"
      onclick={onAction}
      disabled={actionDisabled}
      title={actionTitle}
    ><svg class="i" aria-hidden="true"><use href={action === 'pause' ? '#i-pause' : '#i-play'}></use></svg>{actionLabel}</button>
  {/if}
  {#if actions}
    {@render actions(clearItems)}
  {:else}
    <SgMenu label="More queue actions">{@render clearItems()}</SgMenu>
  {/if}
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
  /* The right-hand side of the page header: the buttons keep to the right edge,
     and a sentence about them wraps onto its own line beneath them. */
  .queue-controls {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: var(--schegent-space-1-5);
  }

  /* Takes the whole row: the controls wrap, so an inline sentence would reflow
     the button it is reporting on. In error text, as a refused action reads. */
  .start-message {
    flex-basis: 100%;
    margin: 0;
    text-align: right;
    font-size: var(--schegent-text-secondary);
    color: var(--schegent-error-text);
  }

  /* Takes the whole row for the same reason `.start-message` does — the
     controls wrap, so an inline sentence would reflow the button row. */
  .halted-actions {
    flex-basis: 100%;
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: var(--schegent-space-1-5);
  }
  .halted-actions-label {
    font-size: var(--schegent-text-secondary);
    color: var(--schegent-error-text);
  }
</style>
