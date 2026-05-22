<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { formatRelativeTime } from '../lib/format';
  import type { AuditCategory } from '../lib/snapshot-types';

  // Feature 064 T015 — System tab: renders only entries the projector
  // classified as `scope === 'system'`. Legacy entries (pre-Feature 064,
  // `scope === undefined`) are treated as `'task'` per FR-013 and are NOT
  // shown here; they continue to appear in the Activity Feed.
  //
  // Unlike AuditTail, the System tab is NEVER filtered by runId reachability
  // (FR-015). A `queue-cleared-all` projected entry whose runId may be
  // reachable still surfaces here because its scope is system.
  const entries = $derived(snapshotStore.auditTail);
  const visible = $derived(entries.filter((entry) => entry.scope === 'system'));
  const reversed = $derived(visible.slice().reverse());
  const empty = $derived(visible.length === 0);

  const ICONS: Record<AuditCategory, string> = {
    'phase-transition': '→',
    'file-write': '✎',
    'cli-invocation': '$',
    error: '✕',
    warning: '!',
    system: '·'
  };
</script>

<section class="tail" aria-label="System events" data-testid="system-tab">
  <header class="title">System events</header>
  {#if empty}
    <p class="empty" data-testid="system-empty">No system events yet.</p>
  {:else}
    <ol>
      {#each reversed as entry (entry.id)}
        <li class="entry category-{entry.category}" data-testid="system-entry-{entry.id}">
          <span class="icon" aria-hidden="true">{ICONS[entry.category]}</span>
          <span class="summary" title={entry.summary}>{entry.summary}</span>
          <span class="time">{formatRelativeTime(entry.timestamp)}</span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .tail {
    padding: var(--schegent-pad);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .title {
    font-size: 0.8em;
    color: var(--schegent-muted-fg);
  }
  .empty {
    margin: 0;
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow-y: auto;
  }
  .entry {
    display: grid;
    grid-template-columns: 1.25em 1fr auto;
    gap: 6px;
    align-items: center;
    padding: 1px 4px;
    color: var(--schegent-fg);
    font-size: 0.85em;
  }
  .entry .icon {
    color: var(--schegent-muted-fg);
    text-align: center;
  }
  .category-error {
    color: var(--schegent-color-error);
  }
  .category-warning {
    color: var(--schegent-color-warning);
  }
  .category-cli-invocation .icon,
  .category-file-write .icon {
    color: var(--schegent-color-active);
  }
  .summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .time {
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }
</style>
