<script lang="ts">
  import type { QueueItem } from '../lib/snapshot-types';
  import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
  import { restartPhase } from '../lib/phase-control';
  import { lifecycleMessage, lifecycleWait } from '../lib/lifecycle-control-ipc';

  // Spec 278 (OD-2) — Restart on a failed row. The host admits Restart on a failed Run
  // (the parity table marks it legal, and the restart clears `failureCause`); the row offered
  // no way to ask for it. A row carries a phase only while its Run is still the queue's stored
  // Run, which is the Run the host restarts, so a failed row without one offers nothing.
  //
  // No confirmation: the phase menu's Restart asks none, and Restart is not in the
  // destructive-action set either surface gates.
  interface Props {
    item: QueueItem;
    disabled: boolean;
  }

  const { item, disabled }: Props = $props();

  const failedPhase = $derived(item.status === 'failed' ? item.currentPhase : null);
  const labelHint = $derived(item.label.length > 24 ? `${item.label.slice(0, 24)}...` : item.label);

  let message = $state<string | null>(null);
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());
  const wait = lifecycleWait(lifetime.signal, (late) => (message = late));

  async function onRestart(): Promise<void> {
    if (disabled || failedPhase === null) return;
    message = null;
    const result = await restartPhase(failedPhase, item.queueId ?? DEFAULT_QUEUE_ID, wait);
    if (lifetime.signal.aborted) return;
    message = lifecycleMessage(result);
  }
</script>

{#if failedPhase !== null}
  <button
    type="button"
    data-testid="queue-item-restart-phase-{item.id}"
    aria-label={`Restart failed phase ${failedPhase} of '${labelHint}'`}
    title={`Restart failed phase ${failedPhase} of '${labelHint}'`}
    aria-disabled={disabled ? 'true' : 'false'}
    onclick={onRestart}
  >⟲</button>
  {#if message}
    <span class="restart-message" role="status" data-testid="queue-item-restart-phase-message-{item.id}"
      >{message}</span
    >
  {/if}
{/if}

<style>
  button {
    background: transparent;
    color: var(--schegent-muted-fg);
    border: 1px solid var(--schegent-border);
    min-width: 22px;
    min-height: 22px;
    border-radius: var(--schegent-radius-sm);
    padding: 0 4px;
    font: inherit;
    cursor: pointer;
  }
  button[aria-disabled='true'] {
    opacity: 0.55;
    cursor: not-allowed;
  }
  button:hover:not([aria-disabled='true']) {
    color: var(--schegent-fg);
    background: var(--schegent-surface-hover);
  }
  .restart-message {
    color: var(--schegent-error-text);
    font-size: 0.85em;
    margin-left: 4px;
  }
</style>
