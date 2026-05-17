<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { formatRelativeTime } from '../lib/format';
  import { postCommand } from '../lib/vscode-api';
  import { CMD_OPEN_AUDIT_LOG } from '../lib/messages';
  import type { AuditCategory } from '../lib/snapshot-types';

  const entries = $derived(snapshotStore.auditTail);
  const reversed = $derived(entries.slice().reverse());
  const empty = $derived(entries.length === 0);

  const ICONS: Record<AuditCategory, string> = {
    'phase-transition': '→',
    'file-write': '✎',
    'cli-invocation': '$',
    error: '✕',
    warning: '!',
    system: '·'
  };

  function openLog(): void {
    postCommand(CMD_OPEN_AUDIT_LOG);
  }
</script>

<section class="tail" aria-label="Audit tail" data-testid="audit-tail">
  <header class="title">Audit tail</header>
  {#if empty}
    <p class="empty" data-testid="audit-empty">No audit entries yet.</p>
  {:else}
    <ol>
      {#each reversed as entry (entry.id)}
        <li class="entry category-{entry.category}" data-testid="audit-entry-{entry.id}">
          <span class="icon" aria-hidden="true">{ICONS[entry.category]}</span>
          <span class="summary" title={entry.summary}>{entry.summary}</span>
          <span class="time">{formatRelativeTime(entry.timestamp)}</span>
        </li>
      {/each}
    </ol>
  {/if}
  <footer>
    <button type="button" data-testid="audit-open-full" onclick={openLog}>Open full log</button>
  </footer>
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
    max-height: 220px;
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
  footer {
    display: flex;
    justify-content: flex-end;
  }
  button {
    background: transparent;
    color: var(--schegent-muted-fg);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    padding: 2px 8px;
    cursor: pointer;
    font-size: 0.85em;
  }
  button:hover {
    color: var(--schegent-fg);
  }
</style>
