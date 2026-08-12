<script lang="ts">
  /**
   * Feature 031 T024 — Wake-up model selector.
   *
   * Lets the operator pick the Claude model the OS-scheduled (and
   * manual "Wake up now") wake-up runner invokes. Persists through the
   * existing wake-up settings save IPC — NO new mutating command.
   *
   * Closed-vocabulary registry pinned by the host at
   * `src/wakeup/settings.ts` (`WAKEUP_SUPPORTED_MODELS`). The webview
   * mirror lives in `webview-ui/src/lib/snapshot-types.ts` so the
   * bundle does not reach into host source at runtime.
   *
   * Renders four `<option>` rows:
   *   - "Default (runner-chosen)"   → value `'runner-default'`
   *   - Each member of `WAKEUP_SUPPORTED_MODELS` → value = id
   *
   * Defensive coercion: a prop that is not the sentinel and not a
   * member of the registry is coerced to the sentinel on render
   * (so a future drift between host + webview can never strand the
   * UI on an unknown id).
   *
   * Save flows through the shared helper at
   * `webview-ui/src/lib/save-wakeup-settings.ts` — the CLAUDE.md
   * single-call-site invariant for the wake-up save command. The
   * lint regression at
   * `tests/lint/no-inline-save-wakeup-settings.test.ts` blocks any
   * direct `postCommand(...)` inlining here; the literal command name
   * is intentionally NOT mentioned anywhere in this file so the
   * grep-based regression cannot trip on prose.
   *
   * All option labels render via `{text}` bindings only (no `{@html}`)
   * — the closed-vocabulary identifiers are still operator-influenced
   * through prop coercion and we keep the strict-text-binding rule
   * consistent across the surface (CLAUDE.md hard rule).
   */
  import {
    RUNNER_DEFAULT_MODEL,
    WAKEUP_SUPPORTED_MODELS,
    type WakeUpModelSelection,
    type WakeUpSettings
  } from '../../../lib/snapshot-types';
  import { saveWakeUpSettings } from '../../../lib/save-wakeup-settings';
  import { hoverTextAnchor } from '../../hover-text/hover-text-anchor-action';
  import { WAKEUP_DESCRIPTIONS } from '../WakeUpTab.descriptions';

  interface Props {
    /** Persisted model. The sentinel `'runner-default'` or a registry member. */
    model: WakeUpModelSelection;
    /** Full WakeUpSettings — merged with the new model on Save. */
    settings: Pick<
      WakeUpSettings,
      'enabled' | 'schedulerType' | 'chronologicalTime' | 'periodicInterval'
    >;
  }

  const { model, settings }: Props = $props();

  type StatusState =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'accepted' }
    | { kind: 'rejected'; reason: string };

  // Defensive coercion: collapse anything outside the registry +
  // sentinel back to the sentinel so the rendered `<select>` is
  // always pointing at a known option.
  function coerce(value: unknown): WakeUpModelSelection {
    if (value === RUNNER_DEFAULT_MODEL) return RUNNER_DEFAULT_MODEL;
    if (typeof value === 'string'
      && (WAKEUP_SUPPORTED_MODELS as readonly string[]).includes(value)
    ) {
      return value as WakeUpModelSelection;
    }
    return RUNNER_DEFAULT_MODEL;
  }

  const projectedModel = $derived<WakeUpModelSelection>(coerce(model));
  let draft = $state<WakeUpModelSelection>(RUNNER_DEFAULT_MODEL);
  let lastProjectedModel = $state<WakeUpModelSelection>(RUNNER_DEFAULT_MODEL);
  let initialized = $state(false);
  let status = $state<StatusState>({ kind: 'idle' });

  // Resync the draft when the snapshot projection changes — same
  // pattern as WakeUpTab.svelte's `lastProjectedJson` reflow.
  $effect(() => {
    const next = projectedModel;
    if (initialized && next === lastProjectedModel) return;
    draft = next;
    lastProjectedModel = next;
    initialized = true;
    status = { kind: 'idle' };
  });

  async function onSave(): Promise<void> {
    if (status.kind === 'pending') return;
    status = { kind: 'pending' };
    const result = await saveWakeUpSettings({
      enabled: settings.enabled,
      schedulerType: settings.schedulerType,
      chronologicalTime: settings.chronologicalTime,
      periodicInterval: settings.periodicInterval,
      model: draft
    });
    status = result.status === 'accepted'
      ? { kind: 'accepted' }
      : { kind: 'rejected', reason: result.reason };
  }
</script>

<div class="model-selector" data-testid="wakeup-model-selector">
  <div class="field-row" data-testid="wakeup-field-model">
    <div class="field-label">
      <span class="field-name" id="wakeup-label-model">Claude model</span>
    </div>
    <div class="field-input">
      <select
        class="select-input"
        data-testid="wakeup-input-model"
        aria-labelledby="wakeup-label-model"
        bind:value={draft}
        use:hoverTextAnchor={{
          controlId: 'wakeup-model',
          description: WAKEUP_DESCRIPTIONS.model
        }}
      >
        <option value={RUNNER_DEFAULT_MODEL}>{'Default (runner-chosen)'}</option>
        {#each WAKEUP_SUPPORTED_MODELS as id (id)}
          <option value={id}>{id}</option>
        {/each}
      </select>
    </div>
  </div>

  <div class="toolbar">
    <button
      type="button"
      class="btn btn-primary"
      data-testid="wakeup-model-save"
      disabled={status.kind === 'pending'}
      onclick={onSave}
      use:hoverTextAnchor={{
        controlId: 'wakeup-model-save',
        description: WAKEUP_DESCRIPTIONS['model-save']
      }}
    >Save model</button>
    {#if status.kind === 'pending'}
      <span class="status-text status-pending" data-testid="wakeup-model-status" role="status">{'Saving…'}</span>
    {:else if status.kind === 'accepted'}
      <span class="status-text status-accepted" data-testid="wakeup-model-status" role="status">{'Saved'}</span>
    {:else if status.kind === 'rejected'}
      <span class="status-text status-rejected" data-testid="wakeup-model-status" role="alert">
        {`Rejected: ${status.reason}`}
      </span>
    {/if}
  </div>
</div>

<style>
  .model-selector {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-areas: "label input";
    gap: 4px 12px;
    padding: 12px;
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    background: var(--sch-glass-bg);
    align-items: center;
  }
  .field-label {
    grid-area: label;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .field-name { font-weight: 600; }
  .field-input {
    grid-area: input;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .select-input {
    background: var(--vscode-input-background);
    border: 1px solid var(--sch-glass-border);
    color: var(--schegent-fg);
    padding: 4px 8px;
    border-radius: var(--schegent-radius);
    width: 100%;
    box-sizing: border-box;
  }
  .select-input:focus {
    outline: none;
    border-color: var(--schegent-focus-border);
  }
  .toolbar {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .btn {
    padding: 6px 16px;
    border-radius: var(--schegent-radius);
    font-size: 0.9em;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }
  .status-text {
    font-size: 0.9em;
  }
  .status-pending { color: var(--schegent-muted-fg); }
  .status-accepted { color: var(--vscode-charts-green); }
  .status-rejected { color: var(--schegent-error-text); }
  @media (max-width: 720px) {
    .field-row {
      grid-template-columns: 1fr;
      grid-template-areas: "label" "input";
    }
  }
</style>
