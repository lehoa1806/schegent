<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    validate as validateExpression,
    type Expression,
    type ParseResult
  } from '../../lib/retry-condition';

  /**
   * Walks the parsed AST and returns every identifier-like leaf whose
   * name is not a substring of the phase instruction text. Falsely
   * negative if the instruction uses a different naming convention,
   * but the warning is advisory only (FR-026).
   */
  function computeMissingIdentifiers(
    expr: Expression,
    instructionText: string
  ): readonly string[] {
    const seen = new Set<string>();
    function walk(node: Expression): void {
      if (node.kind === 'compare') {
        if (node.left.kind === 'identifier') seen.add(node.left.name);
        if (node.right.kind === 'identifier') seen.add(node.right.name);
      } else if (node.kind === 'logical') {
        walk(node.left);
        walk(node.right);
      } else if (node.kind === 'not') {
        walk(node.expr);
      }
    }
    walk(expr);
    const missing: string[] = [];
    for (const id of seen) {
      if (!instructionText.includes(id)) missing.push(id);
    }
    return Object.freeze(missing);
  }

  interface ChangeEvent {
    readonly source: string;
    readonly valid: boolean;
    readonly error?: string;
    readonly missingIdentifiers: readonly string[];
  }

  interface Props {
    /** Current retry-condition source. */
    source: string;
    /** Phase instruction text used for cross-artifact metric check (FR-026). */
    instruction: string;
    /** Optional onchange callback fired after the 200ms debounce settles. */
    onchange?: (e: ChangeEvent) => void;
    /**
     * Feature 059 — when `true`, render the textarea as `readonly` so
     * the trust-denied state surfaces in the UI. Drift control: when the
     * value is read-only, the parent must NOT submit the row's
     * `retryCondition` field (the host gate would reject it anyway).
     */
    readonly?: boolean;
  }

  const props: Props = $props();
  const onchange = $derived(props.onchange);
  const isReadonly = $derived(props.readonly === true);

  // Local mutable copy of the source so the parent can re-render with
  // a new initial value without clobbering the operator's draft. Using
  // `untrack` here would still emit the state_referenced_locally
  // warning — we instead seed lazily on first $effect.
  let local = $state('');
  let initialized = false;

  // Verdict surfaced to the UI. Updates only after the debounce window
  // elapses (SC-006).
  type Verdict =
    | { state: 'idle' }
    | { state: 'valid'; missingIdentifiers: readonly string[] }
    | { state: 'invalid'; error: string };

  function buildVerdict(src: string, instructionText: string): Verdict {
    if (src.trim() === '') {
      return { state: 'idle' };
    }
    const r: ParseResult = validateExpression(src);
    if (!r.ok) {
      return { state: 'invalid', error: r.error };
    }
    const missing = computeMissingIdentifiers(r.expression, instructionText);
    return { state: 'valid', missingIdentifiers: missing };
  }

  let verdict = $state<Verdict>({ state: 'idle' });

  // Run synchronously on mount before any DOM observation; this both
  // seeds `local` from the prop and computes the initial verdict.
  $effect.pre(() => {
    if (initialized) return;
    initialized = true;
    local = props.source;
    verdict = buildVerdict(props.source, props.instruction);
  });

  const DEBOUNCE_MS = 200;
  let debounceHandle: ReturnType<typeof setTimeout> | null = null;

  function scheduleValidate(): void {
    if (debounceHandle !== null) {
      clearTimeout(debounceHandle);
    }
    debounceHandle = setTimeout(() => {
      debounceHandle = null;
      const next = buildVerdict(local, props.instruction);
      verdict = next;
      if (onchange) {
        if (next.state === 'valid') {
          onchange({
            source: local,
            valid: true,
            missingIdentifiers: next.missingIdentifiers
          });
        } else if (next.state === 'invalid') {
          onchange({
            source: local,
            valid: false,
            error: next.error,
            missingIdentifiers: []
          });
        }
      }
    }, DEBOUNCE_MS);
  }

  function onInput(event: Event): void {
    const t = event.target as HTMLTextAreaElement;
    local = t.value;
    scheduleValidate();
  }

  onDestroy(() => {
    if (debounceHandle !== null) {
      clearTimeout(debounceHandle);
    }
  });

  const missingIdentifiers = $derived(
    verdict.state === 'valid' ? verdict.missingIdentifiers : []
  );
</script>

<div class="retry-condition-editor" data-testid="retry-condition-editor">
  <label class="rc-label" for="retry-condition-input">
    <span class="rc-label-text">Retry Condition</span>
    <span class="rc-label-hint">DSL — see retry-condition-grammar.ebnf</span>
  </label>
  <textarea
    id="retry-condition-input"
    class="rc-input"
    data-testid="retry-condition-input"
    rows="3"
    spellcheck="false"
    value={local}
    oninput={onInput}
    readonly={isReadonly}
    title={isReadonly
      ? 'Custom retry-condition expressions are disabled by workspace policy.'
      : undefined}
    placeholder="open_questions > 0 and tasks_remaining > 0"
  ></textarea>

  <div
    class="rc-status"
    data-testid="retry-condition-status"
    data-state={verdict.state}
  >
    {#if verdict.state === 'valid'}
      <span class="rc-pip rc-pip-ok"></span>
      <span class="rc-status-text">Valid expression</span>
    {:else if verdict.state === 'invalid'}
      <span class="rc-pip rc-pip-err"></span>
      <span class="rc-status-text">Parser error: {verdict.error}</span>
    {/if}
  </div>

  {#if missingIdentifiers.length > 0}
    <div class="rc-warning" data-testid="retry-condition-warning" role="alert">
      <strong>Cross-artifact warning:</strong>
      The following identifier{missingIdentifiers.length === 1 ? '' : 's'} do not appear in
      this phase's instruction —
      <span class="rc-missing">
        {#each missingIdentifiers as id, idx (id)}
          <code>{id}</code>{idx < missingIdentifiers.length - 1 ? ', ' : ''}
        {/each}
      </span>.
      The CLI may never emit them, so the retry condition will never fire.
    </div>
  {/if}
</div>

<style>
  .retry-condition-editor {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .rc-label {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .rc-label-text {
    font-weight: 600;
    font-size: 0.9em;
  }
  .rc-label-hint {
    color: var(--schegent-muted-fg);
    font-size: 0.75em;
  }
  .rc-input {
    background: var(--vscode-input-background);
    color: var(--schegent-fg);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    padding: 6px 8px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    resize: vertical;
  }
  .rc-input:focus {
    outline: none;
    border-color: var(--schegent-focus-border);
  }
  .rc-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
  }
  .rc-status[data-state="valid"] {
    color: var(--vscode-charts-green);
  }
  .rc-status[data-state="invalid"] {
    color: var(--schegent-error-text);
  }
  .rc-pip {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .rc-pip-ok { background: var(--vscode-charts-green); }
  .rc-pip-err { background: var(--schegent-color-error); }
  .rc-warning {
    color: var(--schegent-color-warning);
    background: color-mix(in srgb, var(--schegent-color-warning) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--schegent-color-warning) 30%, transparent);
    border-radius: var(--schegent-radius);
    padding: 8px;
    font-size: 0.85em;
    line-height: 1.4;
  }
  .rc-missing code {
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
  }
</style>
