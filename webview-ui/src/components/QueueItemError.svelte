<script lang="ts">
  import { untrack } from 'svelte';
  import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
  import { panelStateFor, readFailureRecord, type FailureRecordPanelState } from '../lib/failure-record-ipc';
  import type { QueueItem } from '../lib/snapshot-types';
  import FailureRecordPanel from './FailureRecordPanel.svelte';

  interface Props {
    readonly item: QueueItem;
    readonly showLastError: boolean;
    readonly open: boolean;
    readonly onToggle: () => void;
  }

  const { item, showLastError, open, onToggle }: Props = $props();

  // FR-R4-F15 (contract P2) — the region asks the host for the row's retained failure record each time
  // it opens, and only then: a record the retention sweep removed since the last look must not be
  // shown from a cache. The button's own rule is unchanged, so a row with no last error asks nothing.
  let panelState = $state<FailureRecordPanelState>({ kind: 'loading' });
  // Bumped on every open and every close. An answer carries the value it was asked under, so one that
  // arrives after the region closed, or after it was reopened, is dropped.
  let generation = 0;

  $effect(() => {
    // The effect depends on `open` alone. `item` is replaced by every snapshot, so reading it
    // tracked would ask again each time the host publishes.
    const isOpen = open;
    generation += 1;
    if (!isOpen) return;
    const asked = untrack(() => ({
      shown: showLastError && Boolean(item.lastErrorSummary),
      queueId: item.queueId ?? DEFAULT_QUEUE_ID,
      taskId: item.id
    }));
    if (!asked.shown) return;
    const mine = generation;
    panelState = { kind: 'loading' };
    void readFailureRecord(asked.queueId, asked.taskId).then((response) => {
      if (mine === generation) panelState = panelStateFor(response);
    });
  });
</script>

{#if showLastError && item.lastErrorSummary}
  <button
    type="button"
    class="error-toggle"
    data-testid="queue-item-error-toggle-{item.id}"
    aria-expanded={open ? 'true' : 'false'}
    aria-controls="queue-item-error-{item.id}"
    onclick={onToggle}
  >{open ? 'Hide error' : 'Show last error'}</button>
  {#if open}
    <div
      id="queue-item-error-{item.id}"
      class="error-body"
      data-testid="queue-item-error-{item.id}"
      role="region"
      aria-label="Last error for {item.label}"
    >
      <div class="error-text" data-testid="queue-item-error-text-{item.id}">{item.lastErrorSummary}</div>
      <hr class="error-separator" aria-hidden="true" />
      <FailureRecordPanel itemId={item.id} label={item.label} state={panelState} />
    </div>
  {/if}
{/if}

<style>
  .error-toggle {
    align-self: flex-start;
    margin-left: 4px;
    padding: 0 6px;
    border: 1px dashed var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: transparent;
    color: var(--schegent-muted-fg);
    cursor: pointer;
    font: inherit;
    font-size: 0.85em;
  }

  .error-toggle:hover {
    color: var(--schegent-fg);
  }

  .error-body {
    margin-left: 4px;
    padding: 4px 6px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: transparent;
    color: var(--schegent-error-text);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
  }

  .error-text {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .error-separator {
    margin: 4px 0;
    border: 0;
    border-top: 1px dashed var(--schegent-border);
  }
</style>
