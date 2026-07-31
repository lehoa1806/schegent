<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { formatAbsoluteTime } from '../lib/format';
  import type { DebugLogEntry } from '../lib/snapshot-types';

  // System tab: full debug-log stream from the host's SanitizedLogger.
  // Replaces the previous audit-event rendering with a terminal-style
  // log viewer showing all non-LLM controller/watchdog/queue/retry logs.
  const entries = $derived(snapshotStore.debugLogTail);
  const reversed = $derived(entries.slice().reverse());
  const empty = $derived(entries.length === 0);

  const LEVEL_ICONS: Record<DebugLogEntry['level'], string> = {
    DEBUG: '·',
    INFO: 'ℹ',
    WARN: '⚠',
    ERROR: '✕'
  };

  function levelClass(level: DebugLogEntry['level']): string {
    return `level-${level.toLowerCase()}`;
  }

  function formatTimestamp(ts: string): string {
    return formatAbsoluteTime(ts);
  }
</script>

<section class="tail" aria-label="Debug log" data-testid="system-tab">
  <header class="title">Debug log</header>
  {#if empty}
    <p class="empty" data-testid="system-empty">No debug log entries yet.</p>
  {:else}
    <ol>
      {#each reversed as entry (entry.id)}
        <li
          class="entry {levelClass(entry.level)}"
          data-testid="system-entry-{entry.id}"
          aria-label="{entry.level}"
        >
          <span class="time" data-testid="system-entry-time-{entry.id}"
            >{formatTimestamp(entry.timestamp)}</span
          >
          <span class="level-badge" data-testid="system-entry-level-{entry.id}"
            >{LEVEL_ICONS[entry.level]}
            <span class="level-label">{entry.level}</span></span
          >
          <span class="message" data-testid="system-entry-message-{entry.id}"
            >{entry.message}</span
          >
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
    flex: 1;
    min-height: 0;
    overflow: hidden;
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
    gap: 0;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    font-family: var(--schegent-mono-font, ui-monospace, SFMono-Regular, monospace);
    font-size: 0.8em;
    line-height: 1.5;
  }
  .entry {
    display: flex;
    gap: 6px;
    padding: 1px 4px;
    color: var(--schegent-muted-fg);
    white-space: nowrap;
    align-items: baseline;
  }
  .entry:hover {
    background: var(--vscode-list-hoverBackground, transparent);
  }
  .time {
    flex-shrink: 0;
    opacity: 0.6;
    font-size: 0.9em;
  }
  .level-badge {
    flex-shrink: 0;
    min-width: 4.5em;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .level-label {
    font-size: 0.85em;
    font-weight: 600;
  }
  .message {
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: break-word;
    min-width: 0;
  }

  /* Level coloring */
  .level-debug {
    color: var(--schegent-muted-fg);
  }
  .level-info {
    color: var(--schegent-fg);
  }
  .level-info .level-badge {
    color: var(--schegent-color-active);
  }
  .level-warn {
    color: var(--schegent-fg);
  }
  .level-warn .level-badge {
    color: var(--schegent-color-warning);
  }
  .level-error {
    color: var(--schegent-fg);
  }
  .level-error .level-badge {
    color: var(--schegent-color-error);
  }
  .level-error .message {
    color: var(--schegent-color-error);
  }
</style>
