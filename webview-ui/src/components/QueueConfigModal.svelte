<script lang="ts">
  // Feature 095 (T024–T028, US3, FR-009 to FR-011) — the workspace queue
  // settings: how many Runs may execute at once, and which queue receives a Task
  // that names none.
  //
  // Both values are workspace-scoped, so this is deliberately NOT folded into
  // `QueueDetailTier`'s per-queue Settings affordance — that one renames the
  // queue in front of the operator, and putting a workspace-wide cap beside it
  // would read as a property of that queue.
  //
  // The cap's accepted range is the host validator's. The input carries `min` and
  // `max` as a hint, and the submit path does not consult them: FR-011 says the
  // webview must not restate the range as its own rule, and a value the operator
  // types must be allowed to reach the host and come back refused.

  import { onMount, tick } from 'svelte';

  import { refusalText, saveQueueSettings } from '../lib/queue-control-ipc';
  import type { GeneralSettings, QueueRuntime } from '../lib/snapshot-types';

  interface Props {
    /** The projected settings — the prefill source (FR-009). Never a constant. */
    generalSettings: GeneralSettings;
    /** The queues that exist right now; the default-queue options (FR-009). */
    queues: readonly QueueRuntime[];
    onClose: () => void;
    /** Focus returns here on unmount, as `ConfirmDialog` does. */
    originatingElement?: HTMLElement | null;
  }

  const { generalSettings, queues, onClose, originatingElement = null }: Props = $props();

  // Suggested bounds only. `schegent.queue.globalConcurrencyCap` is [1, 20]; the
  // host is what enforces it.
  const CAP_HINT_MIN = 1;
  const CAP_HINT_MAX = 20;

  const options = $derived([...queues].sort((a, b) => a.position - b.position));

  // Both fields are seeded from the projection once and then owned by the
  // operator: a snapshot arriving mid-edit must not overwrite what they typed.
  // The seed is read through a function rather than inline, because an inline
  // `$props()` read inside `$state(...)` raises `state_referenced_locally` — the
  // warning for an *accidental* one-shot capture, which this deliberately is.
  // `untrack` does not silence it (see `settings/RetryConditionEditor.svelte`),
  // and that component's lazy `$effect` seed would render the modal blank for a
  // frame, so the value is captured synchronously here instead.
  const initialCap = (): string => String(generalSettings.queueGlobalConcurrencyCap);
  const initialDefaultQueue = (): string => generalSettings.queueDefaultQueueId;

  let cap = $state(initialCap());
  let defaultQueue = $state(initialDefaultQueue());
  let refusal = $state<string | null>(null);
  let busy = $state(false);
  let capInputEl: HTMLInputElement | null = $state(null);

  onMount(() => {
    void tick().then(() => capInputEl?.focus());
    return () => originatingElement?.focus?.();
  });

  async function save(): Promise<void> {
    // `Number()` converts; it does not judge. A value outside the range still
    // travels, and the host answers `out-of-range` (FR-011).
    const parsedCap = Number(cap);
    refusal = null;
    busy = true;
    try {
      const result = await saveQueueSettings(parsedCap, defaultQueue);
      if (result.status === 'rejected') {
        refusal = refusalText(result.reason);
        return;
      }
      onClose();
    } finally {
      busy = false;
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onClose();
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<div
  class="queue-config-modal"
  role="dialog"
  aria-modal="true"
  aria-labelledby="queue-config-title"
  data-testid="queue-config-modal"
>
  <h2 id="queue-config-title">Queue settings</h2>

  <label for="queue-config-cap">Concurrent runs</label>
  <input
    id="queue-config-cap"
    type="number"
    min={CAP_HINT_MIN}
    max={CAP_HINT_MAX}
    data-testid="queue-config-cap"
    bind:this={capInputEl}
    bind:value={cap}
  />

  <label for="queue-config-default-queue">Default queue</label>
  <select
    id="queue-config-default-queue"
    data-testid="queue-config-default-queue"
    bind:value={defaultQueue}
  >
    {#each options as option (option.queueId)}
      <option value={option.queueId}>{option.name}</option>
    {/each}
  </select>

  {#if refusal !== null}
    <p class="refusal" role="alert" data-testid="queue-config-refusal">{refusal}</p>
  {/if}

  <div class="actions">
    <button type="button" data-testid="queue-config-cancel" onclick={onClose}>Cancel</button>
    <button
      type="button"
      class="primary"
      data-testid="queue-config-save"
      disabled={busy}
      onclick={save}
    >Save</button>
  </div>
</div>

<style>
  .queue-config-modal {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 6px;
  }

  h2 {
    margin: 0 0 4px;
    font-size: 14px;
    font-weight: 600;
    color: var(--vscode-editor-foreground);
  }

  label {
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  input,
  select {
    font: inherit;
    padding: 6px 8px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }

  .refusal {
    margin: 0;
    font-size: 12px;
    color: var(--vscode-errorForeground);
  }

  .actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 4px;
  }

  button {
    font: inherit;
    color: var(--vscode-foreground);
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-widget-border, transparent);
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
  }

  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-border, transparent);
  }

  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
</style>
