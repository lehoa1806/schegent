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

<!-- Drawn as the redesign's form fields, as the contract's are: the name above the box, its hint in
     a caption under it, which the box names as its description. Folded, the section is the
     redesign's disclosure (`details.diag` in `sg-pages.css`): a rule above, a muted summary. -->
{#snippet fieldRows()}
  {#each visibleFields as field (field.key)}
    <div class="supplemental-row">
      <label class="supplemental-label" for={`run-supplemental-${field.key}`}>{field.label}</label>
      {#if MULTILINE_KEYS.has(field.key)}
        <textarea
          id={`run-supplemental-${field.key}`}
          data-testid={`run-supplemental-${field.key}`}
          class="input"
          rows="3"
          aria-describedby={`run-supplemental-hint-${field.key}`}
          {disabled}
          value={values[field.key] ?? ''}
          oninput={(event) => onChange(field.key, event.currentTarget.value)}
        ></textarea>
      {:else}
        <input
          id={`run-supplemental-${field.key}`}
          data-testid={`run-supplemental-${field.key}`}
          class="input"
          type="text"
          aria-describedby={`run-supplemental-hint-${field.key}`}
          {disabled}
          value={values[field.key] ?? ''}
          oninput={(event) => onChange(field.key, event.currentTarget.value)}
        />
      {/if}
      <p class="hint supplemental-hint" id={`run-supplemental-hint-${field.key}`}>{field.hint}</p>
      {#if errors.has(field.key)}
        <p class="field-error" data-testid={`run-launcher-error-supplemental-${field.key}`}>
          {errors.get(field.key)}
        </p>
      {/if}
    </div>
  {/each}
{/snippet}

{#if collapsible}
  <details class="diag" data-testid="run-launcher-supplemental" open={shouldAutoOpen}>
    <summary>Attachments &amp; references (optional)</summary>
    <div class="disclosure-body">
      <p class="small muted note">Optional material for this session. Not part of the Workflow's contract.</p>
      {@render fieldRows()}
    </div>
  </details>
{:else}
  <section data-testid="run-launcher-supplemental">
    <h4 class="section-heading">Supplemental inputs</h4>
    <p class="hint note">Optional material for this session. Not part of the Workflow's contract.</p>
    {@render fieldRows()}
  </section>
{/if}

<style>
  .section-heading {
    font-size: var(--schegent-text-secondary);
    font-weight: 600;
  }
  .note,
  .supplemental-hint,
  .field-error {
    margin: 0;
  }
  .section-heading + .note {
    margin-top: var(--schegent-space-1);
  }
  .diag > summary {
    user-select: none;
  }
  .disclosure-body {
    margin-top: var(--schegent-space-2);
  }
  .supplemental-row {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-1);
    margin-top: var(--schegent-space-3);
  }
  .supplemental-label {
    font-size: var(--schegent-text-secondary);
    color: var(--schegent-muted-fg);
  }
  textarea.input {
    resize: vertical;
  }
  .field-error {
    font-size: var(--schegent-text-caption);
    color: var(--schegent-error-text);
  }
</style>
