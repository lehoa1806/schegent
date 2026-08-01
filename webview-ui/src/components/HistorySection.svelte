<script lang="ts">
  import type { HistoryEntry } from '../lib/snapshot-types';
  import { formatDuration } from '../lib/format-duration';
  import { formatRelativeTime } from '../lib/format';
  import { postCommand } from '../lib/vscode-api';
  import {
    CMD_RERUN_FROM_HISTORY,
    CMD_OPEN_AUDIT_LOG,
    CMD_OPEN_HISTORY_ITEM_DETAILS
  } from '../lib/messages';
  import { useConfirm } from '../lib/use-confirm';

  interface Props {
    history: readonly HistoryEntry[];
    isPrimary: boolean;
    selectedTaskId?: string | null;
    onTaskSelect?: (taskId: string) => void;
  }

  const { history, isPrimary, selectedTaskId = null, onTaskSelect }: Props = $props();

  const empty = $derived(history.length === 0);
  const rerunDisabled = $derived(!isPrimary);
  const ariaRerun = $derived<'true' | 'false'>(rerunDisabled ? 'true' : 'false');
  const readOnlyAria: 'false' = 'false';

  async function onRerun(event: MouseEvent, runId: string, taskTitle: string): Promise<void> {
    if (rerunDisabled) return;
    // Feature 063 (T036) — gate rerun-from-history through the universal
    // confirmation. The task title surfaces in the modal body so the
    // operator can confirm they're re-enqueuing the right run.
    const ok = await useConfirm('history.rerun', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: { taskTitle }
    });
    if (!ok) return;
    postCommand(CMD_RERUN_FROM_HISTORY, { runId });
  }

  function onOpenAudit(): void {
    postCommand(CMD_OPEN_AUDIT_LOG);
  }

  function onOpenDetails(id: string): void {
    postCommand(CMD_OPEN_HISTORY_ITEM_DETAILS, { id });
  }
</script>

<section class="history" aria-label="Run history" data-testid="history-section">
  {#if empty}
    <p class="empty" data-testid="history-empty">No completed runs yet.</p>
  {:else}
    <ul>
      {#each history as entry (entry.runId)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <li
          class="entry status-{entry.terminalStatus}"
          class:selected={selectedTaskId === entry.runId}
          data-testid="history-entry-{entry.runId}"
          data-history-row="{entry.runId}"
          onclick={() => onTaskSelect?.(entry.runId)}
        >
          <span class="label" title={entry.descriptionPreview}>
            {entry.descriptionPreview}
          </span>
          <span class="meta">
            <span
              class="badge status-badge"
              data-testid="history-item-{entry.runId}-status"
              aria-label={`Status: ${entry.terminalStatus}`}
            >{entry.terminalStatus}</span>
            <span
              class="time"
              data-testid="history-item-{entry.runId}-duration"
              title="Duration"
            >{formatDuration(entry.durationMs)}</span>
            <span
              class="time"
              data-testid="history-item-{entry.runId}-completed-at"
              title="Completed"
            >{formatRelativeTime(entry.completedAt)}</span>
          </span>
          <span class="actions">
            <button
              type="button"
              class="action"
              data-testid="history-item-rerun-{entry.runId}"
              aria-label={`Rerun '${entry.descriptionPreview}'`}
              aria-disabled={ariaRerun}
              onclick={(event) => onRerun(event, entry.runId, entry.descriptionPreview)}
            >Rerun</button>
            <button
              type="button"
              class="action"
              data-testid="history-item-open-audit-{entry.runId}"
              aria-label="Open audit log"
              aria-disabled={readOnlyAria}
              onclick={onOpenAudit}
            >Audit</button>
            <button
              type="button"
              class="action"
              data-testid="history-item-open-details-{entry.runId}"
              aria-label={`Open details for '${entry.descriptionPreview}'`}
              aria-disabled={readOnlyAria}
              onclick={() => onOpenDetails(entry.runId)}
            >Details</button>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .history {
    padding: 0;
  }
  .empty {
    color: var(--schegent-muted-fg);
    font-style: italic;
    margin: 0;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .entry {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    column-gap: var(--schegent-gap);
    align-items: center;
    padding: 4px var(--schegent-pad);
    border-radius: var(--schegent-radius);
  }
  .entry:hover {
    background: var(--schegent-list-hover);
  }
  .entry.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .entry.selected .label {
    color: inherit;
  }
  .entry.selected .meta {
    color: inherit;
    opacity: 0.8;
  }
  .entry.selected .action {
    color: inherit;
    border-color: currentColor;
    opacity: 0.8;
  }
  .entry.selected .action:hover:not([aria-disabled='true']) {
    opacity: 1;
  }
  .label {
    grid-column: 1;
    grid-row: 1;
    overflow: hidden;
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-height: 1.35;
    word-break: break-word;
  }
  .meta {
    grid-column: 1;
    grid-row: 2;
    display: flex;
    flex-wrap: wrap;
    gap: var(--schegent-gap);
    align-items: center;
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }
  .badge {
    border: 1px solid var(--schegent-border);
    border-radius: 999px;
    padding: 0 6px;
  }
  .status-completed .status-badge {
    color: var(--schegent-color-completed);
    border-color: currentColor;
  }
  .status-failed .status-badge {
    color: var(--schegent-color-error);
    border-color: currentColor;
  }
  .status-canceled .status-badge {
    color: var(--schegent-muted-fg);
    border-color: currentColor;
  }
  .actions {
    grid-column: 2;
    grid-row: 1 / span 2;
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .action {
    background: transparent;
    color: var(--schegent-muted-fg);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    padding: 0 6px;
    font: inherit;
    cursor: pointer;
  }
  .action[aria-disabled='true'] {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .action:hover:not([aria-disabled='true']) {
    color: var(--schegent-fg);
  }
</style>
