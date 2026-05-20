<script lang="ts">
  import type {
    WorkflowSnapshot,
    PipelineDefinition,
    PhaseDefinition
  } from '../lib/snapshot-types';
  import { savePhases as savePhasesHelper, type SavePhaseRow } from '../lib/save-phases';
  import {
    savePipelines as savePipelinesHelper,
    type SavePipelineRow
  } from '../lib/save-pipelines';
  import { saveModels as saveModelsHelper } from '../lib/save-models';
  import RetryConditionEditor from './settings/RetryConditionEditor.svelte';
  import RawJsonPhaseEditor from './settings/RawJsonPhaseEditor.svelte';
  import TrustBanner from './TrustBanner.svelte';

  const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

  interface Props {
    snapshot: WorkflowSnapshot;
    // Feature 059 — test seam: lets the component test render the
    // Phases tab without simulating a click. Production wiring omits
    // this prop and the component opens on the Pipelines tab as
    // before.
    initialTab?: 'pipelines' | 'phases' | 'models';
  }
  const { snapshot, initialTab }: Props = $props();

  // Feature 059 — trust projection. Fail closed when the host bundle is
  // older and does not include these fields.
  const workspaceTrust = $derived(snapshot.workspaceTrust === true);
  const trustPhases = $derived(
    workspaceTrust && snapshot.resolvedTrust?.phases === true
  );
  const trustRetryConditions = $derived(
    workspaceTrust && snapshot.resolvedTrust?.retryConditions === true
  );
  const trustPipelineOverrides = $derived(
    workspaceTrust && snapshot.resolvedTrust?.pipelineOverrides === true
  );
  const showWorkspaceTrustBanner = $derived(snapshot.workspaceTrust === false);
  const showPhasesBanner = $derived(!showWorkspaceTrustBanner && !trustPhases);
  const showRetryConditionsBanner = $derived(
    !showWorkspaceTrustBanner && !trustRetryConditions
  );
  const showPipelinesBanner = $derived(
    !showWorkspaceTrustBanner && !trustPipelineOverrides
  );

  const PRESEEDED_MODELS = [
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-haiku-4-5'
  ];

  // `initialTab` is a mount-only test seam; production never updates it.
  // svelte-ignore state_referenced_locally
  let activeTab = $state<'pipelines' | 'phases' | 'models'>(initialTab ?? 'pipelines');

  type MutablePipeline = Omit<PipelineDefinition, 'phases'> & { phases: string[] };
  type MutablePhase = {
    id: string; name: string; instruction: string; loopable: boolean;
    model?: string; effort?: PhaseDefinition['effort'];
    timeoutSeconds?: number; retryCondition?: string;
    [k: string]: unknown;
  };

  let pipelines = $state<MutablePipeline[]>([]);
  let phases = $state<MutablePhase[]>([]);
  let models = $state<string[]>([]);
  let initialized = $state(false);
  let saveError = $state<string | null>(null);
  let saveErrorTimer: ReturnType<typeof setTimeout> | null = null;

  function showSaveError(reason: string): void {
    saveError = reason;
    if (saveErrorTimer !== null) clearTimeout(saveErrorTimer);
    saveErrorTimer = setTimeout(() => { saveError = null; }, 8000);
  }

  $effect(() => {
    if (!initialized && snapshot.availablePipelines && snapshot.availablePhases && snapshot.availableModels) {
      pipelines = JSON.parse(JSON.stringify(snapshot.availablePipelines));
      phases = JSON.parse(JSON.stringify(snapshot.availablePhases));
      const loaded = JSON.parse(JSON.stringify(snapshot.availableModels));
      models = loaded.length > 0 ? loaded : [...PRESEEDED_MODELS];
      initialized = true;
    }
  });

  function savePipelines(): void {
    const payload: SavePipelineRow[] = pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      phases: [...p.phases]
    }));
    void savePipelinesHelper(payload).then((result) => {
      if (result.status === 'rejected') showSaveError(result.reason);
      else saveError = null;
    });
  }
  function savePhases(): void {
    const payload: SavePhaseRow[] = phases.map((p) => {
      const row: {
        id: string;
        name: string;
        instruction: string;
        loopable: boolean;
        model?: string;
        effort?: PhaseDefinition['effort'];
        timeoutSeconds?: number;
        retryCondition?: string;
      } = {
        id: p.id,
        name: p.name,
        instruction: p.instruction,
        loopable: p.loopable
      };
      if (typeof p.model === 'string' && p.model.length > 0) row.model = p.model;
      if (typeof p.effort === 'string' && p.effort.length > 0) row.effort = p.effort;
      if (typeof p.timeoutSeconds === 'number') row.timeoutSeconds = p.timeoutSeconds;
      if (typeof p.retryCondition === 'string') row.retryCondition = p.retryCondition;
      return row;
    });
    void savePhasesHelper(payload).then((result) => {
      if (result.status === 'rejected') showSaveError(result.reason);
      else saveError = null;
    });
  }
  function saveModels(): void {
    void saveModelsHelper([...models]);
  }



  function getPhaseTooltip(phaseId: string): string {
    const phase = snapshot.availablePhases?.find(p => p.id === phaseId) || phases.find(p => p.id === phaseId);
    if (!phase) return `Unknown phase: ${phaseId}`;
    return `ID: ${phase.id}\nName: ${phase.name}\nModel: ${phase.model || 'Default Backend Model'}\nInstruction: ${phase.instruction.slice(0, 100)}${phase.instruction.length > 100 ? '...' : ''}`;
  }

  // --- Pipelines ---
  let selectedPipelineIndex = $state<number | null>(null);
  let pipelineHistory = $state<MutablePipeline[][]>([]);
  let pipelineHistoryIndex = $state(-1);
  let isPipelineUndoRedoAction = false;

  $effect(() => {
    if (!initialized) return;
    const currentStr = JSON.stringify(pipelines);
    if (!isPipelineUndoRedoAction) {
      const lastStateStr = pipelineHistoryIndex >= 0 ? JSON.stringify(pipelineHistory[pipelineHistoryIndex]) : null;
      if (currentStr !== lastStateStr) {
        pipelineHistory = pipelineHistory.slice(0, pipelineHistoryIndex + 1);
        pipelineHistory.push(JSON.parse(currentStr));
        pipelineHistoryIndex++;
      }
    }
    isPipelineUndoRedoAction = false;
  });

  function undoPipeline(): void {
    if (pipelineHistoryIndex > 0) { isPipelineUndoRedoAction = true; pipelineHistoryIndex--; pipelines = JSON.parse(JSON.stringify(pipelineHistory[pipelineHistoryIndex])); }
  }
  function redoPipeline(): void {
    if (pipelineHistoryIndex < pipelineHistory.length - 1) { isPipelineUndoRedoAction = true; pipelineHistoryIndex++; pipelines = JSON.parse(JSON.stringify(pipelineHistory[pipelineHistoryIndex])); }
  }
  function addPipeline(): void { pipelines = [...pipelines, { id: 'new-pipeline', name: 'New Pipeline', phases: [] }]; selectedPipelineIndex = pipelines.length - 1; }
  function removePipeline(index: number): void {
    pipelines = pipelines.filter((_, i) => i !== index);
    if (selectedPipelineIndex === index) selectedPipelineIndex = null;
    else if (selectedPipelineIndex !== null && selectedPipelineIndex > index) selectedPipelineIndex--;
  }
  function resetPipeline(index: number): void {
    const original = snapshot.availablePipelines?.find(p => p.id === pipelines[index].id);
    if (original) pipelines[index] = JSON.parse(JSON.stringify(original));
  }

  let newPhaseIdForPipeline = $state('');
  function addPhaseToPipeline(): void {
    if (selectedPipelineIndex !== null && newPhaseIdForPipeline.trim()) {
      pipelines[selectedPipelineIndex].phases.push(newPhaseIdForPipeline.trim());
      newPhaseIdForPipeline = '';
    }
  }
  function removePhaseFromPipeline(phaseIndex: number): void { if (selectedPipelineIndex !== null) pipelines[selectedPipelineIndex].phases.splice(phaseIndex, 1); }
  function movePhaseUp(phaseIndex: number): void {
    if (selectedPipelineIndex !== null && phaseIndex > 0) {
      const t = pipelines[selectedPipelineIndex].phases[phaseIndex - 1];
      pipelines[selectedPipelineIndex].phases[phaseIndex - 1] = pipelines[selectedPipelineIndex].phases[phaseIndex];
      pipelines[selectedPipelineIndex].phases[phaseIndex] = t;
    }
  }
  function movePhaseDown(phaseIndex: number): void {
    if (selectedPipelineIndex !== null && phaseIndex < pipelines[selectedPipelineIndex].phases.length - 1) {
      const t = pipelines[selectedPipelineIndex].phases[phaseIndex + 1];
      pipelines[selectedPipelineIndex].phases[phaseIndex + 1] = pipelines[selectedPipelineIndex].phases[phaseIndex];
      pipelines[selectedPipelineIndex].phases[phaseIndex] = t;
    }
  }

  // --- Phases ---
  let selectedPhaseIndex = $state<number | null>(null);
  let phaseHistory = $state<MutablePhase[][]>([]);
  let phaseHistoryIndex = $state(-1);
  let isPhaseUndoRedoAction = false;

  type EditState = { rawJsonMode: boolean };
  let editStateById = $state<Record<string, EditState>>({});
  function ensureEditState(id: string): EditState {
    if (!editStateById[id]) editStateById = { ...editStateById, [id]: { rawJsonMode: false } };
    return editStateById[id];
  }
  function toggleRawJson(id: string): void {
    const cur = ensureEditState(id);
    editStateById = { ...editStateById, [id]: { rawJsonMode: !cur.rawJsonMode } };
  }

  $effect(() => {
    if (!initialized) return;
    const currentStr = JSON.stringify(phases);
    if (!isPhaseUndoRedoAction) {
      const lastStateStr = phaseHistoryIndex >= 0 ? JSON.stringify(phaseHistory[phaseHistoryIndex]) : null;
      if (currentStr !== lastStateStr) {
        phaseHistory = phaseHistory.slice(0, phaseHistoryIndex + 1);
        phaseHistory.push(JSON.parse(currentStr));
        phaseHistoryIndex++;
      }
    }
    isPhaseUndoRedoAction = false;
  });

  function undoPhase(): void {
    if (phaseHistoryIndex > 0) { isPhaseUndoRedoAction = true; phaseHistoryIndex--; phases = JSON.parse(JSON.stringify(phaseHistory[phaseHistoryIndex])); }
  }
  function redoPhase(): void {
    if (phaseHistoryIndex < phaseHistory.length - 1) { isPhaseUndoRedoAction = true; phaseHistoryIndex++; phases = JSON.parse(JSON.stringify(phaseHistory[phaseHistoryIndex])); }
  }
  function addPhase(): void {
    phases = [...phases, { id: 'new-phase', name: 'New Phase', instruction: 'Describe the phase objective here.', loopable: false } as MutablePhase];
    selectedPhaseIndex = phases.length - 1;
  }
  function removePhase(index: number): void {
    const id = phases[index]?.id;
    phases = phases.filter((_, i) => i !== index);
    if (selectedPhaseIndex === index) selectedPhaseIndex = null;
    else if (selectedPhaseIndex !== null && selectedPhaseIndex > index) selectedPhaseIndex--;
    if (id) { const next = { ...editStateById }; delete next[id]; editStateById = next; }
  }
  function resetPhase(index: number): void {
    const original = snapshot.availablePhases?.find(p => p.id === phases[index].id);
    if (original) phases[index] = JSON.parse(JSON.stringify(original));
  }
  function onRawJsonSave(index: number, parsed: Record<string, unknown>): void {
    phases = phases.map((p, i) => (i === index ? { ...p, ...parsed } as MutablePhase : p));
  }
  function onRetryConditionChange(index: number, e: { source: string; valid: boolean }): void {
    phases = phases.map((p, i) => i === index ? ({ ...p, retryCondition: e.source } as MutablePhase) : p);
  }

  function isRetryEnabled(phase: MutablePhase): boolean {
    return typeof phase.retryCondition === 'string';
  }

  function toggleRetryCondition(index: number): void {
    const phase = phases[index];
    if (isRetryEnabled(phase)) {
      // Disable: clear retryCondition
      phases = phases.map((p, i) => i === index ? ({ ...p, retryCondition: undefined } as MutablePhase) : p);
    } else {
      // Enable: seed with empty string so editor appears; user must fill it in
      phases = phases.map((p, i) => i === index ? ({ ...p, retryCondition: '' } as MutablePhase) : p);
    }
  }

  const selectedPhase = $derived(selectedPhaseIndex !== null ? phases[selectedPhaseIndex] : null);
  const selectedEditState = $derived(selectedPhase ? editStateById[selectedPhase.id] ?? { rawJsonMode: false } : null);

  // --- Models ---
  let newModelInput = $state('');
  function addModel(): void {
    if (newModelInput.trim() && !models.includes(newModelInput.trim())) {
      models = [...models, newModelInput.trim()];
      newModelInput = '';
    }
  }
  function removeModel(index: number): void { models = models.filter((_, i) => i !== index); }
