<script lang="ts">
  import type { QueueItem } from '../lib/snapshot-types';
  import { formatPhaseLabel, formatRelativeTime } from '../lib/format';
  import { formatDuration } from '../lib/format-duration';
  import { nowFine } from '../lib/tick-store';
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

  interface Props {
    item: QueueItem;
    /**
     * BUG-009 (T079) — props added so all queue surfaces (sidebar
     * `QueueListView`, dashboard "Active Queue" panel) can render via
     * the shared component. `isSelected` drives the `.activity-selected`
     * highlight; `onSelect` (when present) makes the id chip clickable
     * so the Activity Feed can bind to this row.
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

  /**
   * Card-level click handler — selects this task in the Activity Feed.
   * Interactive child elements (buttons, drag handles, links) call
   * `event.stopPropagation()` so their own handlers fire without also
   * triggering a task-select.
   */
  function onCardClick(event: MouseEvent): void {
    if (!onSelect) return;
    // Ignore clicks that originated from an interactive element. This
    // is a safety net in case a child forgets stopPropagation.
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, select, textarea')) return;
    onSelect();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<li
  class="item status-{item.status} {isSelected ? 'activity-selected' : ''} {onSelect ? 'selectable' : ''}"
  data-testid="{testIdPrefix}-{item.id}"
  aria-current={isSelected ? 'true' : undefined}
  data-queue-status={item.status}
  draggable={showReorderControls && dragEnabled}
  ondragstart={onDragStart}
  ondragover={onDragOver}
  ondrop={onDrop}
  ondragend={onDragEnd}
  onclick={onCardClick}
  role={onSelect ? 'button' : undefined}
  tabindex={onSelect ? 0 : undefined}
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
    <span class="label" data-testid="{testIdPrefix}-label-{item.id}" title={item.label}>{item.label.length > 0 ? item.label : '(no prompt)'}</span>
  </div>

  {#if hasMetaChips}
    <div class="row row-3 meta" data-testid="queue-item-meta-{item.id}">
      {#if showCurrentPhase}
        <span
          class="chip phase-chip"
          data-testid="queue-item-phase-{item.id}"
        >{phaseChipLabel}</span>
      {/if}
      {#if showPausedReason}
        <span
          class="chip paused-chip"
          data-testid="queue-item-pause-cause-{item.id}"
          title={pauseCauseTitle}
        >{pauseCauseLabel}</span>
      {/if}
      {#if showPausedBadge}
        <span
          class="chip paused-chip paused-badge"
          data-testid="queue-item-pause-badge-{item.id}"
          data-pause-source={item.paused?.pauseSource}
          data-pause-cause-category={item.paused?.pauseCauseCategory ?? ''}
        >{pausedBadgeLabel}</span>
        {#if showResumeCountdown}
          <span
            class="chip restore-chip"
            data-testid="queue-item-restore-time-{item.id}"
            title="Queue auto-resumes when the quota window reopens"
          >{resumeCountdownLabel}</span>
        {/if}
      {/if}
      {#if showRetryBadge}
        <span
          class="badge retry-badge"
          data-testid="queue-item-retry-{item.id}"
        >retry: {item.retryCount}</span>
      {/if}
    </div>
  {/if}

  <div class="row row-footer">
    <div class="row-footer-left">
      <span class="time" data-testid="{testIdPrefix}-enqueued-{item.id}">{enqueuedAtLabel}</span>
    </div>
    <div class="row-footer-right">
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
    background: var(--vscode-list-hoverBackground);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    transition: transform 0.2s, border-color 0.2s, background 0.2s, box-shadow 0.2s;
  }
  .item.selectable {
    cursor: pointer;
  }
  .item:hover {
    transform: translateY(-2px);
    background: var(--vscode-list-hoverBackground);
  }
  .item.selectable:hover {
    border-color: color-mix(in srgb, var(--schegent-color-active) 40%, var(--sch-glass-border));
  }
  .item.activity-selected {
    border-color: var(--schegent-color-active);
    background: color-mix(in srgb, var(--schegent-color-active) 10%, var(--vscode-list-hoverBackground));
    box-shadow: inset 3px 0 0 var(--schegent-color-active);
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
    font-size: 0.85em;
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
  /* Feature 065 BUG-004 (FR-024) — the card's final row carries the
     enqueued timestamp on the left and the action cluster (reorder
     buttons + QueueItemActions) on the right. The footer wraps cleanly
     at narrow viewport widths because the right side never shrinks
     (flex-shrink: 0) and the left side is allowed to shrink/wrap. */
  .row-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--schegent-gap);
    flex-wrap: wrap;
    padding-left: 4px;
  }
  .row-footer-left {
    display: flex;
    align-items: center;
    min-width: 0;
    flex-shrink: 1;
  }
  .row-footer-right {
    display: flex;
    align-items: center;
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
    font-size: 0.95em;
    line-height: 1.4;
    min-width: 0;
    flex: 1 1 auto;
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
  .paused-badge[data-pause-source='system-paused'] {
    color: var(--schegent-color-error);
    border-color: currentColor;
    font-style: normal;
  }
  .restore-chip {
    color: var(--schegent-color-active);
    border-color: currentColor;
    font-style: normal;
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
  /* Feature 065 BUG-005 hypothesis B (FR-025) — the action cluster
     guarantees non-zero width at every operator viewport size. The
     enclosing flex container (.row-footer-right) is already non-
     shrinking; .actions-slot mirrors that so the cluster can never
     collapse even if a future layout change wraps it deeper. */
  .actions-slot {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
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
    padding: 2px;
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
  .drag-handle-icon {
    width: 12px;
    height: 16px;
    fill: currentColor;
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
    flex-shrink: 0;
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
