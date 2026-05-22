<script lang="ts">
  import type { QueueItem, QueueLifecycle } from '../lib/snapshot-types';
  import { formatRelativeTime } from '../lib/format';
  import QueueItemActions from './QueueItemActions.svelte';
  import { postReorderTask } from '../lib/reorder-task';
  import { remoteLifecycleChangeStore } from '../lib/remote-lifecycle-change-store.svelte';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import ScheduledStartIndicator from './ScheduledStartIndicator.svelte';
  import StartModeChooser, { type StartQueueIntent } from './StartModeChooser.svelte';
  import { postCommand } from '../lib/vscode-api';
  import { CMD_START_QUEUE, CMD_DISMISS_MIGRATION_NOTICE } from '../lib/messages';

  interface Props {
    orderedItems: readonly QueueItem[];
    isPrimary: boolean;
    selectedTaskId: string | null;
    onTaskSelect: (taskId: string) => void;
  }

  const {
    orderedItems,
    isPrimary,
    selectedTaskId,
    onTaskSelect
  }: Props = $props();

  // Feature 065 (T049d / FR-016 / SC-001) — distinct operator-facing
  // label per lifecycle value. The lifecycle is read from the snapshot;
  // the four canonical values are surfaced with non-overlapping text so
  // an at-a-glance reader can tell them apart. The labels are kept short
  // because they share the queue-list header row with the action chips.
  const queueLifecycle = $derived<QueueLifecycle | null>(
    snapshotStore.snapshot?.queue.lifecycle ?? null
  );

  function lifecycleLabel(lifecycle: QueueLifecycle | null): string | null {
    switch (lifecycle) {
      case 'running':
        return 'Running';
      case 'operator-paused':
        return 'Paused';
      case 'idle-pending':
        return 'Idle (pending)';
      case 'active-empty':
        return 'Active (empty)';
      default:
        return null;
    }
  }

  const lifecycleLabelText = $derived(lifecycleLabel(queueLifecycle));

  // Feature 065 (T051 / FR-018) — idle-pending Start queue affordance.
  // When the queue is `idle-pending`:
  //   - If `scheduledStartAt != null`, render <ScheduledStartIndicator>
  //     (countdown + Cancel/Change/Start now actions).
  //   - If `scheduledStartAt == null`, render a "Start queue" button that
  //     opens the chooser in `idle-pending-restart` mode. The chooser's
  //     commit applies the schedule once-to-the-queue (per Q6 / FR-018),
  //     dispatching a single `CMD_START_QUEUE` regardless of how many
  //     pending tasks are present.
  const scheduledStartAt = $derived<number | null>(
    snapshotStore.snapshot?.queue.scheduledStartAt ?? null
  );

  let showRestartChooser = $state(false);

  // FR-019a — if the restart chooser is mounted and the lifecycle leaves
  // `idle-pending` (e.g. another window committed a state change), silently
  // unmount and surface the "queue state changed elsewhere" notice.
  $effect(() => {
    if (
      showRestartChooser &&
      queueLifecycle !== null &&
      queueLifecycle !== 'idle-pending'
    ) {
      showRestartChooser = false;
      remoteLifecycleChangeStore.notifyChangedElsewhere();
    }
  });

  function onStartQueueClick(): void {
    showRestartChooser = true;
  }

  // Feature 065 (T054a / FR-020) — one-time post-migration operator notice.
  // The host sets `migrationNotice: 'pending'` on the queue when the v6 → v7
  // migration produced at least one `idle-pending` queue (i.e. wrote
  // `scheduledStartSource: 'migration-default'`). The notice renders as a
  // non-modal, dismissible sibling container; dismissing dispatches a single
  // `CMD_DISMISS_MIGRATION_NOTICE` that translates to a `setQueue({...})`
  // write of `migrationNotice: 'dismissed'`. FR-020 invariant: dismissal
  // MUST NOT touch `scheduledStartSource` on any queue record (those clear
  // only on the operator's next explicit start).
  const migrationNoticeState = $derived<'pending' | 'dismissed' | undefined>(
    snapshotStore.snapshot?.queue.migrationNotice
  );

  function onMigrationNoticeDismiss(): void {
    postCommand(CMD_DISMISS_MIGRATION_NOTICE);
  }

  function onRestartChooserCommit(intent: StartQueueIntent | null): void {
    showRestartChooser = false;
    if (intent === null) return;
    // Chooser already emits a `StartQueueIntent` with `source:'operator-restart'`
    // (T027 simplification). Per FR-018 / Q6 the dispatch is once-to-the-queue.
    postCommand(CMD_START_QUEUE, { startIntent: intent } as never);
  }

  function onDragStart(ev: DragEvent, item: QueueItem): void {
    if (item.status !== 'pending') return;
    if (ev.dataTransfer) {
      ev.dataTransfer.setData('text/plain', item.id);
      ev.dataTransfer.effectAllowed = 'move';
    }
  }

  function onDragOver(ev: DragEvent, item: QueueItem): void {
    if (item.status !== 'pending') return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
  }

  function onDrop(ev: DragEvent, item: QueueItem): void {
    if (item.status !== 'pending') return;
    ev.preventDefault();
    const sourceId = ev.dataTransfer?.getData('text/plain') ?? '';
    if (sourceId.length === 0 || sourceId === item.id) return;
    void postReorderTask(sourceId, item.position);
  }