</script>

<div class="pipeline-builder" data-testid="pipeline-builder-root">
  <div class="header">
    <h2>Builder</h2>
    <p>Configure custom phases, pipelines, and models.</p>
    <div class="builder-tabs">
      <button class="tab-btn {activeTab === 'pipelines' ? 'active' : ''}" onclick={() => activeTab = 'pipelines'}>Pipelines</button>
      <button class="tab-btn {activeTab === 'phases' ? 'active' : ''}" onclick={() => activeTab = 'phases'}>Phases</button>
      <button class="tab-btn {activeTab === 'models' ? 'active' : ''}" onclick={() => activeTab = 'models'}>Models</button>
    </div>
  </div>

  <div class="builder-canvas">
    {#if showWorkspaceTrustBanner}
      <TrustBanner variant="workspace-trust" />
    {/if}
    {#if activeTab === 'pipelines'}
      {#if showPipelinesBanner}
        <TrustBanner variant="pipelines" />
      {/if}
      <div class="toolbar">
        <button class="btn btn-primary" onclick={addPipeline} disabled={!trustPipelineOverrides}>Add Pipeline</button>
        <button class="btn" disabled={pipelineHistoryIndex <= 0} onclick={undoPipeline}>Undo</button>
        <button class="btn" disabled={pipelineHistoryIndex >= pipelineHistory.length - 1} onclick={redoPipeline}>Redo</button>
        <button class="btn btn-secondary" style="margin-left:auto" onclick={savePipelines} disabled={!trustPipelineOverrides}>Save Pipelines</button>
      </div>
      {#if saveError}
        <div class="save-error-banner" data-testid="save-error-banner" role="alert">
          <span class="save-error-icon">⚠</span>
          <span class="save-error-text">Save rejected: {saveError}</span>
          <button class="save-error-dismiss" onclick={() => saveError = null}>✕</button>
        </div>
      {/if}
      <div class="split-pane">
        <div class="pane-left">
          <div class="phase-list">
            {#each pipelines as pipeline, i (pipeline.id + '-' + i)}
              <button class="phase-list-item {selectedPipelineIndex === i ? 'selected' : ''}" onclick={() => selectedPipelineIndex = i}>
                <div class="phase-list-title">{pipeline.name || 'Untitled Pipeline'}</div>
                <div class="phase-list-id">{pipeline.id}</div>
              </button>
            {/each}
          </div>
        </div>
        <div class="pane-right">
          {#if selectedPipelineIndex !== null && pipelines[selectedPipelineIndex]}
            {@const pipeline = pipelines[selectedPipelineIndex]}
            <div class="editor-card full-height">
              <div class="card-header-complex">
                <input class="title-input" bind:value={pipeline.name} placeholder="Pipeline Name" />
                <div class="header-actions">
                  <button class="btn btn-ghost" onclick={() => selectedPipelineIndex = null}>Cancel</button>
                  <button class="btn btn-ghost" onclick={() => resetPipeline(selectedPipelineIndex!)}>Reset to default</button>
                  <button class="btn btn-secondary" onclick={savePipelines}>Save Pipeline</button>
                  <button class="btn btn-destructive" onclick={() => removePipeline(selectedPipelineIndex!)}>Delete Pipeline</button>
                </div>
              </div>
              <div class="card-body">
                <div class="form-grid" style="grid-template-columns: 1fr 1fr; margin-bottom: 8px;">
                  <label class="form-field">
                    <span class="form-label">Name</span>
                    <input class="text-input" data-testid="pipelines-name-field-{pipeline.id}" bind:value={pipelines[selectedPipelineIndex].name} placeholder="Pipeline display name" />
                  </label>
                  <label class="form-field">
                    <span class="form-label">ID</span>
                    <input class="text-input" bind:value={pipelines[selectedPipelineIndex].id} placeholder="pipeline-id" />
                  </label>
                </div>
                <div class="phases-sequence-editor">
                  <div class="sequence-label">Phases Sequence:</div>
                  <div class="sequence-list">
                    {#if pipeline.phases.length === 0}
                      <div class="empty-selection">No phases in this pipeline. Add one below.</div>
                    {/if}
                    {#each pipeline.phases as p, pIdx}
                      <div class="sequence-item">
                        <div class="custom-tooltip">{getPhaseTooltip(p)}</div>
                        <div class="sequence-number">{pIdx + 1}</div>
                        <select class="select-input sequence-select" bind:value={pipeline.phases[pIdx]}>
                          {#each phases as availPhase}
                            <option value={availPhase.id}>{availPhase.name} ({availPhase.id})</option>
                          {/each}
                          {#if !phases.find((ap) => ap.id === p)}
                            <option value={p}>{p} (Unknown)</option>
                          {/if}
                        </select>
                        <div class="sequence-actions">
                          <button class="icon-btn" disabled={pIdx === 0} onclick={() => movePhaseUp(pIdx)}>↑</button>
                          <button class="icon-btn" disabled={pIdx === pipeline.phases.length - 1} onclick={() => movePhaseDown(pIdx)}>↓</button>
                          <button class="icon-btn destructive-icon" onclick={() => removePhaseFromPipeline(pIdx)}>✕</button>
                        </div>
                      </div>
                    {/each}
                  </div>
                  <div class="add-phase-row">
                    <select class="select-input flex-1" bind:value={newPhaseIdForPipeline}>
                      <option value="">-- Select a phase to add --</option>
                      {#each phases as availPhase}
                        <option value={availPhase.id}>{availPhase.name} ({availPhase.id})</option>
                      {/each}
                    </select>
                    <button class="btn btn-primary" disabled={!newPhaseIdForPipeline} onclick={addPhaseToPipeline}>Add Phase</button>
                  </div>
                </div>
              </div>
            </div>
          {:else}
            <div class="empty-selection">Select a pipeline to edit or add a new one.</div>
          {/if}
        </div>
      </div>

    {:else if activeTab === 'phases'}
      {#if showPhasesBanner}
        <TrustBanner variant="phases" />
      {/if}
      {#if showRetryConditionsBanner}
        <TrustBanner variant="retry-conditions" />
      {/if}
      <div class="toolbar">
        <button class="btn btn-primary" data-testid="phases-add" onclick={addPhase} disabled={!trustPhases}>Add Phase</button>
        <button class="btn" disabled={phaseHistoryIndex <= 0} onclick={undoPhase}>Undo</button>
        <button class="btn" disabled={phaseHistoryIndex >= phaseHistory.length - 1} onclick={redoPhase}>Redo</button>
        <button class="btn btn-secondary" data-testid="phases-save-all" style="margin-left:auto" onclick={savePhases} disabled={!trustPhases}>Save Phases</button>
      </div>
      {#if saveError}
        <div class="save-error-banner" data-testid="save-error-banner" role="alert">
          <span class="save-error-icon">⚠</span>
          <span class="save-error-text">Save rejected: {saveError}</span>
          <button class="save-error-dismiss" onclick={() => saveError = null}>✕</button>
        </div>
      {/if}
      <div class="split-pane">
        <div class="pane-left">
          <div class="phase-list">
            {#each phases as phase, i (phase.id + '-' + i)}
              <button class="phase-list-item {selectedPhaseIndex === i ? 'selected' : ''}" data-testid="phases-list-item-{phase.id}" onclick={() => selectedPhaseIndex = i}>
                <div class="phase-list-title">{phase.name || 'Untitled Phase'}</div>
                <div class="phase-list-id">{phase.id}</div>
              </button>
            {/each}
          </div>
        </div>
        <div class="pane-right">
          {#if selectedPhase && selectedPhaseIndex !== null && selectedEditState}
            {@const phaseRef = selectedPhase}
            {@const idx = selectedPhaseIndex}
            <div class="editor-card full-height" data-testid="phases-editor-{phaseRef.id}">
              <div class="card-header-complex">
                <input class="title-input" data-testid="phases-name-{phaseRef.id}" bind:value={phases[idx].name} placeholder="Phase Name" />
                <div class="header-actions">
                  <button class="btn btn-ghost" data-testid="phases-raw-json-toggle" onclick={() => toggleRawJson(phaseRef.id)}>
                    {selectedEditState.rawJsonMode ? 'Form view' : 'Edit as Raw JSON'}
                  </button>
                  <button class="btn btn-ghost" onclick={() => selectedPhaseIndex = null}>Cancel</button>
                  <button class="btn btn-ghost" onclick={() => resetPhase(selectedPhaseIndex!)}>Reset to Default</button>
                  <button class="btn btn-secondary" onclick={savePhases}>Save Phase</button>
                  <button class="btn btn-destructive" data-testid="phases-remove" onclick={() => removePhase(selectedPhaseIndex!)}>Delete Phase</button>
                </div>
              </div>

              {#if selectedEditState.rawJsonMode}
                <RawJsonPhaseEditor
                  phase={phaseRef as unknown as Record<string, unknown>}
                  onsave={(parsed) => onRawJsonSave(idx, parsed as Record<string, unknown>)}
                />
              {:else}
                <div class="form-grid">
                  <label class="form-field">
                    <span class="form-label">Name</span>
                    <input class="text-input" data-testid="phases-name-field-{phaseRef.id}" bind:value={phases[idx].name} placeholder="Phase display name" />
                  </label>
                  <label class="form-field">
                    <span class="form-label">ID</span>
                    <input class="text-input" bind:value={phases[idx].id} placeholder="phase-id" />
                  </label>
                  <label class="form-field full-width">
                    <span class="form-label">Instruction</span>
                    <textarea class="text-area" rows="6" bind:value={phases[idx].instruction} placeholder="Phase instructions..."></textarea>
                  </label>
                  <label class="form-field" style="flex: 1">
                    <span class="form-label">
                      Model
                    </span>
                    <select class="select-input" data-testid="phases-model-{phaseRef.id}" value={phases[idx].model ?? ''} onchange={(e) => { phases[idx].model = (e.currentTarget as HTMLSelectElement).value || undefined; }}>
                      <option value="">[Inherit / Default Backend Model]</option>
                      {#each models as model}
                        <option value={model}>{model}</option>
                      {/each}
                    </select>
                  </label>
                  <label class="form-field" style="flex: 1">
                    <span class="form-label">
                      Effort
                    </span>
                    <select class="select-input" data-testid="phases-effort-{phaseRef.id}" value={phases[idx].effort ?? ''} onchange={(e) => { const v = (e.currentTarget as HTMLSelectElement).value; phases[idx].effort = v ? (v as PhaseDefinition['effort']) : undefined; }}>
                      <option value="">[Inherit]</option>
                      {#each EFFORT_LEVELS as lvl}
                        <option value={lvl}>{lvl}</option>
                      {/each}
                    </select>
                  </label>
                  <label class="form-field checkbox-field">
                    <input type="checkbox" data-testid="phases-retry-toggle" checked={isRetryEnabled(phaseRef)} onchange={() => toggleRetryCondition(idx)} disabled={!trustRetryConditions} />
                    <span class="form-label">Retry Condition</span>
                  </label>
                  {#if isRetryEnabled(phaseRef)}
                    <div class="form-field full-width retry-condition-row">
                      <RetryConditionEditor
                        source={phaseRef.retryCondition ?? ''}
                        instruction={phaseRef.instruction}
                        onchange={(e) => onRetryConditionChange(idx, e)}
                        readonly={!trustRetryConditions}
                      />
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {:else}
            <div class="empty-selection">Select a phase to edit or add a new one.</div>
          {/if}
        </div>
      </div>

    {:else if activeTab === 'models'}
      <div class="models-container">
        <div class="toolbar" style="margin-bottom: 16px;">
          <form class="model-form" onsubmit={(e) => { e.preventDefault(); addModel(); }}>
            <input class="text-input flex-1" bind:value={newModelInput} placeholder="e.g. claude-3-7-sonnet-20250219 or sonnet" />
            <button class="btn btn-primary" type="submit">Add Model</button>
          </form>
          <button class="btn btn-secondary" style="margin-left:auto" onclick={saveModels}>Save Models</button>
        </div>
        <div class="models-list">
          {#if models.length === 0}
            <div class="empty-selection">No models defined.</div>
          {/if}
          {#each models as model, i (model + '-' + i)}
            <div class="model-list-item">
              <input class="text-input flex-1" bind:value={models[i]} />
              <button class="btn btn-destructive" style="margin-left: 12px;" onclick={() => removeModel(i)}>Remove</button>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .pipeline-builder { display: flex; flex-direction: column; flex: 1; min-height: 0; box-sizing: border-box; padding: 24px; gap: 16px; color: var(--schegent-fg); }
  .header h2 { margin: 0 0 8px 0; background: var(--sch-accent-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
  .header p { margin: 0 0 16px 0; color: var(--schegent-muted-fg); }
  .builder-tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--schegent-divider); padding-bottom: 8px; }
  .tab-btn { background: transparent; border: none; color: var(--schegent-muted-fg); padding: 6px 16px; border-radius: var(--schegent-radius); cursor: pointer; font-weight: 500; }
  .tab-btn.active { color: var(--schegent-fg); background: var(--vscode-list-activeSelectionBackground); }
  .builder-canvas { flex: 1; overflow-y: hidden; display: flex; flex-direction: column; gap: 16px; }
  .toolbar { display: flex; gap: 8px; }
  .split-pane { display: flex; gap: 16px; flex: 1; overflow: hidden; }
  .pane-left { width: 250px; border-right: 1px solid var(--schegent-divider); overflow-y: auto; padding-right: 8px; display: flex; flex-direction: column; }
  .pane-right { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
  .phase-list { display: flex; flex-direction: column; gap: 4px; }
  .phase-list-item { text-align: left; background: transparent; border: 1px solid transparent; padding: 12px; border-radius: var(--schegent-radius); cursor: pointer; color: var(--schegent-fg); transition: background 0.1s ease; }
  .phase-list-item:hover { background: var(--schegent-hover-bg); }
  .phase-list-item.selected { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-focusBorder); }
  .phase-list-title { font-weight: 500; margin-bottom: 4px; }
  .phase-list-id { font-size: 0.85em; color: var(--schegent-muted-fg); }
  .empty-selection { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--schegent-muted-fg); font-style: italic; padding: 16px; }
  .full-height { flex: 1; }
  .editor-card { background: var(--sch-glass-bg); border: 1px solid var(--sch-glass-border); border-radius: var(--schegent-radius); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .card-header-complex { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
  .header-actions { display: flex; gap: 8px; align-items: center; }
  .title-input { font-size: 1.2em; font-weight: 600; background: transparent; border: none; border-bottom: 1px solid transparent; color: var(--schegent-fg); padding: 4px; flex: 1; min-width: 200px; }
  .title-input:focus { outline: none; border-bottom-color: var(--vscode-focusBorder); }
  .card-body { display: flex; flex-direction: column; gap: 12px; flex: 1; }
  .card-body label { display: flex; flex-direction: column; gap: 4px; font-size: 0.9em; color: var(--schegent-muted-fg); }
  .text-input, .select-input { background: var(--schegent-input-bg); border: 1px solid var(--schegent-divider); color: var(--schegent-fg); padding: 8px; border-radius: 4px; font-family: inherit; font-size: 1em; }
  .text-input:focus, .select-input:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .text-area { background: var(--vscode-input-background); color: var(--schegent-fg); border: 1px solid var(--sch-glass-border); border-radius: var(--schegent-radius); padding: 6px 8px; font-family: inherit; width: 100%; box-sizing: border-box; resize: vertical; }
  .btn { padding: 6px 12px; border-radius: 4px; border: none; cursor: pointer; font-weight: 500; background: var(--schegent-hover-bg); color: var(--schegent-fg); }
  .btn:hover:not(:disabled) { background: var(--schegent-divider); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: transparent; border: 1px solid var(--vscode-button-background); color: var(--vscode-button-background); }
  .btn-secondary:hover { background: var(--vscode-list-hoverBackground); }
  .btn-destructive { background: transparent; border: 1px solid var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
  .btn-destructive:hover { background: var(--vscode-inputValidation-errorBackground); }
  .btn-ghost { background: transparent; border: 1px solid var(--schegent-divider); color: var(--schegent-fg); }
  .btn-ghost:hover { background: var(--schegent-hover-bg); }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .form-field { display: flex; flex-direction: column; gap: 4px; }
  .form-field.full-width { grid-column: 1 / -1; }
  .form-label { font-size: 0.85em; font-weight: 600; color: var(--schegent-muted-fg); }
  .checkbox-field { flex-direction: row; align-items: center; gap: 8px; }
  .retry-condition-row { border-top: 1px solid var(--schegent-divider); padding-top: 12px; }
  .phases-sequence-editor { display: flex; flex-direction: column; gap: 8px; margin-top: 16px; flex: 1; }
  .sequence-label { font-size: 0.9em; color: var(--schegent-muted-fg); }
  .sequence-list { display: flex; flex-direction: column; gap: 8px; background: var(--schegent-list-bg); padding: 12px; border-radius: 8px; flex: 1; overflow-y: auto; }
  .sequence-item { display: flex; align-items: center; gap: 8px; background: var(--sch-glass-bg); border: 1px solid var(--sch-glass-border); padding: 8px; border-radius: 4px; position: relative; }
  .sequence-item:hover .custom-tooltip { opacity: 1; visibility: visible; }
  .custom-tooltip { position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border); color: var(--vscode-editorHoverWidget-foreground); padding: 8px 12px; border-radius: 6px; font-size: 0.9em; width: 300px; z-index: 100; opacity: 0; visibility: hidden; pointer-events: none; box-shadow: 0 4px 6px transparent; white-space: pre-wrap; margin-bottom: 8px; }
  .sequence-item:first-child .custom-tooltip { bottom: auto; top: 100%; margin-bottom: 0; margin-top: 8px; }
  .sequence-number { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; background: var(--vscode-editor-background); border-radius: 50%; font-size: 0.8em; font-weight: bold; color: var(--schegent-muted-fg); }
  .sequence-select { flex: 1; }
  .sequence-actions { display: flex; gap: 4px; }
  .icon-btn { background: transparent; border: 1px solid var(--schegent-divider); border-radius: 4px; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--schegent-fg); }
  .icon-btn:hover:not(:disabled) { background: var(--schegent-hover-bg); }
  .icon-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  .destructive-icon:hover { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .add-phase-row { display: flex; gap: 8px; margin-top: 8px; }
  .flex-1 { flex: 1; }
  .models-container { display: flex; flex-direction: column; gap: 12px; flex: 1; }
  .model-form { display: flex; gap: 8px; flex: 1; }
  .models-list { display: flex; flex-direction: column; gap: 8px; max-height: 400px; overflow-y: auto; }
  .model-list-item { display: flex; align-items: center; background: var(--sch-glass-bg); border: 1px solid var(--sch-glass-border); padding: 8px 12px; border-radius: var(--schegent-radius); }
  .precedence-badge { display: inline-block; margin-left: 8px; padding: 2px 6px; font-size: 0.75em; font-weight: 500; color: var(--vscode-editorWarning-foreground, var(--schegent-muted-fg)); background: transparent; border: 1px solid var(--vscode-editorWarning-foreground, var(--schegent-muted-fg)); border-radius: 3px; vertical-align: middle; }
  .save-error-banner { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-errorForeground); border-radius: var(--schegent-radius); color: var(--vscode-errorForeground); font-size: 0.9em; }
  .save-error-icon { font-size: 1.1em; flex-shrink: 0; }
  .save-error-text { flex: 1; word-break: break-word; }
  .save-error-dismiss { background: transparent; border: none; color: var(--vscode-errorForeground); cursor: pointer; padding: 2px 6px; font-size: 1em; border-radius: 4px; }
  .save-error-dismiss:hover { background: var(--vscode-inputValidation-errorBackground); }
</style>
