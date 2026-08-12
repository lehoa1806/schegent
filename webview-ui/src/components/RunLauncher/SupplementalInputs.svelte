<script lang="ts">
  // Feature 087 T053 (FR-003) — everything the operator adds that the Pipeline
  // did not declare.
  //
  // It is a section of its own, and that separation is the requirement rather
  // than a layout preference: the contract section is a faithful projection of
  // the declared ports, so anything mixed into it would read as part of the
  // contract. Here the operator can attach material this session needs — a file,
  // a folder, a URL, pasted text, an instruction, or a named output of a previous
  // run — without any of it pretending to be a declared input.
  //
  // The free-form instruction is one control, and the composer routes it to the
  // request's own `instructions` field: that is the field the host bounds at the
  // existing description limit and the one the queue row is labelled from. A
  // second instruction surface inside the supplemental list would be an
  // instruction the length rule cannot see.
  //
  // The prior-output reference is two fields because it is structured data — a
  // run and a named output, compared field-wise — not a string with a separator
  // that would need a grammar to take apart.

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
  }

  const { values, errors, disabled, onChange }: Props = $props();
</script>

<section class="supplemental-section" data-testid="run-launcher-supplemental">
  <h4 class="section-heading">Supplemental inputs</h4>
  <p class="section-note">Optional material for this session. Not part of the Pipeline's contract.</p>

  {#each FIELDS as field (field.key)}
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
</section>

<style>
  .supplemental-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
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
