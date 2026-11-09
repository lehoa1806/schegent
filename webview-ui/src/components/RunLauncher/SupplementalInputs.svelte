<script lang="ts">
  // Feature 087 T053 (FR-003) & FR-R5-F36 (F36-T03) — everything the operator adds
  // that the Pipeline or Workflow did not declare.
  //
  // By default (`omitInstruction = false`, `collapsible = false`), all fields render
  // in an open section for `RunLauncher.svelte` and `WorkflowContinuation.svelte`.
  // When `WorkflowTriggerForm.svelte` promotes Instructions to its primary field, it
  // passes `omitInstruction={true}` and `collapsible={true}` so the remaining
  // attachment controls stay tucked inside a disclosure that auto-opens whenever any
  // visible attachment has a non-empty value or a host field error.

  interface SupplementalField {
    readonly key: string;
    readonly label: string;
    readonly hint: string;
  }

  /** Declaration order. The composer emits in this order, so an indexed host
   * refusal maps back to the control that produced it. */
  const FIELDS: readonly SupplementalField[] = [
    { key: 'local-file', label: 'Local file', hint: 'Workspace-relative path to a file.' },
    { key: 'local-folder', label: 'Local folder', hint: 'Workspace-relative path to a folder.' },
    { key: 'url', label: 'URL', hint: 'An http or https address.' },
    { key: 'text', label: 'Pasted text', hint: 'Material to include verbatim.' },
    { key: 'instruction', label: 'Instructions', hint: 'Free-form direction for this run.' },
    { key: 'prior-run', label: 'Prior run', hint: 'The run that produced the output.' },
    { key: 'prior-output', label: 'Prior output name', hint: 'The named output to reference.' }
  ];

  const MULTILINE_KEYS: ReadonlySet<string> = new Set(['text', 'instruction']);

  interface Props {
    readonly values: Record<string, string>;
    /** Host refusals, already remapped from their positional field id to the
     * control that produced the entry. */
    readonly errors: ReadonlyMap<string, string>;
    readonly disabled: boolean;
    readonly onChange: (key: string, value: string) => void;
    readonly omitInstruction?: boolean;
    readonly collapsible?: boolean;
  }

  const {
    values,
    errors,
    disabled,
    onChange,
    omitInstruction = false,
    collapsible = false
  }: Props = $props();

  const visibleFields = $derived(
    omitInstruction ? FIELDS.filter((field) => field.key !== 'instruction') : FIELDS
  );

  const shouldAutoOpen = $derived(
    visibleFields.some(
      (field) => (values[field.key] ?? '').trim().length > 0 || errors.has(field.key)
    )
  );
</script>

{#snippet fieldRows()}
  {#each visibleFields as field (field.key)}
    <div class="supplemental-row">
      <label class="supplemental-label" for={`run-supplemental-${field.key}`}>{field.label}</label>
      <span class="supplemental-hint">{field.hint}</span>
      {#if MULTILINE_KEYS.has(field.key)}
        <textarea
          id={`run-supplemental-${field.key}`}
          data-testid={`run-supplemental-${field.key}`}
          class="supplemental-input"
          rows="3"
          {disabled}
          value={values[field.key] ?? ''}
          oninput={(event) => onChange(field.key, event.currentTarget.value)}
        ></textarea>
      {:else}
        <input
          id={`run-supplemental-${field.key}`}
          data-testid={`run-supplemental-${field.key}`}
          class="supplemental-input"
          type="text"
          {disabled}
          value={values[field.key] ?? ''}
          oninput={(event) => onChange(field.key, event.currentTarget.value)}
        />
      {/if}
      {#if errors.has(field.key)}
        <p class="field-error" data-testid={`run-launcher-error-supplemental-${field.key}`}>
          {errors.get(field.key)}
        </p>
      {/if}
    </div>
  {/each}
{/snippet}

{#if collapsible}
  <details
    class="supplemental-section supplemental-disclosure"
    data-testid="run-launcher-supplemental"
    open={shouldAutoOpen}
  >
    <summary class="section-heading disclosure-summary">Attachments &amp; references (optional)</summary>
    <div class="disclosure-body">
      <p class="section-note">Optional material for this session. Not part of the Workflow's contract.</p>
      {@render fieldRows()}
    </div>
  </details>
{:else}
  <section class="supplemental-section" data-testid="run-launcher-supplemental">
    <h4 class="section-heading">Supplemental inputs</h4>
    <p class="section-note">Optional material for this session. Not part of the Workflow's contract.</p>
    {@render fieldRows()}
  </section>
{/if}

<style>
  .supplemental-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .supplemental-disclosure {
    margin: 0;
  }
  .disclosure-summary {
    cursor: pointer;
    user-select: none;
  }
  .disclosure-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
  }
  .section-heading {
    margin: 0;
    font-size: 0.95em;
  }
  .section-note {
    margin: 0;
    font-size: 0.85em;
    opacity: 0.8;
  }
  .supplemental-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .supplemental-label {
    font-weight: 600;
    font-size: 0.9em;
  }
  .supplemental-hint {
    font-size: 0.8em;
    opacity: 0.8;
  }
  .supplemental-input {
    padding: 4px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: var(--schegent-radius);
    font-family: inherit;
  }
  .field-error {
    margin: 0;
    font-size: 0.85em;
    color: var(--schegent-error-text);
  }
</style>
