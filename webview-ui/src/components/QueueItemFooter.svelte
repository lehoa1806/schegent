<script lang="ts">
  import type { QueueItem } from '../lib/snapshot-types';
  import QueueItemActions from './QueueItemActions.svelte';

  interface Props {
    readonly item: QueueItem;
    readonly isPrimary: boolean;
    readonly showReorderControls: boolean;
    readonly enqueuedAtLabel: string;
    readonly testIdPrefix: string;
    readonly onMoveUp: () => void;
    readonly onMoveDown: () => void;
  }

  const {
    item,
    isPrimary,
    showReorderControls,
    enqueuedAtLabel,
    testIdPrefix,
    onMoveUp,
    onMoveDown
  }: Props = $props();
</script>

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

<style>
  .row-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--schegent-gap);
    padding-left: 4px;
  }

  .row-footer-left {
    display: flex;
    align-items: center;
    min-width: 0;
    flex-shrink: 1;
  }

  .row-footer-right,
  .actions-slot {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .actions-slot {
    gap: 4px;
  }

  .time {
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
    white-space: nowrap;
  }

  .reorder-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    flex-shrink: 0;
    padding: 0 4px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: transparent;
    color: var(--schegent-muted-fg);
    cursor: pointer;
    font: inherit;
    line-height: 1;
  }

  .reorder-btn:hover {
    background: var(--schegent-list-hover);
    color: var(--schegent-fg);
  }

  .reorder-btn:focus-visible {
    outline: 2px solid var(--schegent-color-active);
    outline-offset: 1px;
  }
</style>
