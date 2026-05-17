<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import QueueItem from './QueueItem.svelte';
  import QueueGlobalActions from './QueueGlobalActions.svelte';

  const queue = $derived(snapshotStore.queue);
  const inFlight = $derived(queue.inFlight);
  const pending = $derived(queue.pending);
  const recent = $derived(queue.recent);
  const paused = $derived(queue.paused);
  const isPrimary = $derived(snapshotStore.isPrimary);
  const empty = $derived(!inFlight && pending.length === 0 && recent.length === 0);
  // Feature 028 — derive pauseSource from the default queue's registry
  // entry. The global queue header reflects the default queue; per-queue
  // tabs in the dashboard surface their own pauseSource individually.
  const defaultQueuePauseSource = $derived(
    queue.queues?.find((q) => q.id === 'default')?.pauseSource ?? null
  );

  const completedCount = $derived(recent.filter((i) => i.status === 'completed').length);
  const failedCount = $derived(recent.filter((i) => i.status === 'failed').length);
</script>

<section class="list" aria-label="Queue" data-testid="queue-list">
  <header class="title">
    <span>Queue{paused ? ' — Paused' : ''}</span>
  </header>
  <QueueGlobalActions
    {paused}
    {isPrimary}
    {completedCount}
    {failedCount}
    pauseSource={defaultQueuePauseSource}
  />
  {#if empty}
    <p class="empty" data-testid="queue-empty">No queued features.</p>
  {:else}
    {#if inFlight}
      <div class="group group-inflight" data-testid="queue-group-inflight">
        <h4>In flight</h4>
        <!--
          Feature 030 (US2, T035) — the in-flight row is NEVER a valid
          drop target. The container suppresses the dragover/drop events
          before they bubble to a pending sibling so the operator sees
          the "no-drop" cursor natively. The host re-validates anyway
          and rejects with `cause: 'task-not-pending'` on any drop that
          slips past.
        -->
        <ul class="inflight-list">
          <QueueItem item={inFlight} />
        </ul>
      </div>
    {/if}
    {#if pending.length > 0}
      <div class="group" data-testid="queue-group-pending">
        <h4>Pending</h4>
        <ul class="pending-list">
          {#each pending as item (item.id)}
            <QueueItem {item} />
          {/each}
        </ul>
      </div>
    {/if}
    {#if recent.length > 0}
      <div class="group" data-testid="queue-group-recent">
        <h4>Recent</h4>
        <ul>
          {#each recent as item (item.id)}
            <QueueItem {item} />
          {/each}
        </ul>
      </div>
    {/if}
  {/if}
</section>

<style>
  .list {
    padding: var(--schegent-pad);
    border-bottom: 1px solid var(--schegent-divider);
  }
  .title {
    font-size: 0.8em;
    color: var(--schegent-muted-fg);
    margin-bottom: 4px;
  }
  .empty {
    color: var(--schegent-muted-fg);
    font-style: italic;
    margin: 0;
  }
  .group {
    margin-top: 6px;
  }
  .group h4 {
    margin: 0 0 2px;
    font-size: 0.85em;
    color: var(--schegent-muted-fg);
    font-weight: 500;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
</style>
