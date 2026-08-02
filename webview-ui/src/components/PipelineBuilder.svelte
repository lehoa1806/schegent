<script lang="ts">
  import type { WorkflowSnapshot } from '../lib/snapshot-types';
  import { savePhases as savePhasesHelper, type SavePhasesMutation } from '../lib/save-phases';
  import { useConfirm } from '../lib/use-confirm';
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
  import {
    effectivePhasesToMutable,
    formatPhaseSaveRejection,
    makeDuplicatePhaseDraft,
    makeNewPhaseDraft,
    phaseTooltip,
    rebasePhaseMutation,
    sourceRecordToMutable,
    toSavePhaseRow
  } from './PipelineBuilderEditors/phase-catalog-state';
  import { initialModels } from './PipelineBuilderEditors/model-catalog-state';
  import TrustBanner from './TrustBanner.svelte';
  import './PipelineBuilderEditors/pipeline-builder.css';
  interface Props {
    snapshot: WorkflowSnapshot;
    initialTab?: 'pipelines' | 'phases' | 'models';
  }
  const { snapshot, initialTab }: Props = $props();
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
  // svelte-ignore state_referenced_locally
  let activeTab = $state<'pipelines' | 'phases' | 'models'>(initialTab ?? 'pipelines');
  let pipelines = $state<MutablePipeline[]>([]);
  let phases = $state<MutablePhase[]>([]);
  let effectivePhases = $state<MutablePhase[]>([]);
  let models = $state<Record<string, string[]>>({});
  let initialized = $state(false);
  let saveError = $state<string | null>(null);
  let saveErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let phaseMutation = $state<SavePhasesMutation | null>(null);
  let phaseMutationScope = $state<'user' | 'workspace' | null>(null);
  let phaseMutationSourceKey = $state<string | null>(null);
  let phaseSavePending = $state(false); let acceptedPhaseRevision = $state<string | null>(null); let stalePhaseRevision = $state<string | null>(null);
  let adoptedPhaseRevisions = $state({ user: '', workspace: '' });
  const phaseCatalogReady = $derived(snapshot.phaseCatalog?.state === 'ready');
  const phaseMutationsAllowed = $derived(
    phaseCatalogReady && snapshot.isPrimary === true && trustPhases && !phaseSavePending
  );
  const pipelinePhases = $derived(effectivePhases);
  function showSaveError(reason: string): void {
    saveError = reason;
    if (saveErrorTimer !== null) clearTimeout(saveErrorTimer);
    saveErrorTimer = setTimeout(() => { saveError = null; }, 8000);
  }
  $effect(() => {
    if (!initialized && snapshot.availablePipelines && snapshot.availableModels) {
      pipelines = JSON.parse(JSON.stringify(snapshot.availablePipelines));
      models = initialModels(snapshot.availableModels);
      initialized = true;
    }
    if (snapshot.availablePhases) effectivePhases = effectivePhasesToMutable(snapshot.availablePhases);
    const catalog = snapshot.phaseCatalog;
    if (catalog?.state === 'ready') {
      const revisionKey = `${catalog.revisions.user}:${catalog.revisions.workspace}`, adoptedKey = `${adoptedPhaseRevisions.user}:${adoptedPhaseRevisions.workspace}`;
      if (stalePhaseRevision !== null && phaseMutation && phaseMutationScope && catalog.revisions[phaseMutationScope] !== adoptedPhaseRevisions[phaseMutationScope]) {
        phases = rebasePhaseMutation(catalog.records, phases, phaseMutation, phaseMutationScope, phaseMutationSourceKey);
        adoptedPhaseRevisions = { ...catalog.revisions }; stalePhaseRevision = null;
      }
      const acceptedRefresh = acceptedPhaseRevision !== null && phaseMutationScope !== null && catalog.revisions[phaseMutationScope] !== adoptedPhaseRevisions[phaseMutationScope];
      const shouldAdopt = adoptedKey === ':' || phaseMutation === null || acceptedRefresh;
      if (revisionKey !== adoptedKey && shouldAdopt) {
        phases = catalog.records.map(sourceRecordToMutable);
        adoptedPhaseRevisions = { ...catalog.revisions };
        phaseSavePending = false;
        phaseMutation = null;
        phaseMutationScope = null;
        phaseMutationSourceKey = null;
        selectedPhaseIndex = null; acceptedPhaseRevision = null; stalePhaseRevision = null;
      }
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
  function submitPhaseMutation(
    mutation: SavePhasesMutation,
    scope: 'user' | 'workspace',
    sourceRows: readonly MutablePhase[] = phases
  ): void {
    const catalog = snapshot.phaseCatalog;
    if (!catalog || catalog.state !== 'ready' || phaseSavePending) return;
    const payload = sourceRows
      .filter((phase) => phase.scope === scope)
      .map(toSavePhaseRow);
    phaseSavePending = true; acceptedPhaseRevision = null;
    void savePhasesHelper({
      scope,
      expectedRevision: adoptedPhaseRevisions[scope],
      mutation,
      phases: payload
    }).then((result) => {
      if (result.status === 'rejected') {
        phaseSavePending = false;
        const stale = result.result as { currentRevision?: unknown } | undefined;
        if (result.reason === 'stale-catalog' && typeof stale?.currentRevision === 'string') stalePhaseRevision = stale.currentRevision;
        showSaveError(formatPhaseSaveRejection(result.reason, result.result));
        return;
      }
      saveError = null;
      const accepted = result.result as { revision?: string } | undefined; acceptedPhaseRevision = accepted?.revision ?? '';
      if (acceptedPhaseRevision === catalog.revisions[scope]) {
        phaseSavePending = false; phaseMutation = null; phaseMutationScope = null;
        phaseMutationSourceKey = null; acceptedPhaseRevision = null;
      }
    });
  }
  function savePhases(): void { if (phaseMutation && phaseMutationScope) submitPhaseMutation(phaseMutation, phaseMutationScope); }
  function saveModels(): void {
    void saveModelsHelper(JSON.parse(JSON.stringify(models)));
  }
  function getPhaseTooltip(phaseId: string): string {
    return phaseTooltip(effectivePhases, phaseId);
  }
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
    if (phaseMutation) return;
    const draft = makeNewPhaseDraft(phases);
    phases = [...phases, draft];
    selectedPhaseIndex = phases.length - 1;
    phaseMutation = { kind: 'create', phaseId: draft.id };
    phaseMutationScope = draft.scope as 'user' | 'workspace';
    phaseMutationSourceKey = draft.sourceKey;
  }
  function duplicatePhase(index: number): void {
    if (phaseMutation) return;
    const original = phases[index];
    if (!original) return;
    const duplicate = makeDuplicatePhaseDraft(original, phases);
    const newPhases = [...phases];
    newPhases.splice(index + 1, 0, duplicate);
    phases = newPhases;
    selectedPhaseIndex = index + 1;
    phaseMutation = {
      kind: 'duplicate',
      sourceScope: original.scope,
      sourcePhaseId: original.id,
      phaseId: duplicate.id
    };
    phaseMutationScope = duplicate.scope as 'user' | 'workspace';
    phaseMutationSourceKey = duplicate.sourceKey;
  }
  async function removePhase(index: number, originatingElement?: HTMLElement | null): Promise<void> {
    const phase = phases[index];
    if (!phase || phase.scope === 'built-in' || !phaseMutationsAllowed) return;
    const confirmed = await useConfirm('catalog.remove-phase', {
      originatingElement,
      context: { phaseName: phase.name, phaseId: phase.id, scope: phase.scope }
    });
    if (!confirmed) return;
    const proposed = phases.filter((_, rowIndex) => rowIndex !== index);
    phaseMutation = { kind: 'remove', phaseId: phase.id };
    phaseMutationScope = phase.scope;
    phaseMutationSourceKey = phase.sourceKey;
    submitPhaseMutation(phaseMutation, phase.scope, proposed);
  }
  function movePhaseListUp(index: number): void {
    if (index <= 0 || phaseMutation) return;
    const moved = phases[index], neighbor = phases[index - 1];
    if (moved.scope === 'built-in' || neighbor?.scope !== moved.scope) return;
    const newPhases = [...phases];
    const tmp = newPhases[index - 1]; newPhases[index - 1] = newPhases[index];
    newPhases[index] = tmp;
    phases = newPhases;
    if (selectedPhaseIndex === index) selectedPhaseIndex = index - 1;
    else if (selectedPhaseIndex === index - 1) selectedPhaseIndex = index;
    phaseMutation = { kind: 'edit', phaseId: moved.id };
    phaseMutationScope = moved.scope; phaseMutationSourceKey = moved.sourceKey;
  }
  function movePhaseListDown(index: number): void {
    if (index >= phases.length - 1 || phaseMutation) return;
    const moved = phases[index], neighbor = phases[index + 1];
    if (moved.scope === 'built-in' || neighbor?.scope !== moved.scope) return;
    const newPhases = [...phases];
    const tmp = newPhases[index + 1]; newPhases[index + 1] = newPhases[index];
    newPhases[index] = tmp;
    phases = newPhases;
    if (selectedPhaseIndex === index) selectedPhaseIndex = index + 1;
    else if (selectedPhaseIndex === index + 1) selectedPhaseIndex = index;
    phaseMutation = { kind: 'edit', phaseId: moved.id };
    phaseMutationScope = moved.scope; phaseMutationSourceKey = moved.sourceKey;
  }
  function resetPhase(index: number): void {
    const sourceKey = phases[index]?.sourceKey;
    const original = snapshot.phaseCatalog?.records.find((record) => record.key === sourceKey);
    phases = original
      ? phases.map((phase, rowIndex) => rowIndex === index ? sourceRecordToMutable(original) : phase)
      : phases.filter((_, rowIndex) => rowIndex !== index);
    phaseMutation = null;
    phaseMutationScope = null;
    phaseMutationSourceKey = null;
    selectedPhaseIndex = null;
  }
  function updatePhase(index: number, patch: Partial<MutablePhase>): void {
    const current = phases[index];
    if (!current || (phaseMutationSourceKey && current.sourceKey !== phaseMutationSourceKey)) return;
    phases = phases.map((phase, i) => i === index ? { ...phase, ...patch } : phase);
    const updated = phases[index];
    if (!updated.persisted) {
      updated.sourceKey = `draft::${updated.scope}::${updated.id}`;
    }
    if (updated?.persisted && updated.scope !== 'built-in') {
      phaseMutation = { kind: 'edit', phaseId: current.id };
      phaseMutationScope = updated.scope as 'user' | 'workspace';
      phaseMutationSourceKey = updated.sourceKey;
    } else if (phaseMutation?.kind === 'create' && patch.id && typeof patch.id === 'string') {
      phaseMutation = { kind: 'create', phaseId: patch.id };
    } else if (phaseMutation?.kind === 'duplicate' && patch.id && typeof patch.id === 'string') {
      phaseMutation = { ...phaseMutation, phaseId: patch.id };
    }
    if (!updated.persisted) {
      phaseMutationScope = updated.scope as 'user' | 'workspace';
      phaseMutationSourceKey = updated.sourceKey;
    }
  }
  function onRawJsonSave(index: number, parsed: Record<string, unknown>): void {
    updatePhase(index, parsed as Partial<MutablePhase>);
  }
  function onRetryConditionChange(index: number, e: { source: string; valid: boolean }): void {
    updatePhase(index, { retryCondition: e.source });
  }
  function isRetryEnabled(phase: MutablePhase): boolean {
    return typeof phase.retryCondition === 'string';
  }
  function toggleRetryCondition(index: number): void {
    const phase = phases[index];
    if (isRetryEnabled(phase)) {
      // Disable: clear retryCondition
      updatePhase(index, { retryCondition: undefined });
    } else {
      // Enable: seed with empty string so editor appears; user must fill it in
      updatePhase(index, { retryCondition: '' });
    }
  }
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
        phases={pipelinePhases}
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
        trusted={phaseMutationsAllowed}
        retryConditionsTrusted={trustRetryConditions}
        showTrustBanner={showPhasesBanner}
        showRetryTrustBanner={showRetryConditionsBanner}
        {saveError}
        savePending={phaseSavePending}
        mutationActive={phaseMutation !== null}
        editableSourceKey={phaseMutationSourceKey}
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
