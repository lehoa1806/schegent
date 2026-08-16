<script lang="ts">
  import { exportModelCatalogYaml } from '../../lib/process-yaml-ipc';

  interface Props {
    availableModels: Record<string, readonly string[]>;
    models: Record<string, string[]>;
    newModelInput: Record<string, string>;
    onnewmodelinput: (backend: string, value: string) => void;
    onmodelchange: (backend: string, index: number, value: string) => void;
    onadd: (backend: string) => void;
    onremove: (backend: string, index: number) => void;
    onsave: () => void;
  }

  const {
    availableModels,
    models,
    newModelInput,
    onnewmodelinput,
    onmodelchange,
    onadd,
    onremove,
    onsave
  }: Props = $props();

  const backends = $derived(Object.keys(availableModels || {}));

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
