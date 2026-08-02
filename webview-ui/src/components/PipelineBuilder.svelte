<script lang="ts">
  import type {
    WorkflowSnapshot,
    PhaseDefinition
  } from '../lib/snapshot-types';
  import { savePhases as savePhasesHelper, type SavePhaseRow } from '../lib/save-phases';
  import {
    savePipelines as savePipelinesHelper,
    type SavePipelineRow
  } from '../lib/save-pipelines';
  import { saveModels as saveModelsHelper } from '../lib/save-models';
  import ModelCatalogEditor from './PipelineBuilderEditors/ModelCatalogEditor.svelte';
  import PhaseCatalogEditor from './PipelineBuilderEditors/PhaseCatalogEditor.svelte';
  import PipelineCatalogEditor from './PipelineBuilderEditors/PipelineCatalogEditor.svelte';
  import type {
    MutablePhase,
    MutablePipeline,
    PhaseEditState
  } from './PipelineBuilderEditors/types';
  import TrustBanner from './TrustBanner.svelte';
  import './PipelineBuilderEditors/pipeline-builder.css';

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
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-fable-5',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-haiku-4-5'
  ];

  // `initialTab` is a mount-only test seam; production never updates it.
  // svelte-ignore state_referenced_locally
  let activeTab = $state<'pipelines' | 'phases' | 'models'>(initialTab ?? 'pipelines');

  let pipelines = $state<MutablePipeline[]>([]);
  let phases = $state<MutablePhase[]>([]);
  let models = $state<Record<string, string[]>>({});
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
      
      const loadedModels: Record<string, string[]> = {};
      const snapModels = snapshot.availableModels || {};
      for (const kind of Object.keys(snapModels)) {
        const loaded = JSON.parse(JSON.stringify(snapModels[kind as keyof typeof snapModels] || []));
        loadedModels[kind] = loaded.length > 0 ? loaded : (kind === 'claude' ? [...PRESEEDED_MODELS] : []);
      }
      models = loadedModels;
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
        model?: string;
        effort?: PhaseDefinition['effort'];
        timeoutSeconds?: number;
        loopable?: boolean;
        retryCondition?: string;
        isRequired?: boolean;
        runner?: string;
      } = {
        id: p.id,
        name: p.name,
        instruction: p.instruction
      };
      if (typeof p.model === 'string' && p.model.length > 0) row.model = p.model;
      if (typeof p.effort === 'string' && p.effort.length > 0) row.effort = p.effort;
      if (typeof p.timeoutSeconds === 'number') row.timeoutSeconds = p.timeoutSeconds;
      if (typeof p.loopable === 'boolean') row.loopable = p.loopable;
      if (typeof p.retryCondition === 'string') row.retryCondition = p.retryCondition;
      if (typeof p.isRequired === 'boolean') row.isRequired = p.isRequired;
      if (p.runner) row.runner = p.runner;
      return row;
    });
    void savePhasesHelper(payload).then((result) => {
      if (result.status === 'rejected') showSaveError(result.reason);
      else saveError = null;
    });
  }
  function saveModels(): void {
    void saveModelsHelper(JSON.parse(JSON.stringify(models)));
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
  function updatePipeline(
    index: number,
    patch: Partial<Pick<MutablePipeline, 'id' | 'name'>>
  ): void {
    pipelines = pipelines.map((pipeline, i) =>
      i === index ? { ...pipeline, ...patch } : pipeline
    );
  }
  function updatePipelinePhase(
    pipelineIndex: number,
    phaseIndex: number,
    phaseId: string
  ): void {
    pipelines = pipelines.map((pipeline, i) =>
      i === pipelineIndex
        ? {
            ...pipeline,
            phases: pipeline.phases.map((id, j) => j === phaseIndex ? phaseId : id)
          }
        : pipeline
    );
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

  let editStateById = $state<Record<string, PhaseEditState>>({});
  function ensureEditState(id: string): PhaseEditState {
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
    phases = [...phases, { id: 'new-phase', name: 'New Phase', instruction: 'Describe the phase objective here.', model: 'claude-opus-5', effort: 'max' } as MutablePhase];
    selectedPhaseIndex = phases.length - 1;
  }
  function duplicatePhase(index: number): void {
    const original = phases[index];
    if (!original) return;
    const duplicate = JSON.parse(JSON.stringify(original)) as MutablePhase;
    
    let newId = `${original.id}-copy`;
    let counter = 1;
    while (phases.some(p => p.id === newId)) {
      newId = `${original.id}-copy-${counter}`;
      counter++;
    }
    duplicate.id = newId;
    duplicate.name = `${original.name || 'Untitled Phase'} (Copy)`;
    
    const newPhases = [...phases];
    newPhases.splice(index + 1, 0, duplicate);
    phases = newPhases;
    selectedPhaseIndex = index + 1;
  }
  function removePhase(index: number): void {
    const id = phases[index]?.id;
    phases = phases.filter((_, i) => i !== index);
    if (selectedPhaseIndex === index) selectedPhaseIndex = null;
    else if (selectedPhaseIndex !== null && selectedPhaseIndex > index) selectedPhaseIndex--;
    if (id) { const next = { ...editStateById }; delete next[id]; editStateById = next; }
  }
  function movePhaseListUp(index: number): void {
    if (index <= 0) return;
    const newPhases = [...phases];
    const tmp = newPhases[index - 1];
    newPhases[index - 1] = newPhases[index];
    newPhases[index] = tmp;
    phases = newPhases;
    if (selectedPhaseIndex === index) selectedPhaseIndex = index - 1;
    else if (selectedPhaseIndex === index - 1) selectedPhaseIndex = index;
  }
  function movePhaseListDown(index: number): void {
    if (index >= phases.length - 1) return;
    const newPhases = [...phases];
    const tmp = newPhases[index + 1];
    newPhases[index + 1] = newPhases[index];
    newPhases[index] = tmp;
    phases = newPhases;
    if (selectedPhaseIndex === index) selectedPhaseIndex = index + 1;
    else if (selectedPhaseIndex === index + 1) selectedPhaseIndex = index;
  }
  function resetPhase(index: number): void {
    const original = snapshot.availablePhases?.find(p => p.id === phases[index].id);
    if (original) phases[index] = JSON.parse(JSON.stringify(original));
  }
  function updatePhase(index: number, patch: Partial<MutablePhase>): void {
    phases = phases.map((phase, i) => i === index ? { ...phase, ...patch } : phase);
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

  // --- Models ---
  let newModelInput = $state<Record<string, string>>({});
  
  function addModel(backend: string): void {
    const val = (newModelInput[backend] || '').trim();
    if (val) {
      if (!models[backend]) models[backend] = [];
      if (!models[backend].includes(val)) {
        models[backend] = [...models[backend], val];
        newModelInput[backend] = '';
      }
    }
  }
  
  function removeModel(backend: string, index: number): void { 
    if (models[backend]) {
      models[backend] = models[backend].filter((_, i) => i !== index);
    }
  }
  
  function updateModel(backend: string, index: number, value: string): void {
    if (models[backend]) {
      models[backend][index] = value;
    }
  }
</script>

<div class="pb" data-testid="pipeline-builder-root">
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
      <PipelineCatalogEditor
        {pipelines}
        {phases}
        selectedIndex={selectedPipelineIndex}
        historyIndex={pipelineHistoryIndex}
        historyLength={pipelineHistory.length}
        newPhaseId={newPhaseIdForPipeline}
        trusted={trustPipelineOverrides}
        showTrustBanner={showPipelinesBanner}
        {saveError}
        {getPhaseTooltip}
        onselect={(index) => selectedPipelineIndex = index}
        onadd={addPipeline}
        onremove={removePipeline}
        onreset={resetPipeline}
        onpipelinechange={updatePipeline}
        onphasechange={updatePipelinePhase}
        onundo={undoPipeline}
        onredo={redoPipeline}
        onsave={savePipelines}
        ondismisssaveerror={() => saveError = null}
        onnewphaseidchange={(value) => newPhaseIdForPipeline = value}
        onaddphase={addPhaseToPipeline}
        onremovephase={removePhaseFromPipeline}
        onmovephaseup={movePhaseUp}
        onmovephasedown={movePhaseDown}
      />

    {:else if activeTab === 'phases'}
      <PhaseCatalogEditor
        {snapshot}
        {phases}
        {editStateById}
        selectedIndex={selectedPhaseIndex}
        historyIndex={phaseHistoryIndex}
        historyLength={phaseHistory.length}
        trusted={trustPhases}
        retryConditionsTrusted={trustRetryConditions}
        showTrustBanner={showPhasesBanner}
        showRetryTrustBanner={showRetryConditionsBanner}
        {saveError}
        onselect={(index) => selectedPhaseIndex = index}
        onadd={addPhase}
        onremove={removePhase}
        onreset={resetPhase}
        onphasechange={updatePhase}
        onmoveup={movePhaseListUp}
        onmovedown={movePhaseListDown}
        onundo={undoPhase}
        onredo={redoPhase}
        onsave={savePhases}
        ondismisssaveerror={() => saveError = null}
        ontoggleraw={toggleRawJson}
        onrawsave={onRawJsonSave}
        ontoggleretry={toggleRetryCondition}
        onretrychange={onRetryConditionChange}
        onduplicate={duplicatePhase}
      />

    {:else if activeTab === 'models'}
      <ModelCatalogEditor
        availableModels={snapshot.availableModels}
        {models}
        {newModelInput}
        onnewmodelinput={(backend, value) => {
          const updated = { ...newModelInput };
          updated[backend] = value;
          newModelInput = updated;
        }}
        onmodelchange={updateModel}
        onadd={addModel}
        onremove={removeModel}
        onsave={saveModels}
      />
    {/if}
  </div>
</div>
