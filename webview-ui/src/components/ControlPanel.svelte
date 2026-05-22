<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { postCommand } from '../lib/vscode-api';
  import {
    CMD_CANCEL,
    CMD_RESET,
    CMD_RESUME,
    CMD_START
  } from '../lib/messages';
  import { useConfirm } from '../lib/use-confirm';
  import { confirmSuppressionStore } from '../lib/confirm-suppression-store.svelte';
  import { ACTION_COPY, type ActionKey } from '../lib/action-copy';

  let pendingId = $state<string | null>(null);
  let showStartForm = $state(false);
  let startDescription = $state('');

  // Feature 063 (T040) — re-enable-prompts panel. Reads the live
  // suppressed set from the snapshot-backed store; clicking a row posts
  // `CMD_SET_CONFIRM_SUPPRESSION` with `suppressed: false`. The
  // suppressed array is sourced from the host memento so a write in
  // another VS Code window propagates after the next snapshot push.
  const suppressedActions = $derived<readonly ActionKey[]>(
    snapshotStore.snapshot?.confirmSuppression?.suppressedActionKeys
      ?.filter((k): k is ActionKey => k in ACTION_COPY) ?? []
  );

  function unsuppress(actionKey: ActionKey): void {
    confirmSuppressionStore.setSuppressed(actionKey, false);
  }

  function unsuppressAll(): void {
    for (const key of suppressedActions) {
      confirmSuppressionStore.setSuppressed(key, false);
    }
  }

  const status = $derived(snapshotStore.status);
  const isPrimary = $derived(snapshotStore.isPrimary);

  const isPending = $derived(pendingId !== null && snapshotStore.isPending(pendingId));
  const startDisabled = $derived(!isPrimary || isPending || status !== 'idle');
  const cancelDisabled = $derived(!isPrimary || isPending || status !== 'running');
  const resumeDisabled = $derived(
    !isPrimary || isPending || (status !== 'paused' && status !== 'failed')
  );
  const resetDisabled = $derived(!isPrimary || isPending);

  const tooltip = $derived(
    !isPrimary
      ? 'Another window is the primary controller for this workspace'
      : ''
  );

  function track(correlationId: string): void {
    pendingId = correlationId;
    snapshotStore.markPending(correlationId);
  }

  function submitStart(): void {
    const desc = startDescription.trim();
    if (desc.length === 0) return;
    const { correlationId } = postCommand(CMD_START, { description: desc });
    track(correlationId);
    showStartForm = false;
    startDescription = '';
  }

  function send(type: typeof CMD_CANCEL | typeof CMD_RESUME): void {
    const { correlationId } = postCommand(type);
    track(correlationId);
  }

  async function onResetClick(event: MouseEvent): Promise<void> {
    // Feature 063 (T039) — Reset Workspace is the most destructive
    // surface and routes through the unsuppressible
    // `useConfirm('workspace.reset')` flow. The helper enforces
    // `suppressible: false` so the checkbox never renders for this key.
    if (resetDisabled) return;
    const ok = await useConfirm('workspace.reset', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: {}
    });
    if (!ok) return;
    const { correlationId } = postCommand(CMD_RESET, { confirmed: true });
    track(correlationId);
  }

  function onStartFormKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      showStartForm = false;
      startDescription = '';
    }
  }
</script>