</script>

<div class="queue-list" data-testid="dashboard-queue-list">
  {#if lifecycleLabelText !== null}
    <!--
      Feature 065 (T049d / FR-016 / SC-001) — operator-facing label for
      the current queue lifecycle. The `data-lifecycle` attribute carries
      the canonical literal so tests can assert each of the four values
      surfaces a distinct label.
    -->
    <div
      class="queue-lifecycle-label"
      data-testid="queue-lifecycle-label"
      data-lifecycle={queueLifecycle}
      aria-label="Queue state: {lifecycleLabelText}"
    >
      <span class="lifecycle-dot lifecycle-dot-{queueLifecycle}"></span>
      <span class="lifecycle-text">{lifecycleLabelText}</span>
    </div>
  {/if}
  {#if queueLifecycle === 'idle-pending'}
    <!--
      Feature 065 (T051 / FR-018) — idle-pending Start queue affordance.
      When a schedule is armed, surface the ScheduledStartIndicator (the
      countdown + Cancel/Change/Start now actions live there). When no
      schedule is armed, expose a single "Start queue" button that opens
      the chooser in `idle-pending-restart` mode; commit dispatches one
      CMD_START_QUEUE for the whole queue (Q6: once-to-the-queue).
    -->
    {#if scheduledStartAt !== null && scheduledStartAt !== undefined}
      <div class="idle-pending-host" data-testid="idle-pending-scheduled-host">
        <ScheduledStartIndicator scheduledStartAt={scheduledStartAt} />
      </div>
    {:else if !showRestartChooser}
      <div class="idle-pending-host" data-testid="idle-pending-start-queue-host">
        <button
          type="button"
          class="start-queue-button"
          data-testid="idle-pending-start-queue-button"
          onclick={onStartQueueClick}
        >
          Start queue
        </button>
      </div>
    {:else}
      <div class="idle-pending-host" data-testid="idle-pending-chooser-host">
        <StartModeChooser onCommit={onRestartChooserCommit} />
      </div>
    {/if}
  {/if}
  {#if remoteLifecycleChangeStore.active}
    <!--
      Feature 065 (T049a) — FR-019a non-modal "queue state changed
      elsewhere" notice. Surfaces when another window committed a queue
      state change that silently closed our chooser. The notice MUST NOT
      use the modal `useConfirm` gate; it is dismissible and ambient.
    -->
    <div
      class="queue-state-changed-notice"
      role="status"
      data-testid="queue-state-changed-elsewhere-notice"
    >
      <span class="notice-text">Queue state changed elsewhere — refresh to continue.</span>
      <button
        type="button"
        class="notice-dismiss"
        data-testid="queue-state-changed-elsewhere-dismiss"
        aria-label="Dismiss notice"
        onclick={() => remoteLifecycleChangeStore.dismiss()}
      >
        Dismiss
      </button>
    </div>
  {/if}
  {#if migrationNoticeState === 'pending'}
    <!--
      Feature 065 (T054a / FR-020) — one-time post-migration operator
      notice. Surfaces on the first workspace open after a v6 → v7
      migration that produced at least one `idle-pending` queue. The
      notice MUST NOT use `useConfirm` and MUST NOT use a modal dialog;
      it is non-modal and dismissible. Dismissing dispatches the
      non-mutating `CMD_DISMISS_MIGRATION_NOTICE`, which flips the
      queue's `migrationNotice` to `'dismissed'` via a single
      `setQueue({...})` write that preserves `scheduledStartSource`
      (FR-020 invariant: those clear only on the operator's next
      explicit start).
    -->
    <div
      class="migration-notice"
      role="status"
      data-testid="migration-notice"
    >
      <span class="notice-text">
        Queue migrated from a previous version. Pending tasks were preserved;
        click "Start queue" when you're ready to resume.
      </span>
      <button
        type="button"
        class="notice-dismiss"
        data-testid="migration-notice-dismiss"
        aria-label="Dismiss migration notice"
        onclick={onMigrationNoticeDismiss}
      >
        Dismiss
      </button>
    </div>
  {/if}
  {#if orderedItems.length === 0}
    <div class="empty-state">
      <span class="empty-icon">☕</span>
      <p class="empty-text">The queue is waiting for your next big idea.</p>
    </div>
  {:else}
    <ol class="items">
      {#each orderedItems as item (item.id)}
        <li
          class="item status-{item.status} {selectedTaskId === item.id ? 'activity-selected' : ''}"
          data-testid="dashboard-queue-item-{item.id}"
          aria-current={selectedTaskId === item.id ? 'true' : undefined}
          draggable={item.status === 'pending'}
          ondragstart={(ev) => onDragStart(ev, item)}
          ondragover={(ev) => onDragOver(ev, item)}
          ondrop={(ev) => onDrop(ev, item)}
        >
          {#if item.status === 'pending'}
            <span
              class="drag-handle"
              data-testid="queue-item-drag-handle-{item.id}"
              aria-hidden="true"
              title="Drag to reorder"
            >⋮⋮</span>
          {/if}
          <div class="item-body">
            <div class="row row-1">
              <button
                type="button"
                class="row-1-left item-select"
                data-testid="dashboard-queue-item-select-{item.id}"
                aria-label="Show task {item.id} in Activity Feed"
                aria-pressed={selectedTaskId === item.id ? 'true' : 'false'}
                title="Show this task in the Activity Feed"
                onclick={() => onTaskSelect(item.id)}
              >
                <span class="queue-id-chip" data-testid="dashboard-queue-item-id-{item.id}">{item.id}</span>
                <time class="queue-enqueued" data-testid="dashboard-queue-item-enqueued-{item.id}" datetime={item.enqueuedAt}>{formatRelativeTime(item.enqueuedAt)}</time>
              </button>
              <div class="row-1-right">
                <span class="status-pill" data-testid="queue-item-status-{item.id}">{item.status}</span>
                <span class="actions-slot">
                  <QueueItemActions {item} {isPrimary} />
                </span>
              </div>
            </div>
            <div class="row row-2">
              <span class="queue-prompt" data-testid="dashboard-queue-item-label-{item.id}" title={item.label || '(no prompt)'}>{item.label || '(no prompt)'}</span>
            </div>
          </div>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .queue-list {
    flex: 1;
    overflow-y: auto;
  }
  .items {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .item {
    background: var(--vscode-list-hoverBackground);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    padding: 12px 16px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    transition: transform 0.2s;
  }
  .item:hover {
    transform: translateY(-2px);
    background: var(--vscode-list-hoverBackground);
  }
  .item.activity-selected {
    border-color: var(--schegent-color-active);
    background: color-mix(in srgb, var(--schegent-color-active) 10%, var(--vscode-list-hoverBackground));
    box-shadow: inset 3px 0 0 var(--schegent-color-active);
  }
  .item-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }
  .row {
    display: flex;
    min-width: 0;
  }
  .row-1 {
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .row-1-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
  }
  .row-1-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    flex-wrap: nowrap;
  }
  .row-2 {
    padding-left: 2px;
  }
  .item-select {
    background: transparent;
    color: inherit;
    border: 0;
    padding: 0;
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .item-select:focus-visible {
    outline: 1px solid var(--schegent-focus-border);
    outline-offset: 3px;
    border-radius: var(--schegent-radius);
  }
  .queue-id-chip {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.72em;
    color: var(--schegent-muted-fg);
    background: var(--vscode-list-hoverBackground);
    padding: 1px 6px;
    border-radius: 999px;
    border: 1px solid var(--sch-glass-border);
    flex-shrink: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .queue-enqueued {
    font-size: 0.75em;
    color: var(--schegent-muted-fg);
    flex-shrink: 0;
    white-space: nowrap;
  }
  .queue-prompt {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    color: var(--schegent-fg);
    font-size: 0.9em;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    min-width: 0;
    flex: 1 1 auto;
  }
  .status-pill {
    font-size: 0.75em;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
  }
  .status-in-flight .status-pill { background: color-mix(in srgb, var(--vscode-charts-blue) 15%, transparent); color: var(--vscode-charts-blue); }
  .status-completed .status-pill { background: color-mix(in srgb, var(--vscode-charts-green) 15%, transparent); color: var(--vscode-charts-green); }
  .status-failed .status-pill { background: color-mix(in srgb, var(--vscode-charts-red) 15%, transparent); color: var(--vscode-charts-red); }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 0;
    color: var(--schegent-muted-fg);
  }
  .empty-icon { font-size: 2em; margin-bottom: 8px; opacity: 0.5; }
  .empty-text { font-style: italic; margin: 0; }
  .drag-handle {
    color: var(--schegent-muted-fg);
    cursor: grab;
    user-select: none;
    font-size: 1.1em;
    letter-spacing: -2px;
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }
  .item[draggable='true']:active .drag-handle {
    cursor: grabbing;
  }
  .queue-lifecycle-label {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    margin-bottom: 8px;
    font-size: 0.8em;
    color: var(--schegent-muted-fg);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    background: var(--vscode-list-hoverBackground);
  }
  .lifecycle-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--schegent-muted-fg);
    flex-shrink: 0;
  }
  .lifecycle-dot-running { background: var(--vscode-charts-blue); }
  .lifecycle-dot-operator-paused { background: var(--vscode-charts-yellow); }
  .lifecycle-dot-idle-pending { background: var(--vscode-charts-orange); }
  .lifecycle-dot-active-empty { background: var(--vscode-charts-green); }
  .lifecycle-text { font-weight: 600; color: var(--schegent-fg); }
  .idle-pending-host {
    margin-bottom: 8px;
  }
  .start-queue-button {
    padding: 8px 14px;
    background: var(--sch-accent-gradient, var(--vscode-button-background));
    color: var(--vscode-button-foreground);
    border: 0;
    border-radius: var(--schegent-radius);
    cursor: pointer;
    font-size: 0.9em;
    font-weight: 600;
  }
  .start-queue-button:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .queue-state-changed-notice,
  .migration-notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    margin-bottom: 8px;
    background: color-mix(in srgb, var(--vscode-notificationsInfoIcon-foreground, var(--vscode-charts-blue)) 12%, transparent);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    color: var(--schegent-fg);
    font-size: 0.85em;
  }
  .notice-text { flex: 1 1 auto; }
  .notice-dismiss {
    background: transparent;
    color: var(--vscode-textLink-foreground);
    border: 0;
    cursor: pointer;
    padding: 2px 6px;
    font-size: 0.85em;
    text-decoration: underline;
  }
</style>
