<script lang="ts">
  import { formatAbsoluteTime } from '../lib/format';
  import type { DebugLogEntry } from '../lib/snapshot-types';

  interface Props {
    readonly entries: readonly DebugLogEntry[];
  }

  const { entries }: Props = $props();

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
</script>

<section class="tail" aria-label="Debug log" data-testid="system-debug-log">
  <header class="title">Debug log</header>
  {#if empty}
    <p class="empty" data-testid="system-empty">No debug log entries yet.</p>
  {:else}
    <ol data-testid="system-debug-list">
      {#each reversed as entry (entry.id)}
        <li
          class="entry {levelClass(entry.level)}"
          data-testid="system-entry-{entry.id}"
          aria-label={entry.level}
        >
          <span class="time" data-testid="system-entry-time-{entry.id}">
            {formatAbsoluteTime(entry.timestamp)}
          </span>
          <span class="level-badge" data-testid="system-entry-level-{entry.id}">
            {LEVEL_ICONS[entry.level]}
            <span class="level-label">{entry.level}</span>
          </span>
          <span class="message" data-testid="system-entry-message-{entry.id}">
            {entry.message}
          </span>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .tail {
    padding: var(--schegent-pad);
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 4px;
    overflow: hidden;
  }

  .title {
    color: var(--schegent-muted-fg);
    font-size: 0.8em;
  }

  .empty {
    margin: 0;
    color: var(--schegent-muted-fg);
    font-style: italic;
  }

  ol {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 0;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    font-family: var(--schegent-mono-font, ui-monospace, SFMono-Regular, monospace);
    font-size: 0.8em;
    line-height: 1.5;
    list-style: none;
  }

  .entry {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 1px 4px;
    color: var(--schegent-muted-fg);
    white-space: nowrap;
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
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    gap: 3px;
    min-width: 4.5em;
  }

  .level-label {
    font-size: 0.85em;
    font-weight: 600;
  }

  .message {
    min-width: 0;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: break-word;
  }

  .level-debug {
    color: var(--schegent-muted-fg);
  }

  .level-info,
  .level-warn,
  .level-error {
    color: var(--schegent-fg);
  }

  .level-info .level-badge {
    color: var(--schegent-color-active);
  }

  .level-warn .level-badge {
    color: var(--schegent-color-warning);
  }

  .level-error .level-badge,
  .level-error .message {
    color: var(--schegent-color-error);
  }
</style>
