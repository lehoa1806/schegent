<script lang="ts">
  import type { QueueItem } from '../lib/snapshot-types';
  import { postCommand } from '../lib/vscode-api';
  import {
    CMD_RETRY_QUEUE_ITEM,
    // Feature 030 (US2, T034) — moved reorder UX (drag handle + up/down
    // arrows) into QueueItem.svelte, which routes through the shared
    // helper at webview-ui/src/lib/reorder-task.ts. The inline reorder
    // IPC call sites that lived here were removed; the lint regression
    // at tests/lint/no-inline-reorder-ipc.test.ts pins the single helper.
    // Feature 030 (US3, T045) — removed the move-task command alongside
    // the multi-queue surfaces. There is exactly one queue now; the
    // "Move to another queue" affordance is meaningless and has been
    // deleted from this component. See
    // `tests/lint/no-multi-queue-commands.test.ts`.
    CMD_CANCEL,
    CMD_REMOVE_QUEUE_ITEM,
    CMD_MODIFY_TASK,
    CMD_RESTART_CANCELED_TASK
  } from '../lib/messages';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { useConfirm } from '../lib/use-confirm';

  interface Props {
    item: QueueItem;
    isPrimary: boolean;
  }

  const { item, isPrimary }: Props = $props();

  const status = $derived(item.status);
  // Feature 065 BUG-009 T080 (FR-026) — Retry (↻) affordance is available
  // for BOTH `failed` AND `paused` rows. Paused tasks are "stuck" and need
  // operator-initiated retry to resurrect them; previously they had no
  // recovery surface and operators had to remove + re-enqueue.
  const showRetry = $derived(status === 'failed' || status === 'paused');
  // Feature 030 (US2, T034) — the inline up/down arrows that used to
  // live here moved to QueueItem.svelte and now route through the
  // shared helper at webview-ui/src/lib/reorder-task.ts. The
  // `pendingCount` prop was dropped from this component because it was
  // only consumed by the up/down disabled gating that no longer exists.
  const showRemove = $derived(true);
  // Feature 030 (US3, T045) — renamed from `showPendingEditMove` to
  // `showPendingEdit`; the per-queue Move affordance was deleted alongside
  // the multi-queue surfaces (there is exactly one queue now).
  const showPendingEdit = $derived(status === 'pending');
  const showInFlightCancel = $derived(status === 'in-flight');
  // Feature 017 — BUG-001. Canceled tasks expose a Restart affordance that
  // resurrects the FeatureRequest to `pending` so the dequeue pump picks it
  // up. Distinct from the failed-row Retry path.
  const showRestartCanceled = $derived(status === 'canceled');
  const disabled = $derived(!isPrimary);
  const ariaDisabled = $derived(disabled ? 'true' : 'false');

  let editOpen = $state(false);
  let editDraft = $state('');
  // BUG-002 (T117) — transient inline rejection message when the host
  // rejects CMD_REMOVE_QUEUE_ITEM (e.g., the row was no longer pending
  // by the time the click reached the host). Cleared on the next click
  // attempt so the operator can retry without stale text lingering.
  let removeError = $state<string | null>(null);

  $effect(() => {
    editDraft = item.label;
  });

  function safePost(emit: () => void): void {
    if (disabled) return;
    emit();
  }

  function onRetry(): void {
    safePost(() => postCommand(CMD_RETRY_QUEUE_ITEM, { id: item.id }));
  }
  async function onCancelInFlight(event: MouseEvent): Promise<void> {
    if (disabled) return;
    // Feature 063 — gate the in-flight cancel through the universal
    // confirmation. The host resolves the FeatureRequest by per-row
    // taskId (017 BUG-001), so the IPC payload mirrors the legacy path.
    const ok = await useConfirm('queue.cancel-item', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: { taskTitle: item.label, isRunning: true }
    });
    if (!ok) return;
    postCommand(CMD_CANCEL, { taskId: item.id });
  }
  async function onRestartCanceled(event: MouseEvent): Promise<void> {
    if (disabled) return;
    const ok = await useConfirm('run.restart-canceled', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: { taskTitle: item.label }
    });
    if (!ok) return;
    postCommand(CMD_RESTART_CANCELED_TASK, { taskId: item.id });
  }
  async function onRequestRemove(event: MouseEvent): Promise<void> {
    if (disabled) return;
    const ok = await useConfirm('queue.remove-item', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: { taskTitle: item.label }
    });
    if (!ok) return;
    // BUG-002 (T117) — clear any prior rejection text before dispatching
    // so the operator sees the fresh outcome (or no text on success).
    removeError = null;
    const { correlationId } = postCommand(CMD_REMOVE_QUEUE_ITEM, {
      id: item.id,
      confirmed: true
    });
    snapshotStore.markPending(correlationId);
    snapshotStore.onceAck(correlationId, (ack) => {
      if (ack.status === 'rejected') {
        removeError = humanizeRemoveRejection(ack.reason);
      }
    });
  }
  function humanizeRemoveRejection(reason: string | undefined): string {
    if (reason === 'task-not-in-pending-state') {
      return 'Cannot remove: task is no longer pending.';
    }
    if (reason === 'missing-confirmation') {
      return 'Cannot remove: deletion was not confirmed.';
    }
    if (reason === 'unknown-task-id' || reason === 'not-found') {
      return 'Cannot remove: task no longer exists.';
    }
    return `Cannot remove: ${reason ?? 'rejected'}.`;
  }
  async function onSaveEdit(event: SubmitEvent): Promise<void> {
    if (disabled) return;
    const description = editDraft.trim();
    if (description.length === 0) return;
    const ok = await useConfirm('run.modify-task', {
      originatingElement: (event.submitter as HTMLElement | null) ?? null,
      context: { taskTitle: description }
    });
    if (!ok) return;
    postCommand(CMD_MODIFY_TASK, { taskId: item.id, description });
    editOpen = false;
  }
  // Feature 030 (US3, T045) — `onMoveTask` and the per-row "Move to
  // another queue" form were removed alongside the move-task command.
  // With a single unified queue there is no other queue to move into.

  const labelHint = $derived(item.label.length > 24 ? `${item.label.slice(0, 24)}...` : item.label);
