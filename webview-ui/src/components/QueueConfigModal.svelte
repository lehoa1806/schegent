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
  import { adviseStreamPressure } from '../../../src/contracts/stream-pressure-advice';
  import type { QueueRuntime, QueueSettingsProjection } from '../lib/snapshot-types';

  interface Props {
    /**
     * The projected queue settings — the prefill source (FR-009). Never a constant.
     *
     * FR-R3-145 (T1572) — was `generalSettings: GeneralSettings`, the CONFIGURATION
     * projection. This dialog saves through `CMD_SAVE_QUEUE_SETTINGS`, which writes
     * the workspace memento, so prefilling from configuration meant the dialog could
     * not read back its own write: reopening it showed the old number and the
     * operator's save looked lost. Same store in, same store out.
     */
    queueSettings: QueueSettingsProjection;
    /** The queues that exist right now; the default-queue options (FR-009). */
    queues: readonly QueueRuntime[];
    onClose: () => void;
    /** Focus returns here on unmount, as `ConfirmDialog` does. */
    originatingElement?: HTMLElement | null;
    /**
     * FR-R3-130 (T1495) — `os.totalmem()`, from the stream-pressure projection.
     *
     * Defaulted to `0` rather than made required, and `adviseStreamPressure` reads 0
     * as "do not warn": a caller with no snapshot should show no warning rather than
     * a warning computed from nothing.
     */
    machineMemoryBytes?: number;
  }

  const {
    queueSettings,
    queues,
    onClose,
    originatingElement = null,
    machineMemoryBytes = 0
  }: Props = $props();

  // Suggested bounds only. The cap's range is [1, 20]; the host is what enforces
  // it. FR-R3-145 (T1572) — this comment named a `schegent.*` configuration key
  // that no longer exists and that no scheduling path ever read.
  // `MAX_QUEUES` in `src/contracts/queue-bounds.ts` is the ceiling's one source.
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
  /**
   * FR-R3-130 (T1495) — what this cap will cost, at the moment it is typed.
   *
   * The audit of 2026-08-27's point about the cap-20 ceiling was that an operator can
   * accept it without ever seeing it. The threshold is machine-derived and the
   * coefficient comes from `docs/operations/large-workspace-resource-measurement.md`
   * — not from a constant chosen at the keyboard, which is the arithmetic `FR-R3-081`
   * ruled out.
   *
   * It WARNS. It does not disable Save: the cap's range is ratified, and an operator
   * on a large machine raising it is making a legitimate choice. What was missing is
   * that the choice was invisible.
   */
  const pressureAdvice = $derived.by(() => {
    const parsed = Number(cap);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    const advice = adviseStreamPressure({
      cap: parsed,
      machineMemoryBytes: machineMemoryBytes
    });
    return advice.level === 'warn' ? advice.message : null;
  });

  const initialCap = (): string => String(queueSettings.globalConcurrencyCap);
  const initialDefaultQueue = (): string => queueSettings.defaultQueueId;

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
    aria-describedby="queue-config-cap-shared-tree"
    data-testid="queue-config-cap"
    bind:this={capInputEl}
    bind:value={cap}
  />
  <!--
    FR-R3-124 (FR-003) — the consequence, at the point of decision.

    The sentence already existed in the manifest description, the operator guide
    and two architecture documents. None of them is on screen at the moment the
    number changes, which is the only moment it matters. The audit of 2026-08-27
    named shared-tree parallelism one of three dominating risks; per-Run isolation
    is DECIDED and GATED in `repo/docs/architecture/run-isolation-decision.md`, not
    shipped, so above one this text is the whole boundary.

    It is `aria-describedby` rather than loose text so assistive technology
    announces it as the field's description; a paragraph merely sitting next to a
    number input is not announced with it.

    `tests/lint/concurrency-isolation-disclosure.test.ts` asserts both this text
    and the association, and fails if either is removed.
  -->
  <p class="disclosure" id="queue-config-cap-shared-tree" data-testid="queue-config-cap-disclosure">
    Above one, concurrent Runs share one working tree. They may edit the same files, so semantic
    conflicts between Runs are possible and a recovery checkpoint may be declined as
    unattributable.
  </p>

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

  {#if pressureAdvice !== null}
    <p class="pressure-advice" role="status" data-testid="queue-config-pressure-advice">
      {pressureAdvice}
    </p>
  {/if}

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
  .pressure-advice {
    margin: 0;
    padding: 6px 8px;
    border-left: 3px solid var(--vscode-editorWarning-foreground);
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-foreground);
    font-size: 0.9em;
  }

  .disclosure {
    margin: 0;
    font-size: 0.9em;
    /* Theme tokens only: FR-R3-131 baselined 30 contrast violations and no new
       hard-coded colour is added here. `descriptionForeground` is the token VS
       Code uses for exactly this role. */
    color: var(--vscode-descriptionForeground);
  }

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
