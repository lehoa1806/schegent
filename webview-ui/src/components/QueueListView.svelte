<script lang="ts">
  import type { QueueItem } from '../lib/snapshot-types';
  import { formatRelativeTime } from '../lib/format';
  import QueueItemActions from './QueueItemActions.svelte';
  import { postReorderTask } from '../lib/reorder-task';

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
</style>
