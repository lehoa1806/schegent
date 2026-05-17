<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { postCommand } from '../lib/vscode-api';
  import {
    CMD_CANCEL,
    CMD_RESET,
    CMD_RESUME,
    CMD_START
  } from '../lib/messages';

  let pendingId = $state<string | null>(null);
  let showStartForm = $state(false);
  let startDescription = $state('');
  let confirmReset = $state(false);

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

  function sendReset(): void {
    const { correlationId } = postCommand(CMD_RESET, { confirmed: true });
    track(correlationId);
    confirmReset = false;
  }

  function onStartFormKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      showStartForm = false;
      startDescription = '';
    }
  }

  function onResetConfirmKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      confirmReset = false;
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
      onclick={() => (confirmReset = true)}
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

  {#if confirmReset}
    <div
      class="confirm"
      data-testid="reset-confirm"
      role="alertdialog"
      tabindex="-1"
      onkeydown={onResetConfirmKey}
    >
      <p>Reset will clear queue, run state, and lock. Continue?</p>
      <div class="row">
        <button type="button" data-testid="reset-confirm-yes" onclick={sendReset}>
          Yes, reset
        </button>
        <button
          type="button"
          data-testid="reset-confirm-no"
          onclick={() => (confirmReset = false)}
        >
          No
        </button>
      </div>
    </div>
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
  .start-form,
  .confirm {
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
  .confirm p {
    margin: 0;
    color: var(--schegent-muted-fg);
  }
</style>