<section class="panel" data-testid="control-panel" aria-label="Workflow controls">
  <div class="row">
    <button
      type="button"
      data-testid="control-start"
      title={tooltip}
      disabled={startDisabled}
      onclick={() => (showStartForm = true)}
    >
      Start
    </button>
    <button
      type="button"
      data-testid="control-cancel"
      title={tooltip}
      disabled={cancelDisabled}
      onclick={() => send(CMD_CANCEL)}
    >
      Cancel
    </button>
    <button
      type="button"
      data-testid="control-resume"
      title={tooltip}
      disabled={resumeDisabled}
      onclick={() => send(CMD_RESUME)}
    >
      Resume
    </button>
    <button
      type="button"
      data-testid="control-reset"
      title={tooltip}
      disabled={resetDisabled}
      onclick={onResetClick}
    >
      Reset
    </button>
  </div>

  {#if showStartForm}
    <form
      class="start-form"
      data-testid="start-form"
      onsubmit={(e) => {
        e.preventDefault();
        submitStart();
      }}
    >
      <label for="start-desc">Feature description</label>
      <input
        id="start-desc"
        type="text"
        data-testid="start-input"
        bind:value={startDescription}
        maxlength="4096"
        autocomplete="off"
        placeholder="Describe the next feature…"
        onkeydown={onStartFormKey}
      />
      <div class="row">
        <button type="submit" data-testid="start-submit">Run</button>
        <button type="button" data-testid="start-cancel" onclick={() => (showStartForm = false)}>
          Cancel
        </button>
      </div>
    </form>
  {/if}

  {#if suppressedActions.length > 0}
    <section
      class="suppression-panel"
      data-testid="confirm-suppression-panel"
      aria-label="Re-enable confirmation prompts"
    >
      <header class="suppression-header">
        <h3>Confirmation prompts</h3>
        <button
          type="button"
          class="suppression-reenable-all"
          data-testid="confirm-suppression-reenable-all"
          onclick={unsuppressAll}
          disabled={!isPrimary}
          title="Re-enable confirmation prompts for every suppressed action"
        >Re-enable all</button>
      </header>
      <ul class="suppression-list">
        {#each suppressedActions as actionKey (actionKey)}
          <li class="suppression-row" data-testid="confirm-suppression-row-{actionKey}">
            <span class="suppression-title" title={ACTION_COPY[actionKey].title}>
              {ACTION_COPY[actionKey].title}
            </span>
            <button
              type="button"
              class="suppression-reenable"
              data-testid="confirm-suppression-reenable-{actionKey}"
              onclick={() => unsuppress(actionKey)}
              disabled={!isPrimary}
              title="Re-enable the confirmation prompt for this action"
            >Re-enable</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

</section>

<style>
  .panel {
    padding: var(--schegent-pad);
    border-bottom: 1px solid var(--schegent-divider);
    display: flex;
    flex-direction: column;
    gap: var(--schegent-gap);
  }
  .row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  button {
    background: var(--schegent-button-bg);
    color: var(--schegent-button-fg);
    border: 1px solid transparent;
    padding: 4px 10px;
    border-radius: var(--schegent-radius);
    cursor: pointer;
    transition: transform 0.1s ease, opacity 0.1s ease;
  }
  button:hover:not(:disabled) {
    background: var(--schegent-button-hover);
  }
  button:active:not(:disabled) {
    transform: scale(0.93);
    opacity: 0.8;
  }
  button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .start-form {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .start-form input {
    background: var(--schegent-input-bg);
    color: var(--schegent-input-fg);
    border: 1px solid var(--schegent-input-border);
    border-radius: var(--schegent-radius);
    padding: 4px 6px;
  }
  .suppression-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: var(--schegent-gap);
    border-top: 1px solid var(--schegent-divider);
  }
  .suppression-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--schegent-gap);
  }
  .suppression-header h3 {
    margin: 0;
    font-size: 0.85em;
    font-weight: 600;
    color: var(--schegent-muted-fg);
  }
  .suppression-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .suppression-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--schegent-gap);
  }
  .suppression-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85em;
  }
  .suppression-reenable,
  .suppression-reenable-all {
    background: transparent;
    color: var(--schegent-muted-fg);
    border: 1px solid var(--schegent-border);
    padding: 2px 8px;
    font-size: 0.8em;
  }
  .suppression-reenable:hover:not(:disabled),
  .suppression-reenable-all:hover:not(:disabled) {
    color: var(--schegent-fg);
  }
</style>
