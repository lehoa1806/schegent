<script lang="ts">
  import {
    decisionRecordResultText,
    openDecisionRecord,
    type OpenDecisionRecordResult
  } from '../lib/decision-record-ipc';

  interface Props {
    readonly rowId: string;
  }

  const { rowId }: Props = $props();

  // FR-R5-F19 (T19.1) — the row's way to its decision record. One request per click, by row id; the
  // answer is shown as one sentence, never as a path or record text. A second click while one is
  // pending is ignored, so a slow host is asked once.
  let pending = $state(false);
  let result = $state<OpenDecisionRecordResult | null>(null);

  async function onOpen(): Promise<void> {
    if (pending) return;
    pending = true;
    try {
      result = await openDecisionRecord(rowId);
    } finally {
      pending = false;
    }
  }
</script>

<button
  type="button"
  class="decision-record-open"
  data-testid="queue-item-decision-record-{rowId}"
  disabled={pending}
  onclick={onOpen}
>Open decision record</button>
{#if result !== null}
  <span
    class="decision-record-status"
    data-testid="queue-item-decision-record-status-{rowId}"
    role="status"
  >{decisionRecordResultText(result)}</span>
{/if}

<style>
  .decision-record-open {
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

  .decision-record-open:hover:not(:disabled) {
    color: var(--schegent-fg);
  }

  .decision-record-status {
    margin-left: 4px;
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }
</style>
