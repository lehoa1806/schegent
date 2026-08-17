<script lang="ts">
  import type { QueueItem } from '../lib/snapshot-types';
  import { formatPhaseLabel, formatRelativeTime } from '../lib/format';
  import { formatDuration } from '../lib/format-duration';
  import { nowFine } from '../lib/tick-store';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import QueueItemError from './QueueItemError.svelte';
  import QueueItemFooter from './QueueItemFooter.svelte';
  import QueueItemMeta from './QueueItemMeta.svelte';
  // Feature 030 (US2, T034) — reorder UX. Drag-and-drop + arrow buttons
  // route through the shared helper so the lint regression at
  // tests/lint/no-inline-reorder-ipc.test.ts keeps the build green.
  import {
    postMoveItemUp,
    postMoveItemDown,
    postReorderTask
  } from '../lib/reorder-task';

  interface Props {
    item: QueueItem;
    /**
     * BUG-009 (T079) — props added so all queue surfaces (sidebar
     * `QueueListView`, dashboard "Active Queue" panel) could render via
     * the shared component. Feature 097 deletes `QueueListView.svelte`;
     * neither named surface renders this component today. `isSelected`
     * drives the `.activity-selected` highlight; `onSelect` (when present)
     * makes the id chip clickable so the Activity Feed can bind to this row.
     */
    isSelected?: boolean;
    onSelect?: () => void;
    /**
     * BUG-009 (T079) — per-surface `data-testid` prefix. Defaults to
     * `'queue-item'` (sidebar contract preserved). The dashboard surface
     * passes `'dashboard-queue-item'` so its surface-specific tests can
     * target the root `<li>` and identity chips without colliding with
     * the sidebar tests when both surfaces mount simultaneously. The
     * per-row action button testids (Retry / Cancel / Remove) and the
     * inner status badge testid remain unprefixed because they originate
     * in the shared `<QueueItemActions>` component and are consumed by
     * both surfaces with identical names.
     */
    testIdPrefix?: string;
  }
  let {
    item,
    isSelected = false,
    onSelect,
    testIdPrefix = 'queue-item'
  }: Props = $props();

  const isPrimary = $derived(snapshotStore.isPrimary);
  // Reorder UX only renders for pending tasks (FR-008). In-flight,
  // completed, failed, paused, canceled rows hide drag-and-drop AND the
  // arrow buttons so the queue ordering stays operator-stable.
  const showReorderControls = $derived(item.status === 'pending');
  const enqueuedAtLabel = $derived(formatRelativeTime(item.enqueuedAt));
  const showLastError = $derived(
    item.lastErrorSummary != null && item.lastErrorSummary.length > 0
  );

  // BUG-007 — conditional row-3 meta-chip block. The card renders rows 1+2
  // by default (id+time+status / prompt); row 3 only appears when there's
  // diagnostic context worth surfacing: an in-flight task's current phase,
  // a non-zero retry counter, or a pause indicator with cause. Each chip
  // is independently gated so an in-flight task with `retryCount: 0` only
  // shows the phase chip, etc.
  const showCurrentPhase = $derived(
    item.status === 'in-flight' && item.currentPhase !== null
  );
  const showRetryBadge = $derived(item.retryCount > 0);
  const showPausedReason = $derived(
    item.pauseCause !== null && item.pauseCause !== undefined
  );
  // Feature 065 / BUG-006 (T072) — paused-row badge. The host projector
  // emits `item.paused` only on rows with `status === 'paused'`. The
  // badge label distinguishes operator-paused vs. system-paused (rate
  // limit). For system-paused rows with a finite `resetsAtMs > now`, a
  // countdown chip is rendered using the shared `nowFine` 1-second
  // ticker (no per-row `setInterval`).
  const showPausedBadge = $derived(item.paused !== undefined);
  const pausedBadgeLabel = $derived.by(() => {
    if (!item.paused) return '';
    if (item.paused.pauseSource === 'system-paused') {
      switch (item.paused.pauseCauseCategory) {
        case 'rate-limit':
          return 'Paused (rate-limit)';
        case 'fatal-signature':
          return 'Paused (fatal)';
        case 'operator-canceled':
          return 'Paused';
        default:
          return 'Paused (system)';
      }
    }
    return 'Paused';
  });
  const resumeRemainingMs = $derived.by(() => {
    if (!item.paused) return null;
    const target = item.paused.resetsAtMs;
    if (typeof target !== 'number' || !Number.isFinite(target)) return null;
    const remaining = target - $nowFine;
    return remaining > 0 ? remaining : 0;
  });
  const showResumeCountdown = $derived(
    item.paused !== undefined &&
      typeof item.paused.resetsAtMs === 'number' &&
      Number.isFinite(item.paused.resetsAtMs) &&
      resumeRemainingMs !== null &&
      resumeRemainingMs > 0
  );
  const resumeCountdownLabel = $derived(
    resumeRemainingMs !== null && resumeRemainingMs > 0
      ? `auto-resumes in ${formatDuration(resumeRemainingMs)}`
      : 'auto-resume due'
  );
  const hasMetaChips = $derived(
    showCurrentPhase || showRetryBadge || showPausedReason || showPausedBadge
  );
  const phaseChipLabel = $derived(
    item.currentPhase !== null ? formatPhaseLabel(item.currentPhase) : ''
  );
  const pauseCauseLabel = $derived.by(() => {
    switch (item.pauseCause) {
      case 'queue-paused':
        return 'Queue paused';
      case 'phase-paused':
        return 'Paused (operator)';
      case 'manually-paused-task':
        return 'Task paused';
      case 'breakpoint':
        return 'Paused (breakpoint)';
      default:
        return '';
    }
  });
  const pauseCauseTitle = $derived.by(() => {
    // Operator-friendly tooltip text — describe the remediation rather
    // than just restating the label. The unit test pins specific
    // substrings so the wording stays predictable.
    switch (item.pauseCause) {
      case 'queue-paused':
        return 'The queue is paused — resume the queue to continue.';
      case 'phase-paused':
        return 'Operator paused the active phase.';
      case 'manually-paused-task':
        return 'The task is paused — resume the task to continue.';
      case 'breakpoint':
        return 'Paused at a phase breakpoint.';
      default:
        return item.pausedReason ?? '';
    }
  });

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
  class="item status-{item.status} {isSelected ? 'activity-selected' : ''}"
  data-testid="{testIdPrefix}-{item.id}"
  aria-current={isSelected ? 'true' : undefined}
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
        <button
          type="button"
          class="drag-handle"
          data-testid="queue-item-drag-handle-{item.id}"
          aria-label="Drag to reorder"
          title="Drag to reorder"
          onmousedown={onHandleMouseDown}
          onmouseup={onHandleMouseUp}
        >
          <svg
            class="drag-handle-icon"
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="6" cy="3" r="1.2" />
            <circle cx="6" cy="7" r="1.2" />
            <circle cx="6" cy="11" r="1.2" />
            <circle cx="6" cy="15" r="1.2" />
            <circle cx="10" cy="3" r="1.2" />
            <circle cx="10" cy="7" r="1.2" />
            <circle cx="10" cy="11" r="1.2" />
            <circle cx="10" cy="15" r="1.2" />
          </svg>
        </button>
      {/if}
      {#if onSelect}
        <button
          type="button"
          class="item-select id"
          data-testid="{testIdPrefix}-select-{item.id}"
          aria-label="Select task {item.id}"
          title="Select task {item.id}"
          onclick={onSelect}
        >
          <span data-testid="{testIdPrefix}-id-{item.id}">{item.id}</span>
        </button>
      {:else}
        <span class="id" data-testid="{testIdPrefix}-id-{item.id}" title={item.id}>{item.id}</span>
      {/if}
    </div>
    <div class="row-1-right">
      <span class="pill" data-testid="queue-item-status-{item.id}">{item.status}</span>
    </div>
  </div>

  <div class="row row-2">
    <!--
      BUG-009 (T079) — empty-label fallback. A pending task with no
      prompt (e.g. a placeholder enqueue) renders the literal
      `(no prompt)` so the row still has a visible label. The `title`
      attribute reflects the raw value so screen readers and tooltips
      stay accurate even when the visible text falls back.
    -->
    {#if onSelect}
      <button
        type="button"
        class="label item-label-select"
        data-testid="{testIdPrefix}-label-{item.id}"
        aria-label={`Select task ${item.label.length > 0 ? item.label : item.id}`}
        aria-pressed={isSelected}
        title={item.label}
        onclick={onSelect}
      >{item.label.length > 0 ? item.label : '(no prompt)'}</button>
    {:else}
      <span class="label" data-testid="{testIdPrefix}-label-{item.id}" title={item.label}>{item.label.length > 0 ? item.label : '(no prompt)'}</span>
    {/if}
  </div>

  {#if hasMetaChips}
    <QueueItemMeta
      {item}
      {showCurrentPhase}
      {showPausedReason}
      {showPausedBadge}
      {showResumeCountdown}
      {showRetryBadge}
      {phaseChipLabel}
      {pauseCauseLabel}
      {pauseCauseTitle}
      {pausedBadgeLabel}
      {resumeCountdownLabel}
    />
  {/if}

  <QueueItemFooter
    {item}
    {isPrimary}
    {showReorderControls}
    {enqueuedAtLabel}
    {testIdPrefix}
    {onMoveUp}
    {onMoveDown}
  />

  <QueueItemError {item} {showLastError} open={errorOpen} onToggle={toggleError} />
</li>

<style>
  .item {
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--schegent-radius-sm);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    transition:
      border-color var(--schegent-duration-base) var(--schegent-ease-out),
      background-color var(--schegent-duration-base) var(--schegent-ease-out);
  }
  .item:hover {
    background: var(--schegent-surface-hover);
  }
  .item.activity-selected {
    border-color: var(--schegent-color-active);
    background: var(--schegent-surface-active);
  }
  .item-select {
    background: transparent;
    color: inherit;
    border: 0;
    padding: 0;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--schegent-text-caption);
    color: var(--schegent-muted-fg);
  }
  .item-select:focus-visible {
    outline: 1px solid var(--schegent-focus-border);
    outline-offset: 3px;
    border-radius: var(--schegent-radius);
  }
  .item-select:hover {
    color: var(--schegent-fg);
    text-decoration: underline;
  }
  .item-label-select {
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 0;
    text-align: left;
    cursor: pointer;
  }
  .item-label-select:hover {
    text-decoration: underline;
  }
  .item-label-select:focus-visible {
    border-radius: var(--schegent-radius-sm);
    outline: 1px solid var(--schegent-focus-border);
    outline-offset: 2px;
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
    gap: var(--schegent-space-2);
    flex-shrink: 0;
  }
  .id {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--schegent-text-caption);
    color: var(--schegent-muted-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-2 {
    display: flex;
    order: -1;
    padding-left: 20px;
    min-width: 0;
  }
  .label {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--schegent-fg);
    font-size: var(--schegent-text-secondary);
    line-height: 1.35;
    font-weight: 550;
    min-width: 0;
    flex: 1 1 auto;
  }
  .pill {
    border: 0;
    border-radius: 0;
    padding: 0;
    font-size: var(--schegent-text-caption);
    font-weight: 550;
  }
  .status-in-flight .pill {
    color: var(--schegent-color-active);
    background: transparent;
  }
  .status-completed .pill {
    color: var(--schegent-color-completed);
  }
  .status-failed .pill {
    color: var(--schegent-error-text);
  }
  .status-canceled .pill {
    color: var(--schegent-muted-fg);
  }
  .status-pending .pill,
  .status-paused .pill {
    color: var(--schegent-color-warning);
  }
  .time-updated { opacity: 0.85; }
  /* Feature 065 BUG-005 (FR-025) — the drag handle is a recognizable
     grabber-icon button (was previously rendered as the punctuation
     glyphs `⋮⋮` inside a <span>, which read as decorative text rather
     than as an interactive control). The button is keyboard-focusable,
     advertises its purpose via aria-label, and telegraphs draggability
     via cursor: grab on hover. */
  .drag-handle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    width: 16px;
    min-width: 16px;
    min-height: 20px;
    padding: 0;
    color: var(--schegent-muted-fg);
    cursor: grab;
    user-select: none;
    flex-shrink: 0;
  }
  .drag-handle:hover {
    color: var(--schegent-fg);
  }
  .drag-handle:focus-visible {
    outline: 2px solid var(--schegent-color-active);
    outline-offset: 1px;
    border-radius: 2px;
  }
  .drag-handle-icon { width: 12px; height: 16px; fill: currentColor; }
  .item[draggable='true']:active .drag-handle {
    cursor: grabbing;
  }
</style>
