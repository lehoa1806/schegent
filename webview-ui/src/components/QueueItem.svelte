<script lang="ts">
  import type { QueueItem } from '../lib/snapshot-types';
  import { formatPhaseLabel, formatRelativeTime } from '../lib/format';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import QueueItemActions from './QueueItemActions.svelte';
  // Feature 030 (US2, T034) — reorder UX. Drag-and-drop + arrow buttons
  // route through the shared helper so the lint regression at
  // tests/lint/no-inline-reorder-ipc.test.ts keeps the build green.
  import {
    postMoveItemUp,
    postMoveItemDown,
    postReorderTask
  } from '../lib/reorder-task';

  let { item }: { item: QueueItem } = $props();

  const isPrimary = $derived(snapshotStore.isPrimary);
  // Reorder UX only renders for pending tasks (FR-008). In-flight,
  // completed, failed, paused, canceled rows hide drag-and-drop AND the
  // arrow buttons so the queue ordering stays operator-stable.
  const showReorderControls = $derived(item.status === 'pending');
  const enqueuedAtLabel = $derived(formatRelativeTime(item.enqueuedAt));
  const updatedAtLabel = $derived(formatRelativeTime(item.updatedAt));
  const showRetryBadge = $derived(item.retryCount > 0);
  const showPausedReason = $derived(item.pausedReason !== null && item.pausedReason.length > 0);
  const showLastError = $derived(
    item.lastErrorSummary !== null && item.lastErrorSummary.length > 0
  );
  const showCurrentPhase = $derived(
    item.status === 'in-flight' && item.currentPhase !== null
  );
  const queueName = $derived(
    snapshotStore.queue.queues?.find((queue) => queue.id === (item.queueId ?? 'default'))?.name ??
      'Default queue'
  );
  const pauseCauseLabel = $derived(
    item.pauseCause === 'queue-paused'
      ? 'Queue paused'
      : item.pauseCause === 'phase-paused'
        ? 'Paused (operator)'
        : item.pauseCause === 'breakpoint'
          ? 'Paused (breakpoint)'
          : item.pauseCause === 'manually-paused-task'
            ? 'Task paused'
            : null
  );
  const pauseCauseTitle = $derived(
    item.pauseCause === 'queue-paused'
      ? 'Queue-level pause; resume the queue to continue this task'
      : item.pauseCause === 'phase-paused'
        ? 'Operator paused the active phase; resume to continue this task'
        : item.pauseCause === 'breakpoint'
          ? 'Pipeline halted at a future-phase breakpoint; resume to invoke the marked phase'
          : item.pauseCause === 'manually-paused-task'
            ? 'Task-level pause; resume the task to continue'
            : null
  );

  let errorOpen = $state(false);
  function toggleError(): void {
    errorOpen = !errorOpen;
  }

  // Feature 030 (US2, T034) — drag-and-drop reorder. The drag source
  // sets the task id on the dataTransfer; the host re-validates the
  // (taskId, newPosition) tuple against the current snapshot before
  // mutating state, so an "invalid" drop (onto/above the in-flight
  // row, or onto itself) is rejected with `cause: 'task-not-pending'`
  // or `cause: 'no-op'` at the host. The webview UI mirrors the
  // host's reject set with no double-validation.
  function onDragStart(ev: DragEvent): void {
    if (!showReorderControls) return;
    if (ev.dataTransfer) {
      ev.dataTransfer.setData('text/plain', item.id);
      ev.dataTransfer.effectAllowed = 'move';
    }
  }

  function onDragOver(ev: DragEvent): void {
    // Pending rows accept drops; non-pending rows (in-flight, history)
    // do NOT — the dragover handler is the only place we can signal
    // disallowed targets to the browser.
    if (!showReorderControls) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
  }

  function onDrop(ev: DragEvent): void {
    if (!showReorderControls) return;
    ev.preventDefault();
    const sourceId = ev.dataTransfer?.getData('text/plain') ?? '';
    if (sourceId.length === 0 || sourceId === item.id) return;
    // The drop target's pending-row position is the new position for
    // the dragged task. We bind it from the `position` snapshot field;
    // the host re-derives this from its authoritative state for the
    // final `task-reordered` audit.
    void postReorderTask(sourceId, item.position);
  }

  function onMoveUp(): void {
    if (!showReorderControls) return;
    void postMoveItemUp(item.id);
  }

  function onMoveDown(): void {
    if (!showReorderControls) return;
    void postMoveItemDown(item.id);
  }

  let dragEnabled = $state(false);

  function onHandleMouseDown(): void {
    if (showReorderControls) dragEnabled = true;
  }

  function onHandleMouseUp(): void {
    dragEnabled = false;
  }

  function onDragEnd(): void {
    dragEnabled = false;
  }
