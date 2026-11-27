<script lang="ts">
  import { formatAbsoluteTime } from '../lib/format';
  import type { DebugLogEntry } from '../lib/snapshot-types';

  interface Props {
    readonly entries: readonly DebugLogEntry[];
  }

  const { entries }: Props = $props();

  const reversed = $derived(entries.slice().reverse());
  const empty = $derived(entries.length === 0);

  /** The `.sg` status tone each level's chip takes. */
  const LEVEL_TONES: Record<DebugLogEntry['level'], string> = {
    DEBUG: 's-idle',
    INFO: 's-run',
    WARN: 's-warn',
    ERROR: 's-err'
  };

  function levelClass(level: DebugLogEntry['level']): string {
    return `level-${level.toLowerCase()}`;
  }
</script>

<section aria-label="Debug log" data-testid="system-debug-log">
  <div class="table-wrap">
    <div class="ltable" class:fit={empty}>
      <div class="lhead" aria-hidden="true"><span>Time</span><span>Level</span><span>Message</span></div>
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
              <span class="cell time mono muted" data-testid="system-entry-time-{entry.id}">{formatAbsoluteTime(entry.timestamp)}</span>
              <span class="cell">
                <span class="chip {LEVEL_TONES[entry.level]}" data-testid="system-entry-level-{entry.id}"><span class="dot"></span><span class="level-label">{entry.level}</span></span>
              </span>
              <span class="cell message" data-testid="system-entry-message-{entry.id}">{entry.message}</span>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </div>
</section>

<style>
  .ltable {
    grid-template-columns: max-content max-content minmax(0, 1fr);
  }

  /* The chip shows the log's own word with only its first letter capitalised ("Error"); the
     document keeps the word as the log wrote it. */
  .level-label {
    display: inline-block;
    text-transform: lowercase;
  }

  .level-label::first-letter {
    text-transform: uppercase;
  }

  .message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
