<script lang="ts">
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
      ? `The ${backend} CLI cannot list its models — type an id above to add one.`
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
</script>

<div class="models-container">
  <div class="toolbar" style="margin-bottom: 24px;">
    <div style="flex: 1;"></div>
    <button type="button" class="btn btn-secondary" onclick={onExport}>Export Model Catalog</button>
    <button type="button" class="btn btn-primary" onclick={onsave}>Save All Models</button>
  </div>

  {#if duplicateMessage}
    <div class="save-error-banner" data-testid="model-duplicate-banner" role="alert">
      <span class="save-error-icon">⚠</span>
      <span class="save-error-text">{duplicateMessage}</span>
      <button
        class="save-error-dismiss"
        aria-label="Dismiss duplicate model message"
        onclick={() => (duplicateMessage = null)}
      >✕</button>
    </div>
  {/if}

  {#if backends.length === 0}
    <div class="empty-selection">No backends available.</div>
  {/if}
  
  {#each backends as backend}
    <div class="backend-section" style="margin-bottom: 32px; padding: 16px; background: var(--sch-glass-bg); border: 1px solid var(--sch-glass-border); border-radius: var(--schegent-radius);">
      <h3 style="margin-bottom: 16px; text-transform: capitalize;">{backend} Models</h3>
      
      <div class="toolbar" style="margin-bottom: 16px;">
        <form class="model-form" onsubmit={(event) => { event.preventDefault(); onAddSubmit(backend); }}>
          <input
            class="text-input flex-1"
            aria-label={`New ${backend} model name`}
            value={newModelInput[backend] || ''}
            oninput={(event) => onnewmodelinput(backend, event.currentTarget.value)}
            placeholder={`e.g. ${backend === 'claude' ? 'claude-3-7-sonnet-20250219' : 'model-name'}`}
          />
          <button class="btn btn-secondary" type="submit">Add Model</button>
        </form>
        <button
          type="button"
          class="btn btn-secondary"
          style="margin-left: 12px;"
          aria-label={`Detect ${backend} models`}
          title={detectTitle(backend)}
          disabled={detectedFor(backend).length === 0}
          onclick={() => onDetectClick(backend)}
        >Detect</button>
      </div>
      <div class="models-list">
        {#if !models[backend] || models[backend].length === 0}
          <div class="empty-selection">No custom models defined for {backend}.</div>
        {/if}
        {#each (models[backend] || []) as model, index (model + '-' + index)}
          <div class="model-list-item">
            <input
              class="text-input flex-1"
              aria-label={`${backend} model ${index + 1}`}
              value={model}
              oninput={(event) => onmodelchange(backend, index, event.currentTarget.value)}
            />
            <button
              type="button"
              class="btn btn-destructive"
              style="margin-left: 12px;"
              aria-label={`Remove ${backend} model ${model}`}
              onclick={() => onremove(backend, index)}
            >Remove</button>
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>
