<script lang="ts">
  import type { WorkflowSnapshot } from '../lib/snapshot-types';
  import { savePhases as savePhasesHelper, type SavePhasesMutation } from '../lib/save-phases';
  import { saveModels as saveModelsHelper } from '../lib/save-models';
  import ModelCatalogEditor from './PipelineBuilderEditors/ModelCatalogEditor.svelte';
  import PhaseCatalogEditor from './PipelineBuilderEditors/PhaseCatalogEditor.svelte';
  import ProcessImportPreflight from './ProcessImport/ProcessImportPreflight.svelte';
  import PipelineCatalogEditor from './PipelineBuilderEditors/PipelineCatalogEditor.svelte';
  import WorkflowCatalogEditor from './PipelineBuilderEditors/WorkflowCatalogEditor.svelte';
  import type { MutablePhase, PhaseEditState } from './PipelineBuilderEditors/types';
  import { PipelineCatalogStore } from './PipelineBuilderEditors/pipeline-catalog-store.svelte';
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
  import { initialModels, withModelAdded, withModelRemoved, withModelReplaced, withModelsDetected } from './PipelineBuilderEditors/model-catalog-state';
  import TrustBanner from './TrustBanner.svelte';
  import './PipelineBuilderEditors/pipeline-builder.css';
  interface Props {
    snapshot: WorkflowSnapshot;
    initialTab?: 'pipelines' | 'phases' | 'workflows' | 'models';
  }
  const { snapshot, initialTab }: Props = $props();
  type BuilderTab = 'pipelines' | 'phases' | 'workflows' | 'models';
  const BUILDER_TABS = Object.freeze([
    { id: 'pipelines', label: 'Pipelines' },
    { id: 'phases', label: 'Phases' },
    { id: 'workflows', label: 'Workflows' },
    { id: 'models', label: 'Models' }
  ] satisfies ReadonlyArray<{ id: BuilderTab; label: string }>);
  const workspaceTrust = $derived(snapshot.workspaceTrust === true);
  const trustPhases = $derived(
    workspaceTrust && snapshot.resolvedTrust?.phases === true
  );
  const trustRetryConditions = $derived(
    workspaceTrust && snapshot.resolvedTrust?.retryConditions === true
  );
  // Feature 099 (T492, FR-046) — `pipelineOverrides` and `workflowOverrides` are
  // gone. Both asked which layer was allowed to redefine another's row, and
  // there is one layer; the Pipelines and Workflows tabs are gated by Workspace
  // Trust alone. The two survivors above gate document CONTENT, not layering.
  const showWorkspaceTrustBanner = $derived(snapshot.workspaceTrust === false);
  const showPhasesBanner = $derived(!showWorkspaceTrustBanner && !trustPhases);
  const showRetryConditionsBanner = $derived(
    !showWorkspaceTrustBanner && !trustRetryConditions
  );
  // svelte-ignore state_referenced_locally
  let activeTab = $state<BuilderTab>(initialTab ?? 'pipelines');
  let phases = $state<MutablePhase[]>([]);
  let effectivePhases = $state<MutablePhase[]>([]);
  let models = $state<Record<string, string[]>>({});
  let initialized = $state(false);
  let lastAdoptedModels: Record<string, readonly string[]> | null = null; // re-sync on snapshot change
  let saveError = $state<string | null>(null);
  let saveErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let phaseMutation = $state<SavePhasesMutation | null>(null);
  let phaseMutationSourceKey = $state<string | null>(null);
  let phaseSavePending = $state(false); let acceptedPhaseRevision = $state<string | null>(null); let stalePhaseRevision = $state<string | null>(null);
  /** The revision the visible rows were projected from; '' before the first. */
  let adoptedPhaseRevision = $state('');
  const phaseCatalogReady = $derived(snapshot.phaseCatalog?.state === 'ready');
  const phaseMutationsAllowed = $derived(
    phaseCatalogReady && snapshot.isPrimary === true && trustPhases && !phaseSavePending
  );
  const pipelinePhases = $derived(effectivePhases);
  const pipelineMutationsAllowed = $derived(
    snapshot.pipelineCatalog?.state === 'ready' &&
      snapshot.isPrimary === true &&
      workspaceTrust
  );
  const workflowMutationsAllowed = $derived(
    snapshot.workflowCatalog?.state === 'ready' &&
      snapshot.isPrimary === true &&
      workspaceTrust
  );
  function showSaveError(reason: string): void {
    saveError = reason;
    if (saveErrorTimer !== null) clearTimeout(saveErrorTimer);
    saveErrorTimer = setTimeout(() => { saveError = null; }, 8000);
  }
  // Feature 082 — the Pipeline tab's rows, mutation handshake, and history live
  // in a rune store so this component stays inside the 500-line Svelte budget.
  const pipelineStore = new PipelineCatalogStore({
    getSnapshot: () => snapshot,
    onSaveError: showSaveError,
    onSaveAccepted: () => { saveError = null; }
  });
  $effect(() => { pipelineStore.syncFromSnapshot(snapshot); });
  $effect(() => { if (initialized) pipelineStore.recordHistory(); });
  $effect(() => {
    // Seeded from the CONFIGURED catalog, so a confirmed import is adopted;
    // `initialModels` records why detection is the wrong source.
    if (snapshot.configuredModels && snapshot.configuredModels !== lastAdoptedModels) {
      models = initialModels(snapshot.configuredModels); lastAdoptedModels = snapshot.configuredModels; initialized = true;
    }
    if (snapshot.availablePhases) effectivePhases = effectivePhasesToMutable(snapshot.availablePhases);
    const catalog = snapshot.phaseCatalog;
    if (catalog?.state === 'ready') {
      // Feature 099 (T494a, FR-043/FR-044) — one layer, so one adopted revision.
      // The handshake is otherwise unchanged: it is still the expected-revision
      // gate, now reading the store's manifest revision for the Phase kind.
      const revision = catalog.revision;
      if (stalePhaseRevision !== null && phaseMutation && revision !== adoptedPhaseRevision) {
        phases = rebasePhaseMutation(catalog.records, phases, phaseMutation, phaseMutationSourceKey);
        adoptedPhaseRevision = revision; stalePhaseRevision = null;
      }
      const acceptedRefresh = acceptedPhaseRevision !== null && revision !== adoptedPhaseRevision;
      const shouldAdopt = adoptedPhaseRevision === '' || phaseMutation === null || acceptedRefresh;
      if (revision !== adoptedPhaseRevision && shouldAdopt) {
        phases = catalog.records.map(sourceRecordToMutable);
        adoptedPhaseRevision = revision;
        phaseSavePending = false;
        phaseMutation = null;
        phaseMutationSourceKey = null;
        selectedPhaseIndex = null; acceptedPhaseRevision = null; stalePhaseRevision = null;
      }
    }
  });
  function submitPhaseMutation(
    mutation: SavePhasesMutation,
    sourceRows: readonly MutablePhase[] = phases,
    prompt: { removedName?: string; originatingElement?: HTMLElement | null } = {}
  ): void {
    const catalog = snapshot.phaseCatalog;
    if (!catalog || catalog.state !== 'ready' || phaseSavePending) return;
    const payload = sourceRows.map(toSavePhaseRow);
    phaseSavePending = true; acceptedPhaseRevision = null;
    void savePhasesHelper({
      expectedRevision: adoptedPhaseRevision,
      mutation,
      phases: payload,
      ...prompt
    }).then((result) => {
      if (result.status === 'rejected') {
        phaseSavePending = false;
        // Feature 100 (T509b) — the operator closed the removal prompt. Nothing
        // was sent and nothing failed, so no error is reported.
        if (result.reason === 'declined') {
          phaseMutation = null; phaseMutationSourceKey = null;
          return;
        }
        const stale = result.result as { currentRevision?: unknown } | undefined;
        if (result.reason === 'stale-catalog' && typeof stale?.currentRevision === 'string') stalePhaseRevision = stale.currentRevision;
        showSaveError(formatPhaseSaveRejection(result.reason, result.result));
        return;
      }
      saveError = null;
      const accepted = result.result as { revision?: string } | undefined; acceptedPhaseRevision = accepted?.revision ?? '';
      if (acceptedPhaseRevision === catalog.revision) {
        phaseSavePending = false; phaseMutation = null;
        phaseMutationSourceKey = null; acceptedPhaseRevision = null;
      }
    });
  }
  function savePhases(): void { if (phaseMutation) submitPhaseMutation(phaseMutation); }
  function saveModels(): void {
    void saveModelsHelper(JSON.parse(JSON.stringify(models)));
  }
  function getPhaseTooltip(phaseId: string): string {
    return phaseTooltip(effectivePhases, phaseId);
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
      sourcePhaseId: original.id,
      phaseId: duplicate.id
    };
    phaseMutationSourceKey = duplicate.sourceKey;
  }
  // Feature 100 (T509b) — the confirmation moved into `deactivateDefinition`,
  // the only function that can post the command it authorises (FR-049). This
  // handler supplies what the prompt needs to say and no longer asks itself.
  function removePhase(index: number, originatingElement?: HTMLElement | null): void {
    const phase = phases[index];
    if (!phase || !phaseMutationsAllowed) return;
    const proposed = phases.filter((_, rowIndex) => rowIndex !== index);
    phaseMutation = { kind: 'remove', phaseId: phase.id };
    phaseMutationSourceKey = phase.sourceKey;
    submitPhaseMutation(phaseMutation, proposed, {
      removedName: phase.name,
      originatingElement: originatingElement ?? null
    });
  }
  function movePhaseListUp(index: number): void {
    if (index <= 0 || phaseMutation) return;
    const moved = phases[index];
    const newPhases = [...phases];
    const tmp = newPhases[index - 1]; newPhases[index - 1] = newPhases[index];
    newPhases[index] = tmp;
    phases = newPhases;
    if (selectedPhaseIndex === index) selectedPhaseIndex = index - 1;
    else if (selectedPhaseIndex === index - 1) selectedPhaseIndex = index;
    phaseMutation = { kind: 'edit', phaseId: moved.id };
    phaseMutationSourceKey = moved.sourceKey;
  }
  function movePhaseListDown(index: number): void {
    if (index >= phases.length - 1 || phaseMutation) return;
    const moved = phases[index];
    const newPhases = [...phases];
    const tmp = newPhases[index + 1]; newPhases[index + 1] = newPhases[index];
    newPhases[index] = tmp;
    phases = newPhases;
    if (selectedPhaseIndex === index) selectedPhaseIndex = index + 1;
    else if (selectedPhaseIndex === index + 1) selectedPhaseIndex = index;
    phaseMutation = { kind: 'edit', phaseId: moved.id };
    phaseMutationSourceKey = moved.sourceKey;
  }
  function resetPhase(index: number): void {
    const sourceKey = phases[index]?.sourceKey;
    const original = snapshot.phaseCatalog?.records.find((record) => record.key === sourceKey);
    phases = original
      ? phases.map((phase, rowIndex) => rowIndex === index ? sourceRecordToMutable(original) : phase)
      : phases.filter((_, rowIndex) => rowIndex !== index);
    phaseMutation = null;
    phaseMutationSourceKey = null;
    selectedPhaseIndex = null;
  }
  function updatePhase(index: number, patch: Partial<MutablePhase>): void {
    const current = phases[index];
    if (!current || (phaseMutationSourceKey && current.sourceKey !== phaseMutationSourceKey)) return;
    phases = phases.map((phase, i) => i === index ? { ...phase, ...patch } : phase);
    const updated = phases[index];
    if (updated.persisted) {
      phaseMutation = { kind: 'edit', phaseId: current.id };
      phaseMutationSourceKey = updated.sourceKey;
      return;
    }
    updated.sourceKey = `draft::${updated.id}`;
    if (phaseMutation?.kind === 'create' && typeof patch.id === 'string') {
      phaseMutation = { kind: 'create', phaseId: patch.id };
    } else if (phaseMutation?.kind === 'duplicate' && typeof patch.id === 'string') {
      phaseMutation = { ...phaseMutation, phaseId: patch.id };
    }
    phaseMutationSourceKey = updated.sourceKey;
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
  // The catalog transforms live in `model-catalog-state.ts` beside the seeding
  // and merge rules they share; these are the bindings that apply them.
  function addModel(backend: string): void {
    const next = withModelAdded(models, backend, newModelInput[backend] ?? '');
    if (!next) return;
    models = next;
    newModelInput[backend] = '';
  }
  function removeModel(backend: string, index: number): void {
    models = withModelRemoved(models, backend, index);
  }
  function updateModel(backend: string, index: number, value: string): void {
    models = withModelReplaced(models, backend, index, value);
  }
  function detectModels(backend: string): void {
    const kind = backend as keyof typeof snapshot.availableModels;
    models = withModelsDetected(models, backend, snapshot.availableModels?.[kind] ?? []);
  }
  function activateTab(tab: BuilderTab, focus = false): void {
    activeTab = tab;
    if (!focus) return;
    queueMicrotask(() => document.getElementById(`builder-tab-${tab}`)?.focus());
  }
  function onBuilderTabKeydown(event: KeyboardEvent): void {
    const current = BUILDER_TABS.findIndex((tab) => tab.id === activeTab);
    let next = current;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = (current - 1 + BUILDER_TABS.length) % BUILDER_TABS.length;
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = (current + 1) % BUILDER_TABS.length;
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = BUILDER_TABS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    activateTab(BUILDER_TABS[next].id, true);
  }
</script>
<main class="pb" data-testid="pipeline-builder-root">
  <div class="header">
    <h2>Process Library</h2>
    <p>Author and manage reusable phases, pipelines, workflows, and models.</p>
    <div class="builder-tabs" role="tablist" aria-label="Process library catalogs">
      {#each BUILDER_TABS as tab (tab.id)}
        <button
          id="builder-tab-{tab.id}"
          type="button"
          class="tab-btn {activeTab === tab.id ? 'active' : ''}"
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-controls="builder-panel-{tab.id}"
          tabindex={activeTab === tab.id ? 0 : -1}
          onclick={() => activateTab(tab.id)}
          onkeydown={onBuilderTabKeydown}
        >{tab.label}</button>
      {/each}
    </div>
  </div>
  <div
    id="builder-panel-{activeTab}"
    class="builder-canvas"
    role="tabpanel"
    aria-labelledby="builder-tab-{activeTab}"
  >
    {#if showWorkspaceTrustBanner}
      <TrustBanner variant="workspace-trust" />
    {/if}
    {#if showWorkspaceTrustBanner && activeTab !== 'models'}
      <!--
        Feature 099 (T493c, FR-052) — an untrusted workspace activates no
        catalog, so the three definition tabs have no rows to render. Showing
        their editors anyway would present an empty catalog, which reads as
        "nothing is defined here" when the truth is "this workspace is not
        trusted". The banner above plus this line are the report. The Models
        tab is not store-backed (FR-056) and keeps its editor.
      -->
      <p class="empty-selection" data-testid="builder-trust-gated">
        Phase, Pipeline, and Workflow definitions are not read until this
        workspace is trusted.
      </p>
    {:else if activeTab === 'pipelines'}
      <PipelineCatalogEditor
        {snapshot}
        pipelines={pipelineStore.pipelines}
        phases={pipelinePhases}
        selectedIndex={pipelineStore.selectedIndex}
        historyIndex={pipelineStore.historyIndex}
        historyLength={pipelineStore.historyLength}
        newPhaseId={pipelineStore.newPhaseId}
        trusted={pipelineMutationsAllowed}
        {saveError}
        savePending={pipelineStore.savePending}
        mutationActive={pipelineStore.mutationActive}
        editableSourceKey={pipelineStore.mutationSourceKey}
        {getPhaseTooltip}
        onselect={(index) => pipelineStore.selectedIndex = index}
        onadd={() => pipelineStore.add()}
        onremove={(index, element) => pipelineStore.remove(index, element)}
        onreset={(index) => pipelineStore.discardDraft(index)}
        onduplicate={(index) => pipelineStore.duplicate(index)}
        onpipelinechange={(index, patch) => pipelineStore.update(index, patch)}
        onphasechange={(pipelineIndex, phaseIndex, phaseId) =>
          pipelineStore.setPhase(pipelineIndex, phaseIndex, phaseId)}
        onundo={() => pipelineStore.undo()}
        onredo={() => pipelineStore.redo()}
        onsave={() => pipelineStore.save()}
        ondismisssaveerror={() => saveError = null}
        onnewphaseidchange={(value) => pipelineStore.newPhaseId = value}
        onaddphase={() => pipelineStore.appendPhase()}
        onremovephase={(index) => pipelineStore.removePhase(index)}
        onmovephaseup={(index) => pipelineStore.movePhaseUp(index)}
        onmovephasedown={(index) => pipelineStore.movePhaseDown(index)}
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
    {:else if activeTab === 'workflows'}
      <!--
        Feature 083 — the Workflow Library's only mount site. The editor owns
        its rows, its revision handshake, and its confirmations; this branch
        supplies the trust verdict it is not allowed to compute for itself.
        Feature 099 (T492, FR-046) — that verdict is now Workspace Trust alone,
        and the untrusted case is reported by the branch above, so there is no
        second banner to render here.
      -->
      <WorkflowCatalogEditor {snapshot} trusted={workflowMutationsAllowed} />
    {:else if activeTab === 'models'}
      <!-- Feature 096 T025 — the import entry point for the Model Catalog, its
           own region above the editor for the same reason PhaseCatalogEditor's
           is: the preflight it opens renders in place. No `disabledReason`: a
           Model Catalog write has no capability-trust gate to observe
           (research.md Decision 9, cmd-save-models.ts), so unlike the Phase
           mount there is no condition here to compute or state. -->
      <ProcessImportPreflight />
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
        ondetect={detectModels}
      />
    {/if}
  </div>
</main>
