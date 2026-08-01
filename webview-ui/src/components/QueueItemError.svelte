<script lang="ts">
  import type { QueueItem } from '../lib/snapshot-types';

  interface Props {
    readonly item: QueueItem;
    readonly showLastError: boolean;
    readonly open: boolean;
    readonly onToggle: () => void;
  }

  const { item, showLastError, open, onToggle }: Props = $props();
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
    >{item.lastErrorSummary}</div>
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
    color: var(--schegent-color-error);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
