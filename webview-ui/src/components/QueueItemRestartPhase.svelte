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
    /** Render as an SgMenu menuitem instead of a standalone icon button. */
    asMenuItem?: boolean;
    /** Optional callback so a menu host can surface status messages outside the closed menu. */
    onMessage?: (message: string | null) => void;
  }

  const { item, disabled, asMenuItem = false, onMessage }: Props = $props();

  const failedPhase = $derived(item.status === 'failed' ? item.currentPhase : null);
  const labelHint = $derived(item.label.length > 24 ? `${item.label.slice(0, 24)}...` : item.label);

  let message = $state<string | null>(null);
  function setMessage(next: string | null): void {
    message = next;
    onMessage?.(next);
  }
  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());
  const wait = lifecycleWait(lifetime.signal, (late) => setMessage(late));

  async function onRestart(): Promise<void> {
    if (disabled || failedPhase === null) return;
    setMessage(null);
    const result = await restartPhase(failedPhase, item.queueId ?? DEFAULT_QUEUE_ID, wait);
    if (lifetime.signal.aborted) return;
    setMessage(lifecycleMessage(result));
  }
</script>

{#if failedPhase !== null}
  {#if asMenuItem}
    <button
      type="button"
      role="menuitem"
      data-testid="queue-item-restart-phase-{item.id}"
      aria-label={`Restart failed phase ${failedPhase} of '${labelHint}'`}
      title={`Restart failed phase ${failedPhase} of '${labelHint}'`}
      aria-disabled={disabled ? 'true' : 'false'}
      onclick={onRestart}
    ><svg class="i" aria-hidden="true"><use href="#i-loop"></use></svg>Restart failed phase</button>
  {:else}
    <button
      type="button"
      class="icon-btn"
      data-testid="queue-item-restart-phase-{item.id}"
      aria-label={`Restart failed phase ${failedPhase} of '${labelHint}'`}
      title={`Restart failed phase ${failedPhase} of '${labelHint}'`}
      aria-disabled={disabled ? 'true' : 'false'}
      onclick={onRestart}
    ><svg class="i" aria-hidden="true"><use href="#i-loop"></use></svg></button>
    {#if message}
      <span class="restart-message" role="status" data-testid="queue-item-restart-phase-message-{item.id}"
        >{message}</span
      >
    {/if}
  {/if}
{/if}

<style>
  /* Drawn as its neighbours in `QueueItemActions` are: the redesign's icon button. */
  .icon-btn {
    color: var(--schegent-muted-fg);
    font: inherit;
  }
  .icon-btn:hover:not([aria-disabled='true']) {
    color: var(--schegent-fg);
  }
  .restart-message {
    color: var(--schegent-error-text);
    font-size: var(--schegent-text-secondary);
    margin-left: var(--schegent-space-1);
  }
</style>
