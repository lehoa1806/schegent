<script lang="ts">
  /**
   * Feature 011 T057 — Raw-JSON editor for a single PhaseDefinition.
   *
   * Reactive validation:
   *   - parses JSON on every keystroke
   *   - validates against PhaseDefinition shape (required fields,
   *     types). Unknown top-level fields are preserved (FR-031).
   *   - Save is disabled while validation fails (FR-029)
   *   - emits the parsed object via onsave callback when Save is clicked
   *
   * Pretty-print format: two-space indent (FR-028).
   */

  interface RawPhase {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly instruction?: unknown;
    readonly model?: unknown;
    readonly effort?: unknown;
    readonly timeoutSeconds?: unknown;
    readonly loopable?: unknown;
    readonly retryCondition?: unknown;
    readonly runner?: unknown;
    readonly [k: string]: unknown;
  }

  interface Props {
    /** The phase definition to edit; serialized as the initial JSON. */
    phase: RawPhase;
    /** Called with the parsed phase object on Save (when valid). */
    onsave?: (phase: RawPhase) => void;
  }

  const props: Props = $props();
  const onsave = $derived(props.onsave);

  type Verdict = { ok: true; value: RawPhase } | { ok: false; error: string };

  function pretty(phase: RawPhase): string {
    return JSON.stringify(phase, null, 2);
  }

  function tryParse(src: string): Verdict {
    if (!src || src.trim() === '') {
      return { ok: false, error: 'empty document' };
    }
    let value: unknown;
    try {
      value = JSON.parse(src);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'must be a JSON object' };
    }
    const obj = value as Record<string, unknown>;
    // Required fields: id, name, instruction. `loopable` remains an optional
    // deprecated compatibility field for older saved phase definitions.
    if (typeof obj['id'] !== 'string' || obj['id'].length === 0) {
      return { ok: false, error: 'field `id` must be a non-empty string' };
    }
    if (typeof obj['name'] !== 'string' || obj['name'].length === 0) {
      return { ok: false, error: 'field `name` must be a non-empty string' };
    }
    if (typeof obj['instruction'] !== 'string') {
      return { ok: false, error: 'field `instruction` must be a string' };
    }
    // Optional fields — validate when present
    if ('model' in obj && obj['model'] !== undefined && typeof obj['model'] !== 'string') {
      return { ok: false, error: 'field `model` must be a string when present' };
    }
    if (
      'effort' in obj &&
      obj['effort'] !== undefined &&
      typeof obj['effort'] !== 'string'
    ) {
      return { ok: false, error: 'field `effort` must be a string when present' };
    }
    if (
      'timeoutSeconds' in obj &&
      obj['timeoutSeconds'] !== undefined &&
      typeof obj['timeoutSeconds'] !== 'number'
    ) {
      return { ok: false, error: 'field `timeoutSeconds` must be a number when present' };
    }
    if (
      'loopable' in obj &&
      obj['loopable'] !== undefined &&
      typeof obj['loopable'] !== 'boolean'
    ) {
      return { ok: false, error: 'field `loopable` must be a boolean when present' };
    }
    if (
      'retryCondition' in obj &&
      obj['retryCondition'] !== undefined &&
      typeof obj['retryCondition'] !== 'string'
    ) {
      return { ok: false, error: 'field `retryCondition` must be a string when present' };
    }
    if (
      'runner' in obj &&
      obj['runner'] !== undefined &&
      (typeof obj['runner'] !== 'string' || !['claude', 'codex', 'agy'].includes(obj['runner']))
    ) {
      return { ok: false, error: 'field `runner` must be one of claude, codex, agy when present' };
    }
    return { ok: true, value: obj as RawPhase };
  }

  let raw = $state('');
  let initialized = false;

  $effect.pre(() => {
    if (initialized) return;
    initialized = true;
    raw = pretty(props.phase);
  });

  const verdict = $derived<Verdict>(tryParse(raw));

  function onInput(event: Event): void {
    raw = (event.target as HTMLTextAreaElement).value;
  }

  function onSaveClick(): void {
    if (!verdict.ok) return;
    onsave?.(verdict.value);
  }

  function onResetClick(): void {
    raw = pretty(props.phase);
  }
</script>

<div class="raw-json-phase-editor" data-testid="raw-json-phase-editor">
  <div class="rj-header">
    <span class="rj-title">Raw JSON</span>
    <span class="rj-hint">Edit the underlying PhaseDefinition document directly.</span>
  </div>
  <textarea
    class="rj-input"
    data-testid="raw-json-input"
    rows="16"
    spellcheck="false"
    value={raw}
    oninput={onInput}
  ></textarea>
  {#if !verdict.ok}
    <div class="rj-error" data-testid="raw-json-error" role="alert">
      <strong>Invalid JSON:</strong> {verdict.error}
    </div>
  {/if}
  <div class="rj-actions">
    <button
      type="button"
      class="btn btn-secondary"
      data-testid="raw-json-save"
      disabled={!verdict.ok}
      onclick={onSaveClick}
    >Save</button>
    <button
      type="button"
      class="btn btn-ghost"
      data-testid="raw-json-reset"
      onclick={onResetClick}
    >Reset</button>
  </div>
</div>

<style>
  .raw-json-phase-editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .rj-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .rj-title {
    font-weight: 600;
    font-size: 0.9em;
  }
  .rj-hint {
    color: var(--schegent-muted-fg);
    font-size: 0.75em;
  }
  .rj-input {
    background: var(--vscode-input-background);
    color: var(--schegent-fg);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    padding: 8px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    resize: vertical;
    min-height: 240px;
  }
  .rj-input:focus {
    outline: none;
    border-color: var(--schegent-focus-border);
  }
  .rj-error {
    color: var(--schegent-color-error);
    background: color-mix(in srgb, var(--schegent-color-error) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--schegent-color-error) 30%, transparent);
    border-radius: var(--schegent-radius);
    padding: 8px;
    font-size: 0.85em;
  }
  .rj-actions {
    display: flex;
    gap: 8px;
  }
  .btn {
    padding: 4px 12px;
    border-radius: var(--schegent-radius);
    font-size: 0.9em;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary { background: var(--schegent-button-secondary-bg); color: var(--schegent-button-secondary-fg); }
  .btn-ghost { background: transparent; color: var(--schegent-muted-fg); }
  .btn-ghost:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
</style>
