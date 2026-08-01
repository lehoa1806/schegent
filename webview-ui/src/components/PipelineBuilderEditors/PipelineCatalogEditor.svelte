<script lang="ts">
  import TrustBanner from '../TrustBanner.svelte';
  import type { MutablePhase, MutablePipeline } from './types';

  interface Props {
    pipelines: MutablePipeline[];
    phases: MutablePhase[];
    selectedIndex: number | null;
    historyIndex: number;
    historyLength: number;
    newPhaseId: string;
    trusted: boolean;
    showTrustBanner: boolean;
    saveError: string | null;
    getPhaseTooltip: (phaseId: string) => string;
    onselect: (index: number | null) => void;
    onadd: () => void;
    onremove: (index: number) => void;
    onreset: (index: number) => void;
    onpipelinechange: (
      index: number,
      patch: Partial<Pick<MutablePipeline, 'id' | 'name'>>
    ) => void;
    onphasechange: (pipelineIndex: number, phaseIndex: number, phaseId: string) => void;
    onundo: () => void;
    onredo: () => void;
    onsave: () => void;
    ondismisssaveerror: () => void;
    onnewphaseidchange: (value: string) => void;
    onaddphase: () => void;
    onremovephase: (index: number) => void;
    onmovephaseup: (index: number) => void;
    onmovephasedown: (index: number) => void;
  }

  const {
    pipelines,
    phases,
    selectedIndex,
    historyIndex,
    historyLength,
    newPhaseId,
    trusted,
    showTrustBanner,
    saveError,
    getPhaseTooltip,
    onselect,
    onadd,
    onremove,
    onreset,
    onpipelinechange,
    onphasechange,
    onundo,
    onredo,
    onsave,
    ondismisssaveerror,
    onnewphaseidchange,
    onaddphase,
    onremovephase,
    onmovephaseup,
    onmovephasedown
  }: Props = $props();
</script>

{#if showTrustBanner}
  <TrustBanner variant="pipelines" />
{/if}
<div class="toolbar">
  <button class="btn btn-primary" onclick={onadd} disabled={!trusted}>Add Pipeline</button>
  <button class="btn" disabled={historyIndex <= 0} onclick={onundo}>Undo</button>
  <button class="btn" disabled={historyIndex >= historyLength - 1} onclick={onredo}>Redo</button>
  <button class="btn btn-secondary" style="margin-left:auto" onclick={onsave} disabled={!trusted}>Save Pipelines</button>
</div>
{#if saveError}
  <div class="save-error-banner" data-testid="save-error-banner" role="alert">
    <span class="save-error-icon">⚠</span>
    <span class="save-error-text">Save rejected: {saveError}</span>
    <button class="save-error-dismiss" onclick={ondismisssaveerror}>✕</button>
  </div>
{/if}
<div class="split-pane">
  <div class="pane-left">
    <div class="phase-list">
      {#each pipelines as pipeline, i (pipeline.id + '-' + i)}
        <button class="phase-list-item {selectedIndex === i ? 'selected' : ''}" onclick={() => onselect(i)}>
          <div class="phase-list-title">{pipeline.name || 'Untitled Pipeline'}</div>
          <div class="phase-list-id">{pipeline.id}</div>
        </button>
      {/each}
    </div>
  </div>
  <div class="pane-right">
    {#if selectedIndex !== null && pipelines[selectedIndex]}
      {@const pipeline = pipelines[selectedIndex]}
      <div class="editor-card full-height">
        <div class="card-header-complex">
          <input class="title-input" value={pipeline.name} oninput={(event) => onpipelinechange(selectedIndex, { name: event.currentTarget.value })} placeholder="Pipeline Name" />
          <div class="header-actions">
            <button class="btn btn-ghost" onclick={() => onselect(null)}>Cancel</button>
            <button class="btn btn-ghost" onclick={() => onreset(selectedIndex)}>Reset to default</button>
            <button class="btn btn-secondary" onclick={onsave}>Save Pipeline</button>
            <button class="btn btn-destructive" onclick={() => onremove(selectedIndex)}>Delete Pipeline</button>
          </div>
        </div>
        <div class="card-body">
          <div class="form-grid" style="grid-template-columns: 1fr 1fr; margin-bottom: 8px;">
            <label class="form-field">
              <span class="form-label">Name</span>
              <input class="text-input" data-testid="pipelines-name-field-{pipeline.id}" value={pipeline.name} oninput={(event) => onpipelinechange(selectedIndex, { name: event.currentTarget.value })} placeholder="Pipeline display name" />
            </label>
            <label class="form-field">
              <span class="form-label">ID</span>
              <input class="text-input" value={pipeline.id} oninput={(event) => onpipelinechange(selectedIndex, { id: event.currentTarget.value })} placeholder="pipeline-id" />
            </label>
          </div>
          <div class="phases-sequence-editor">
            <div class="sequence-label">Phases Sequence:</div>
            <div class="sequence-list">
              {#if pipeline.phases.length === 0}
                <div class="empty-selection">No phases in this pipeline. Add one below.</div>
              {/if}
              {#each pipeline.phases as phaseId, phaseIndex}
                <div class="sequence-item">
                  <div class="custom-tooltip">{getPhaseTooltip(phaseId)}</div>
                  <div class="sequence-number">{phaseIndex + 1}</div>
                  <select class="select-input sequence-select" value={pipeline.phases[phaseIndex]} onchange={(event) => onphasechange(selectedIndex, phaseIndex, event.currentTarget.value)}>
                    {#each phases as availablePhase}
                      <option value={availablePhase.id}>{availablePhase.name} ({availablePhase.id})</option>
                    {/each}
                    {#if !phases.find((phase) => phase.id === phaseId)}
                      <option value={phaseId}>{phaseId} (Unknown)</option>
                    {/if}
                  </select>
                  <div class="sequence-actions">
                    <button class="icon-btn" disabled={phaseIndex === 0} onclick={() => onmovephaseup(phaseIndex)}>↑</button>
                    <button class="icon-btn" disabled={phaseIndex === pipeline.phases.length - 1} onclick={() => onmovephasedown(phaseIndex)}>↓</button>
                    <button class="icon-btn destructive-icon" onclick={() => onremovephase(phaseIndex)}>✕</button>
                  </div>
                </div>
              {/each}
            </div>
            <div class="add-phase-row">
              <select class="select-input flex-1" value={newPhaseId} onchange={(event) => onnewphaseidchange(event.currentTarget.value)}>
                <option value="">-- Select a phase to add --</option>
                {#each phases as availablePhase}
                  <option value={availablePhase.id}>{availablePhase.name} ({availablePhase.id})</option>
                {/each}
              </select>
              <button class="btn btn-primary" disabled={!newPhaseId} onclick={onaddphase}>Add Phase</button>
            </div>
          </div>
        </div>
      </div>
    {:else}
      <div class="empty-selection">Select a pipeline to edit or add a new one.</div>
    {/if}
  </div>
</div>
