<script lang="ts">
  // The Models tab: one section per backend, each a table of the catalog's model ids.
  //
  // The add form opens from the section's "Add model" button, one section at a time, and a
  // duplicate id is refused under its input. Every row stays editable and removable: each one is a
  // catalog entry, whether Detect or the operator put it there.
  import { findWebviewBackendDescriptor } from '../../lib/generated/backend-descriptors';
  import { exportModelCatalogYaml } from '../../lib/process-yaml-ipc';

  interface Props {
    /** What each backend's CLI reported when probed — a live fact, not the catalog. */
    availableModels: Record<string, readonly string[]>;
    /** The editable catalog, seeded from `schegent.models`. What Save writes. */
    models: Record<string, string[]>;
    newModelInput: Record<string, string>;
    onnewmodelinput: (backend: string, value: string) => void;
    onmodelchange: (backend: string, index: number, value: string) => void;
    onadd: (backend: string) => void;
    onremove: (backend: string, index: number) => void;
    onsave: () => void;
    ondetect: (backend: string) => void;
  }

  const {
    availableModels,
    models,
    newModelInput,
    onnewmodelinput,
    onmodelchange,
    onadd,
    onremove,
    onsave,
    ondetect
  }: Props = $props();

  /**
   * The prefix of the ids each section's heading, add form and add button carry. A section is named
   * by its position, not its backend: a catalog key is whatever the setting holds, so it need not be
   * id-safe. One Models tab renders at a time, as with the other surfaces' fixed ids.
   */
  const ID_PREFIX = 'model-catalog';

  /**
   * Every backend either list knows about, configured first.
   *
   * This read `availableModels` alone until Claude and Codex started
   * reporting no models — neither CLI can enumerate them — at which point
   * deriving from it collapsed the very sections the operator types into.
   * A backend is shown because it is editable, not because something was
   * detected for it.
   */
  const backends = $derived([
    ...new Set([...Object.keys(models || {}), ...Object.keys(availableModels || {})])
  ]);

  function detectedFor(backend: string): readonly string[] {
    return availableModels?.[backend] ?? [];
  }

  /**
   * The catalog's ids for one backend. `backends` also holds the keys of `availableModels`, which
   * the catalog need not have, so the key is checked before it is read: a backend that was only
   * detected has no entries yet.
   */
  function entriesFor(backend: string): readonly string[] {
    return Object.hasOwn(models, backend) ? models[backend] : [];
  }

  function countLine(count: number): string {
    if (count === 0) return 'no models';
    return count === 1 ? '1 model' : `${count} models`;
  }

  /** Where an id came from: the backend reported it, or the operator typed it. */
  function sourceOf(backend: string, model: string): string {
    return detectedFor(backend).includes(model) ? 'Detected' : 'Added by you';
  }

  /**
   * `disabled` is the browser's gate and this is the component's, on the same
   * reasoning as `onAddSubmit` below: nothing reaches the parent that the
   * control's own state says should not. A synthetic click, or an environment
   * that dispatches past `disabled`, gets the same answer the operator sees.
   */
  function onDetectClick(backend: string): void {
    if (detectedFor(backend).length === 0) return;
    ondetect(backend);
  }

  function detectTitle(backend: string): string {
    const detected = detectedFor(backend);
    return detected.length === 0
      ? `The ${backend} CLI cannot list its models — choose Add model to type an id.`
      : `Add the ${detected.length} model(s) ${backend} reported, skipping any already listed.`;
  }

  /**
   * No resourceId and no disabled state, unlike the per-row Phase/Pipeline/
   * Workflow export control this mirrors: the Model Catalog is a singleton
   * that always resolves to a document, even an empty one (FR-007).
   */
  function onExport(): void {
    exportModelCatalogYaml();
  }

  /**
   * Feature 096 T030, FR-005 — a duplicate add used to silently no-op.
   * `onadd` is the only path from this component to a catalog mutation, so
   * the guard sits ahead of it: a duplicate never reaches the parent's
   * `addModel()` at all, rather than relying on that function's own
   * pre-existing (silent) duplicate check.
   */
  let duplicateMessage = $state<string | null>(null);
  function onAddSubmit(backend: string): void {
    duplicateMessage = null;
    const value = (newModelInput[backend] || '').trim();
    if (value && (models[backend] || []).includes(value)) {
      duplicateMessage = `"${value}" already exists for ${backend}.`;
      return;
    }
    onadd(backend);
  }

  /** The backend whose add form is open. A refusal shown under one form never outlives it. */
  let addingFor = $state<string | null>(null);

  /**
   * However a form closes — Cancel, Escape, its button again, or another section's form opening —
   * what was typed in it is dropped, so a form always reopens empty.
   */
  function dropDraft(): void {
    duplicateMessage = null;
    if (addingFor !== null) onnewmodelinput(addingFor, '');
    addingFor = null;
  }

  function toggleAdd(backend: string): void {
    const wasOpen = addingFor === backend;
    dropDraft();
    if (!wasOpen) addingFor = backend;
  }

  /** Cancel and Escape: the form closes and focus goes back to the button that opened it. */
  function closeAdd(toggleId: string): void {
    dropDraft();
    document.getElementById(toggleId)?.focus();
  }

  function onAddKeydown(event: KeyboardEvent, toggleId: string): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    closeAdd(toggleId);
  }

  /** The add form's input takes focus as the form opens, so typing follows the click. */
  function focusOnMount(node: HTMLInputElement): void {
    node.focus();
  }