</script>

<div class="actions" data-testid="queue-item-actions-{item.id}">
  {#if showInFlightCancel}
    <button
      type="button"
      data-testid="queue-item-cancel-{item.id}"
      aria-label={`Cancel '${labelHint}'`}
      title={`Cancel '${labelHint}'`}
      aria-disabled={ariaDisabled}
      onclick={onCancelInFlight}
    >⏹</button>
  {/if}
  {#if showRemove}
    {#if showPendingEdit}
      <button
        type="button"
        data-testid="queue-item-edit-{item.id}"
        aria-label={`Edit '${labelHint}'`}
        title={`Edit '${labelHint}'`}
        aria-disabled={ariaDisabled}
        onclick={() => (editOpen = !editOpen)}
      >✎</button>
      <!--
        Feature 030 (US3, T045) — removed the "Move to another queue"
        affordance alongside the multi-queue surfaces. The single
        unified queue has no other queue to move into.
      -->
    {/if}
    <button
      type="button"
      data-testid="queue-item-remove-{item.id}"
      aria-label={`Remove '${labelHint}' from queue`}
      title={`Remove '${labelHint}' from queue`}
      aria-disabled={ariaDisabled}
      onclick={onRequestRemove}
    >✖</button>
    {#if removeError}
      <span
        class="remove-error"
        role="status"
        data-testid="queue-item-remove-error-{item.id}"
      >{removeError}</span>
    {/if}
  {/if}
  {#if showRetry}
    <button
      type="button"
      data-testid="queue-item-retry-{item.id}"
      aria-label={`Retry feature '${labelHint}'`}
      title={`Retry feature '${labelHint}'`}
      aria-disabled={ariaDisabled}
      onclick={onRetry}
    >↻</button>
  {/if}
  {#if showRestartCanceled}
    <button
      type="button"
      data-testid="queue-item-restart-{item.id}"
      aria-label={`Restart canceled task '${labelHint}'`}
      title={`Restart canceled task '${labelHint}'`}
      aria-disabled={ariaDisabled}
      onclick={onRestartCanceled}
    >↻</button>
  {/if}
</div>



{#if editOpen}
  <form class="inline-form" data-testid="queue-item-edit-form-{item.id}" onsubmit={(event) => { event.preventDefault(); onSaveEdit(event); }}>
    <input bind:value={editDraft} data-testid="queue-item-edit-input-{item.id}" title="Edit task description" />
    <button type="submit" data-testid="queue-item-edit-save-{item.id}" aria-disabled={ariaDisabled} title="Save edits">Save</button>
  </form>
{/if}

<!--
  Feature 030 (US3, T045) — the move-to-another-queue inline form was
  removed alongside the move-task command and the multi-queue surfaces.
  The per-row Edit form above remains intact (CMD_MODIFY_TASK).
-->

<style>
  .actions {
    display: inline-flex;
    flex-direction: row;
    gap: 4px;
    align-items: center;
  }
  button {
    background: transparent;
    color: var(--schegent-muted-fg);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    padding: 0 6px;
    font: inherit;
    cursor: pointer;
    transition: transform 0.1s ease, opacity 0.1s ease;
  }
  button[aria-disabled='true'] {
    opacity: 0.55;
    cursor: not-allowed;
  }
  button:hover:not([aria-disabled='true']) {
    color: var(--schegent-fg);
  }
  button:active:not([aria-disabled='true']) {
    transform: scale(0.93);
    opacity: 0.8;
  }
  .inline-form {
    display: inline-flex;
    gap: 4px;
    margin-left: 4px;
    align-items: center;
  }
  input {
    min-width: 120px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--schegent-border));
    border-radius: var(--schegent-radius);
    padding: 0 6px;
    font: inherit;
  }
  .remove-error {
    color: var(--schegent-color-error);
    font-size: 0.85em;
    margin-left: 4px;
  }
</style>