</script>

<li
  class="item status-{item.status}"
  data-testid="queue-item-{item.id}"
  data-queue-status={item.status}
  draggable={showReorderControls && dragEnabled}
  ondragstart={onDragStart}
  ondragover={onDragOver}
  ondrop={onDrop}
  ondragend={onDragEnd}
>
  <div class="row row-1">
    <div class="row-1-left">
      {#if showReorderControls}
        <span
          class="drag-handle"
          data-testid="queue-item-drag-handle-{item.id}"
          aria-hidden="true"
          title="Drag to reorder"
          onmousedown={onHandleMouseDown}
          onmouseup={onHandleMouseUp}
          onmouseleave={onHandleMouseUp}
        >⋮⋮</span>
      {/if}
      <span class="id" title={item.id}>{item.id}</span>
      <span class="time" data-testid="queue-item-enqueued-{item.id}">{enqueuedAtLabel}</span>
    </div>
    <div class="row-1-right">
      <span class="pill" data-testid="queue-item-status-{item.id}">{item.status}</span>
      <span class="actions-slot">
        {#if showReorderControls}
          <button
            type="button"
            class="reorder-btn"
            data-testid="queue-item-reorder-up-{item.id}"
            title="Move up"
            aria-label="Move task up"
            onclick={onMoveUp}
          >▲</button>
          <button
            type="button"
            class="reorder-btn"
            data-testid="queue-item-reorder-down-{item.id}"
            title="Move down"
            aria-label="Move task down"
            onclick={onMoveDown}
          >▼</button>
        {/if}
        <QueueItemActions {item} {isPrimary} />
      </span>
    </div>
  </div>

  <div class="row row-2">
    <span class="label" title={item.label}>{item.label}</span>
  </div>

  <div class="row row-3 meta">
    <span class="chip queue-chip" data-testid="queue-item-queue-{item.id}">{queueName}</span>
    {#if pauseCauseLabel}
      <span
        class="chip paused-chip"
        data-testid="queue-item-pause-cause-{item.id}"
        title={pauseCauseTitle ?? ''}
      >
        {pauseCauseLabel}
      </span>
    {/if}
    {#if showCurrentPhase && item.currentPhase}
      {@const phaseTile = snapshotStore.phaseByName(item.currentPhase)}
      <span class="chip phase-chip" data-testid="queue-item-phase-{item.id}">
        {formatPhaseLabel(item.currentPhase, phaseTile?.displayName)}
      </span>
    {/if}
    {#if showRetryBadge}
      <span class="badge retry-badge" data-testid="queue-item-retry-badge-{item.id}"
        title="Retry count">×{item.retryCount}</span>
    {/if}
    {#if showPausedReason}
      <span class="chip paused-chip" data-testid="queue-item-paused-{item.id}"
        title={item.pausedReason ?? ''}>{item.pausedReason}</span>
    {/if}
    <span class="time time-updated" data-testid="queue-item-updated-{item.id}"
      title="Last update">↻ {updatedAtLabel}</span>
  </div>

  {#if showLastError && item.lastErrorSummary}
    <button
      type="button"
      class="error-toggle"
      data-testid="queue-item-error-toggle-{item.id}"
      aria-expanded={errorOpen ? 'true' : 'false'}
      aria-controls="queue-item-error-{item.id}"
      onclick={toggleError}
    >{errorOpen ? 'Hide error' : 'Show last error'}</button>
    {#if errorOpen}
      <div
        id="queue-item-error-{item.id}"
        class="error-body"
        data-testid="queue-item-error-{item.id}"
        role="region"
        aria-label="Last error for {item.label}"
      >{item.lastErrorSummary}</div>
    {/if}
  {/if}
</li>

<style>
  .item {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px var(--schegent-pad);
    border-radius: var(--schegent-radius);
    border: 1px solid transparent;
  }
  .item:hover {
    background: var(--schegent-list-hover);
    border-color: var(--schegent-border);
  }
  .row-1 {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .row-1-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0; /* allows truncation */
  }
  .row-1-right {
    display: flex;
    align-items: center;
    gap: var(--schegent-gap);
    flex-shrink: 0;
  }
  .id {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    color: var(--schegent-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .time {
    font-size: 0.85em;
    color: var(--schegent-muted-fg);
    white-space: nowrap;
  }
  .row-2 {
    display: flex;
    padding-left: 4px;
  }
  .label {
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--schegent-fg);
    font-size: 0.95em;
    line-height: 1.4;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--schegent-gap);
    align-items: center;
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
    padding-left: 4px;
  }
  .pill {
    border: 1px solid var(--schegent-border);
    border-radius: 999px;
    padding: 0 8px;
    font-size: 0.85em;
    font-weight: 500;
  }
  .status-in-flight .pill {
    color: var(--schegent-color-active);
    border-color: currentColor;
    background: color-mix(in srgb, var(--schegent-color-active) 10%, transparent);
  }
  .status-completed .pill {
    color: var(--schegent-color-completed);
    border-color: currentColor;
  }
  .status-failed .pill {
    color: var(--schegent-color-error);
    border-color: currentColor;
  }
  .status-canceled .pill {
    color: var(--schegent-muted-fg);
  }
  .chip {
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    padding: 0 6px;
    background: transparent;
  }
  .phase-chip {
    color: var(--schegent-color-active);
    border-color: currentColor;
  }
  .paused-chip {
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    border-radius: var(--schegent-radius);
    padding: 0 6px;
    background: transparent;
    border: 1px solid var(--schegent-border);
  }
  .retry-badge {
    color: var(--schegent-color-error);
    border-color: currentColor;
  }
  .time-updated {
    opacity: 0.85;
  }
  .error-toggle {
    align-self: flex-start;
    background: transparent;
    color: var(--schegent-muted-fg);
    border: 1px dashed var(--schegent-border);
    border-radius: var(--schegent-radius);
    padding: 0 6px;
    font: inherit;
    font-size: 0.85em;
    cursor: pointer;
    margin-left: 4px;
  }
  .error-toggle:hover {
    color: var(--schegent-fg);
  }
  .error-body {
    padding: 4px 6px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    color: var(--schegent-color-error);
    background: transparent;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    white-space: pre-wrap;
    word-break: break-word;
    margin-left: 4px;
  }
  .actions-slot {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .drag-handle {
    padding: 0 4px;
    color: var(--schegent-muted-fg);
    cursor: grab;
    user-select: none;
    font-size: 0.9em;
    letter-spacing: -2px;
    flex-shrink: 0;
  }
  .item[draggable='true']:active .drag-handle {
    cursor: grabbing;
  }
  .reorder-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    background: transparent;
    color: var(--schegent-muted-fg);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    font: inherit;
    line-height: 1;
    cursor: pointer;
  }
  .reorder-btn:hover {
    color: var(--schegent-fg);
    background: var(--schegent-list-hover);
  }
  .reorder-btn:focus-visible {
    outline: 2px solid var(--schegent-color-active);
    outline-offset: 1px;
  }
</style>