</script>

<!-- One root: the Builder's tab panel is a flex column with a gap, which would otherwise come
     between the toolbar and every section. -->
<div class="model-catalog">
  <div class="toolbar">
    <span class="small muted">Models a Phase can choose. Detected models come from each installed backend.</span>
    <div class="push">
      <button type="button" class="btn btn-secondary" aria-label="Export Model Catalog" onclick={onExport}>Export…</button>
      <button type="button" class="btn btn-primary" onclick={onsave}>Save</button>
    </div>
  </div>

  {#if backends.length === 0}
    <div class="empty"><strong>No backends available</strong></div>
  {/if}

  {#each backends as backend, sectionIndex (backend)}
    {@const entries = entriesFor(backend)}
    {@const headingId = `${ID_PREFIX}-backend-${sectionIndex}`}
    {@const formId = `${ID_PREFIX}-add-${sectionIndex}`}
    {@const toggleId = `${ID_PREFIX}-add-toggle-${sectionIndex}`}
    {@const errorId = `${ID_PREFIX}-add-error-${sectionIndex}`}
    <section class="section" aria-labelledby={headingId}>
      <div class="mhead">
        <h2 id={headingId}>{backend}</h2>
        <span class="small muted">{countLine(entries.length)}</span>
        <span class="push mhead-actions">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            aria-label={`Detect ${backend} models`}
            title={detectTitle(backend)}
            disabled={detectedFor(backend).length === 0}
            onclick={() => onDetectClick(backend)}
          ><svg class="i" aria-hidden="true"><use href="#i-refresh"></use></svg>Detect</button>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            id={toggleId}
            aria-expanded={addingFor === backend}
            aria-controls={addingFor === backend ? formId : undefined}
            onclick={() => toggleAdd(backend)}
          ><svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>Add model</button>
        </span>
      </div>

      {#if addingFor === backend}
        <form
          class="model-add"
          id={formId}
          onsubmit={(event) => { event.preventDefault(); onAddSubmit(backend); }}
        >
          <input
            class="input mono"
            aria-label={`New ${backend} model name`}
            aria-invalid={duplicateMessage ? 'true' : undefined}
            aria-describedby={duplicateMessage ? errorId : undefined}
            value={newModelInput[backend] || ''}
            oninput={(event) => onnewmodelinput(backend, event.currentTarget.value)}
            onkeydown={(event) => onAddKeydown(event, toggleId)}
            placeholder={`e.g. ${findWebviewBackendDescriptor(backend)?.exampleModelPlaceholder ?? 'model-name'}`}
            use:focusOnMount
          />
          <button class="btn btn-primary btn-sm" type="submit">Add</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick={() => closeAdd(toggleId)}>Cancel</button>
          {#if duplicateMessage}
            <p class="model-add-error" id={errorId} data-testid="model-duplicate-banner" role="alert">{duplicateMessage}</p>
          {/if}
        </form>
      {/if}

      {#if entries.length === 0}
        <div class="empty">
          <strong>No {backend} models yet</strong>
          {#if detectedFor(backend).length > 0}
            Detect adds the models {backend} reported.
          {:else}
            Choose Add model to type a model id.
          {/if}
        </div>
      {:else}
        <div class="table-wrap">
          <table class="t fit model-table">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" class="col-source">Source</th>
                <th scope="col" class="col-remove"><span class="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              <!-- Keyed by position, which is how the catalog addresses a row (`onmodelchange` and
                   `onremove` take its index). The id is the text being edited: a key on it would
                   rebuild the row, and take the focus out of its input, on every keystroke. -->
              {#each entries as model, index (index)}
                <tr class="model-list-item">
                  <td class="cell-control">
                    <input
                      class="input mono model-id"
                      aria-label={`${backend} model ${index + 1}`}
                      value={model}
                      oninput={(event) => onmodelchange(backend, index, event.currentTarget.value)}
                    />
                  </td>
                  <td>{sourceOf(backend, model)}</td>
                  <td class="cell-control cell-remove">
                    <button
                      type="button"
                      class="icon-btn"
                      aria-label={`Remove ${backend} model ${model}`}
                      onclick={() => onremove(backend, index)}
                    ><svg class="i" aria-hidden="true"><use href="#i-x"></use></svg></button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/each}
</div>

<style>
  /* The section head: the backend's name, its count and its two actions, in the look of a
     section's h2. The h2 holds the name alone, so the region it names reads as the backend. */
  .mhead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--schegent-space-2);
    margin-bottom: var(--schegent-space-2);
  }

  .mhead h2 {
    font-weight: 600;
    text-transform: capitalize;
  }

  .mhead-actions {
    display: flex;
    gap: var(--schegent-space-1-5);
  }

  .model-add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--schegent-space-1-5);
    margin-bottom: var(--schegent-space-2);
  }

  .model-add .input {
    flex: 1 1 240px;
    width: auto;
    max-width: 420px;
  }

  .model-add-error {
    flex-basis: 100%;
    margin: 0;
    color: var(--schegent-error-text);
    font-size: var(--schegent-text-secondary);
  }

  .model-table {
    table-layout: fixed;
  }

  .model-table .col-source {
    width: 25%;
  }

  .model-table .col-remove {
    width: 56px;
  }

  /* A cell holding a control keeps the row as tall as a row of text: the control fills the height
     the text and its padding would. */
  .model-table .cell-control {
    padding-block: 1px;
  }

  /* An id reads as the mockup's plain mono text until it is pointed at or focused; its text lines
     up with the column heading's. */
  .model-table .cell-control:first-child {
    padding-inline-start: calc(var(--schegent-space-3) - var(--schegent-space-2) - 1px);
  }

  .model-table .model-id {
    border-color: transparent;
    background: transparent;
  }

  .model-table .model-id:hover {
    border-color: var(--schegent-input-border);
  }

  /* The table's wrapper scrolls, so it clips: a ring drawn outside a control in the first or last
     row would lose its edge. Inside the control it shows whole. */
  .model-table .cell-control > :focus-visible {
    outline-offset: -2px;
  }

  .model-table .cell-remove {
    text-align: right;
  }
</style>
