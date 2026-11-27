<script lang="ts">
  import type { WorkflowSnapshot } from '../lib/snapshot-types';
  import {
    deactivateDefinition,
    draftTokenOfRecord,
    saveDefinitionDraft,
    type CatalogWriteWait,
    type LifecycleResult
  } from '../lib/catalog-lifecycle';
  import { identityAt, reselectIndex } from '../lib/builder-selection';
  import {
    hydratePhaseSlice,
    hydrateWorkflowSlice,
    readPersistedBuilderState,
    updatePersistedBuilderState,
    writePersistedPhaseSlice
  } from '../lib/builder-webview-state';
  import { saveModels as saveModelsHelper } from '../lib/save-models';
  import ModelCatalogEditor from './PipelineBuilderEditors/ModelCatalogEditor.svelte';
  import PhaseCatalogEditor from './PipelineBuilderEditors/PhaseCatalogEditor.svelte';
  import WorkflowCatalogEditor from './PipelineBuilderEditors/WorkflowCatalogEditor.svelte';
  import BuilderImportModal from './Builder/BuilderImportModal.svelte';
  import type { ImportTargetGate } from './ProcessImport/process-import-state';
  import { topLevelImportDisabledReason } from './ProcessImport/process-exchange-entry';
  import type { BuilderTab, MutablePhase, PhaseEditState } from './PipelineBuilderEditors/types';
  import {
    formatPhaseSaveRejection,
    rebasePhaseMutation,
    sourceRecordToMutable,
    toSavePhaseRow,
    type PhaseCatalogMutation
  } from './PipelineBuilderEditors/phase-catalog-state';
  import {
    addPhaseRow, duplicatePhaseRow, phaseHistoryFrom, phasesAtHistoryStep,
    resetPhaseRow, retryConditionToggle, updatePhaseRow, withPhaseHistoryEntry, withRawJsonToggled,
    type PhaseMutationEdit, type PhaseRowsEdit
  } from './PipelineBuilderEditors/phase-catalog-actions';
  import {
    areModelsEqual,
    formatModelCatalogSaveRejection,
    initialModels,
    withModelAdded,
    withModelRemoved,
    withModelReplaced,
    withModelsDetected
  } from './PipelineBuilderEditors/model-catalog-state';
  import { phaseEditorOpen } from './PipelineBuilderEditors/phase-catalog-view';
  import BuilderTabs from './Builder/BuilderTabs.svelte';
  import TrustBanner from './TrustBanner.svelte';
  // The route sheet first: the Builder's own sheet below overrides it at equal specificity.
  import '../lib/sg/sg-builder.css';
  import './PipelineBuilderEditors/pipeline-builder.css';
  import './PipelineBuilderEditors/workflow-flow.css';
  interface Props {
    snapshot: WorkflowSnapshot;
    initialTab?: BuilderTab;
  }
  const { snapshot, initialTab }: Props = $props();
  const isPrimary = $derived(snapshot.isPrimary === true);
  const workspaceTrust = $derived(snapshot.workspaceTrust === true);
  const trustPhases = $derived(workspaceTrust && snapshot.resolvedTrust?.phases === true);
  const trustRetryConditions = $derived(
    workspaceTrust && snapshot.resolvedTrust?.retryConditions === true
  );
  const showWorkspaceTrustBanner = $derived(snapshot.workspaceTrust === false);
  const showPhasesBanner = $derived(!showWorkspaceTrustBanner && !trustPhases);
  const showRetryConditionsBanner = $derived(!showWorkspaceTrustBanner && !trustRetryConditions);
  const persistedBuilder = readPersistedBuilderState();
  // svelte-ignore state_referenced_locally
  const initialPhaseSlice = persistedBuilder?.phaseSlice
    ? hydratePhaseSlice(persistedBuilder.phaseSlice, snapshot)
    : null;
  // svelte-ignore state_referenced_locally
  const initialWorkflowSlice = persistedBuilder?.workflowSlice
    ? hydrateWorkflowSlice(persistedBuilder.workflowSlice, snapshot)
    : null;
  // svelte-ignore state_referenced_locally
  let activeTab = $state<BuilderTab>(initialTab ?? persistedBuilder?.activeTab ?? 'phases');
  let pendingWorkflowId = $state<string | null>(persistedBuilder?.pendingWorkflowId ?? null);
  let phases = $state<MutablePhase[]>(initialPhaseSlice?.phases ?? []);
  // svelte-ignore state_referenced_locally
  let adoptedModels = $state<Record<string, string[]>>(initialModels(snapshot.workspaceModelCatalog?.models ?? snapshot.configuredModels));
  // svelte-ignore state_referenced_locally
  let models = $state<Record<string, string[]>>(initialModels(snapshot.workspaceModelCatalog?.models ?? snapshot.configuredModels));
  // svelte-ignore state_referenced_locally
  let modelBaseRevision = $state(snapshot.workspaceModelCatalog?.revision);
  // svelte-ignore state_referenced_locally
  let lastModelRevision = snapshot.workspaceModelCatalog?.revision;
  let initialized = $state(initialPhaseSlice !== null);
  let saveError = $state<string | null>(null);
  let saveErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let modelsSaveError = $state<string | null>(null);
  let modelsSaveErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let phaseMutation = $state<PhaseCatalogMutation | null>(initialPhaseSlice?.mutation ?? null);
  let phaseMutationSourceKey = $state<string | null>(initialPhaseSlice?.mutationSourceKey ?? null);
  let phaseSavePending = $state(false);
  let phaseSaveAccepted = $state(false);
  let phaseRebasePending = $state(false);
  let adoptedPhaseRevision = $state(initialPhaseSlice?.adoptedRevision ?? '');
  let modelsSavePending = $state(false);
  let workflowEditorOpenInTab = $state(
    initialWorkflowSlice !== null && initialWorkflowSlice.selectedKey !== null
  );
  let workflowDirty = $state(
    initialWorkflowSlice !== null &&
      (initialWorkflowSlice.drafts.length > 0 ||
        Object.keys(initialWorkflowSlice.editedByKey).length > 0)
  );
  let workflowSavePending = $state(false);
  let importModalOpen = $state(false);
  let importModalOrigin = $state<HTMLElement | null>(null);

  const modelsDirty = $derived(!areModelsEqual(models, adoptedModels));
  const phaseCatalogReady = $derived(snapshot.phaseCatalog?.state === 'ready');
  const phaseMutationsAllowed = $derived(
    phaseCatalogReady && isPrimary && trustPhases && !phaseSavePending
  );
  const workflowMutationsAllowed = $derived(
    snapshot.workflowCatalog?.state === 'ready' && isPrimary && workspaceTrust
  );
  const importStartDisabledReason = $derived(topLevelImportDisabledReason(isPrimary));
  const importTargetGate = $derived<ImportTargetGate>({
    isPrimary,
    workspaceTrust,
    trustPhases,
    phaseSavePending,
    phaseMutationActive: phaseMutation !== null,
    workflowSavePending,
    workflowMutationActive: workflowDirty,
    modelsSavePending,
    modelsDirty
  });

  const phaseIdentity = (row: MutablePhase) => ({ sourceKey: row.sourceKey, id: row.id });
  const clearSaveError = (): void => { saveError = null; if (saveErrorTimer !== null) { clearTimeout(saveErrorTimer); saveErrorTimer = null; } };
  const showSaveError = (reason: string): void => { clearSaveError(); saveError = reason; saveErrorTimer = setTimeout(clearSaveError, 8000); };
  const clearModelsSaveError = (): void => { modelsSaveError = null; if (modelsSaveErrorTimer !== null) { clearTimeout(modelsSaveErrorTimer); modelsSaveErrorTimer = null; } };
  const showModelsSaveError = (reason: string): void => { clearModelsSaveError(); modelsSaveError = reason; modelsSaveErrorTimer = setTimeout(clearModelsSaveError, 8000); };
  const lifetime = new AbortController();
  $effect(() => () => { lifetime.abort(); clearSaveError(); clearModelsSaveError(); });
  function showLateWrite(late: LifecycleResult): void {
    if (late.status === 'accepted') clearSaveError();
    else if (late.reason !== 'declined') {
      if (phaseMutation?.kind === 'remove') { phaseMutation = null; phaseMutationSourceKey = null; }
      showSaveError(formatPhaseSaveRejection(late.reason, late.result));
    }
  }

  $effect(() => {
    const latestModels = snapshot.workspaceModelCatalog;
    if (latestModels && latestModels.revision !== lastModelRevision) {
      lastModelRevision = latestModels.revision;
      if (!modelsDirty || areModelsEqual(models, latestModels.models)) {
        adoptedModels = initialModels(latestModels.models);
        models = initialModels(latestModels.models);
        modelBaseRevision = latestModels.revision;
      }
      initialized = true;
    }
    const catalog = snapshot.phaseCatalog;
    if (catalog?.state === 'ready') {
      const revision = catalog.revision;
      if (phaseRebasePending && phaseMutation && revision !== adoptedPhaseRevision) {
        const rebased = rebasePhaseMutation(catalog.records, phases, phaseMutation, phaseMutationSourceKey);
        phases = rebased;
        const fresh = phaseHistoryFrom(rebased);
        phaseHistory = fresh.history; phaseHistoryIndex = fresh.index;
        adoptedPhaseRevision = revision; phaseRebasePending = false;
      }
      const acceptedRefresh = phaseSaveAccepted && revision !== adoptedPhaseRevision;
      const shouldAdopt = adoptedPhaseRevision === '' || phaseMutation === null || acceptedRefresh;
      if (revision !== adoptedPhaseRevision && shouldAdopt) {
        const openPhase = identityAt(phases, selectedPhaseIndex, phaseIdentity);
        const adopted = catalog.records.map(sourceRecordToMutable);
        phases = adopted;
        const fresh = phaseHistoryFrom(adopted);
        phaseHistory = fresh.history; phaseHistoryIndex = fresh.index;
        adoptedPhaseRevision = revision;
        phaseSavePending = false;
        phaseMutation = null;
        phaseMutationSourceKey = null;
        selectedPhaseIndex = reselectIndex(phases, openPhase, phaseIdentity);
        phaseSaveAccepted = false; phaseRebasePending = false;
        initialized = true;
      }
    }
  });

  function submitPhaseWrite(
    send: (wait: CatalogWriteWait) => Promise<LifecycleResult>,
    restoreOnDecline?: { mutation: PhaseCatalogMutation | null; sourceKey: string | null }
  ): void {
    if (phaseSavePending) return;
    phaseSavePending = true; phaseSaveAccepted = false;
    void send({ signal: lifetime.signal, onLateOutcome: showLateWrite }).then((result) => {
      if (result.status === 'rejected') {
        phaseSavePending = false;
        if (result.reason === 'declined') {
          phaseMutation = restoreOnDecline?.mutation ?? null;
          phaseMutationSourceKey = restoreOnDecline?.sourceKey ?? null;
          return;
        }
        if (phaseMutation?.kind === 'remove') { phaseMutation = null; phaseMutationSourceKey = null; }
        else if (result.reason === 'stale-catalog') phaseRebasePending = true;
        showSaveError(formatPhaseSaveRejection(result.reason, result.result));
        return;
      }
      clearSaveError();
      phaseSaveAccepted = true;
      if ((result.result as { appended?: boolean } | undefined)?.appended === false) {
        phaseSavePending = false; phaseSaveAccepted = false;
        phaseMutation = null; phaseMutationSourceKey = null;
      }
    });
  }

  function savePhaseDraft(): void {
    const catalog = snapshot.phaseCatalog;
    if (!phaseMutation || phaseMutation.kind === 'remove' || catalog?.state !== 'ready') return;
    const row = phases.find((candidate) => candidate.sourceKey === phaseMutationSourceKey);
    if (!row) return;
    const record = catalog.records.find((candidate) => candidate.key === row.sourceKey);
    submitPhaseWrite((wait) =>
      saveDefinitionDraft(
        { kind: 'phase', id: row.id, expectedDraftVersion: draftTokenOfRecord(record), body: toSavePhaseRow(row) },
        undefined,
        wait
      )
    );
  }

  async function saveModels(): Promise<void> {
    if (!modelsDirty || modelsSavePending || !isPrimary || !modelBaseRevision) return;
    const payload = JSON.parse(JSON.stringify(models)) as Record<string, string[]>;
    modelsSavePending = true;
    try {
      const result = await saveModelsHelper(payload, modelBaseRevision);
      if (result.status === 'rejected') {
        showModelsSaveError(formatModelCatalogSaveRejection(result.reason));
        return;
      }
      clearModelsSaveError();
      adoptedModels = payload;
      modelBaseRevision = result.revision ?? modelBaseRevision;
    } finally {
      modelsSavePending = false;
    }
  }

  function revertModels(): void {
    const latest = snapshot.workspaceModelCatalog;
    if (latest) {
      adoptedModels = initialModels(latest.models);
      modelBaseRevision = latest.revision;
    }
    models = initialModels(adoptedModels);
    newModelInput = {};
  }

  function openImportModal(originatingElement: HTMLElement | null): void {
    if (importStartDisabledReason !== null) return;
    importModalOrigin = originatingElement;
    importModalOpen = true;
  }

  let selectedPhaseIndex = $state<number | null>(initialPhaseSlice?.selectedIndex ?? null);
  let phaseHistory = $state<MutablePhase[][]>(initialPhaseSlice?.history ?? []);
  let phaseHistoryIndex = $state(initialPhaseSlice?.historyIndex ?? -1);
  let isPhaseUndoRedoAction = false;
  let editStateById = $state<Record<string, PhaseEditState>>(initialPhaseSlice?.editStateById ?? {});

  const phaseEditorShown = $derived(
    activeTab === 'phases' &&
      !showWorkspaceTrustBanner &&
      phaseEditorOpen({
        catalogState: snapshot.phaseCatalog?.state,
        selectedIndex: selectedPhaseIndex,
        phaseCount: phases.length
      })
  );
  const workflowEditorShown = $derived(
    activeTab === 'workflows' && !showWorkspaceTrustBanner && workflowEditorOpenInTab
  );
  const editorShown = $derived(phaseEditorShown || workflowEditorShown);

  function applyPhaseEdit(edit: PhaseMutationEdit | PhaseRowsEdit | null): void {
    if (!edit) return;
    phases = edit.phases;
    phaseMutation = edit.mutation;
    phaseMutationSourceKey = edit.mutationSourceKey;
    if ('selectedIndex' in edit) selectedPhaseIndex = edit.selectedIndex;
  }
  function updatePhase(index: number, patch: Partial<MutablePhase>): void {
    applyPhaseEdit(updatePhaseRow(phases, index, patch, phaseMutation, phaseMutationSourceKey));
  }
  function stepPhaseHistory(step: number): void {
    isPhaseUndoRedoAction = true;
    phaseHistoryIndex = step;
    phases = phasesAtHistoryStep(phaseHistory, step);
  }
  $effect(() => {
    updatePersistedBuilderState({ activeTab, pendingWorkflowId });
  });
  $effect(() => {
    if (!initialized) return;
    const currentStr = JSON.stringify(phases);
    if (!isPhaseUndoRedoAction) {
      const recorded = withPhaseHistoryEntry(phaseHistory, phaseHistoryIndex, currentStr);
      if (recorded) { phaseHistory = recorded.history; phaseHistoryIndex = recorded.index; }
    }
    isPhaseUndoRedoAction = false;
    if (adoptedPhaseRevision !== '') {
      writePersistedPhaseSlice({
        adoptedRevision: adoptedPhaseRevision,
        phases,
        selectedIndex: selectedPhaseIndex,
        mutation: phaseMutation,
        mutationSourceKey: phaseMutationSourceKey,
        history: phaseHistory,
        historyIndex: phaseHistoryIndex,
        editStateById
      });
    }
  });

  function removePhase(index: number, originatingElement?: HTMLElement | null): void {
    const phase = phases[index];
    const catalog = snapshot.phaseCatalog;
    if (!phase || !phase.persisted || !phaseMutationsAllowed || phaseMutation !== null || catalog?.state !== 'ready') return;
    const record = catalog.records.find((candidate) => candidate.key === phase.sourceKey);
    const prev = { mutation: phaseMutation, sourceKey: phaseMutationSourceKey };
    phaseMutation = { kind: 'remove', phaseId: phase.id };
    phaseMutationSourceKey = phase.sourceKey;
    submitPhaseWrite(
      (wait) =>
        deactivateDefinition(
          { kind: 'phase', id: phase.id, expectedDraftVersion: draftTokenOfRecord(record) },
          { definitionName: phase.name, originatingElement: originatingElement ?? null, wait }
        ),
      prev
    );
  }

  let newModelInput = $state<Record<string, string>>({});
  function addModel(backend: string): void {
    const next = withModelAdded(models, backend, newModelInput[backend] ?? '');
    if (!next) return;
    models = next;
    newModelInput[backend] = '';
  }
</script>

<main class="pb" data-testid="pipeline-builder-root">
  <div class="page">
    {#if !editorShown}
      <div class="phead">
        <div>
          <h1>Builder</h1>
          <p class="purpose">Reusable Phases, Workflows and models.</p>
        </div>
        <div class="actions">
          {#if importStartDisabledReason !== null}
            <span
              class="small muted"
              id="builder-import-unavailable"
              data-testid="builder-import-unavailable"
              role="status">{importStartDisabledReason}</span
            >
          {/if}
          <button
            type="button"
            class="btn btn-secondary"
            data-testid="builder-import-btn"
            disabled={importStartDisabledReason !== null}
            title={importStartDisabledReason ?? 'Import a Phase, Workflow, or Model Catalog YAML document'}
            aria-describedby={importStartDisabledReason !== null ? 'builder-import-unavailable' : undefined}
            onclick={(event) => openImportModal(event.currentTarget)}
          ><svg class="i" aria-hidden="true"><use href="#i-import"></use></svg>Import…</button>
        </div>
      </div>
      <BuilderTabs {activeTab} onactivate={(tab) => activeTab = tab} />
    {/if}
    <!-- Without the tabs the panel is the page's content, so it names no tab. -->
    <div
      id="builder-panel-{activeTab}"
      class="builder-canvas"
      role={editorShown ? undefined : 'tabpanel'}
      aria-labelledby={editorShown ? undefined : `builder-tab-${activeTab}`}
    >
      {#if showWorkspaceTrustBanner}
        <TrustBanner variant="workspace-trust" />
      {/if}
      {#if showWorkspaceTrustBanner && activeTab !== 'models'}
        <p class="empty-selection" data-testid="builder-trust-gated">
          Phase and Workflow definitions are not read until this
          workspace is trusted.
        </p>
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
          editableSourceKey={phaseMutation?.kind === 'remove' ? null : phaseMutationSourceKey}
          importDisabledReason={importStartDisabledReason}
          onselect={(index) => selectedPhaseIndex = index}
          onadd={() => { if (phaseMutationsAllowed && !phaseMutation) applyPhaseEdit(addPhaseRow(phases)); }}
          onremove={removePhase}
          onreset={(index) => {
            if (phaseMutationsAllowed && phaseMutation !== null && phaseMutationSourceKey === phases[index]?.sourceKey) {
              applyPhaseEdit(resetPhaseRow(phases, index, snapshot.phaseCatalog?.records));
            }
          }}
          onphasechange={updatePhase}
          onundo={() => { if (phaseHistoryIndex > 0) stepPhaseHistory(phaseHistoryIndex - 1); }}
          onredo={() => { if (phaseHistoryIndex < phaseHistory.length - 1) stepPhaseHistory(phaseHistoryIndex + 1); }}
          onsave={savePhaseDraft}
          ondismisssaveerror={clearSaveError}
          ontoggleraw={(id) => editStateById = withRawJsonToggled(editStateById, id)}
          onrawsave={(index, parsed) => updatePhase(index, parsed as Partial<MutablePhase>)}
          ontoggleretry={(index) => updatePhase(index, retryConditionToggle(phases[index]))}
          onretrychange={(index, e) => updatePhase(index, { retryCondition: e.source })}
          onduplicate={(index) => { if (phaseMutationsAllowed && !phaseMutation) applyPhaseEdit(duplicatePhaseRow(phases, index)); }}
          onopenworkflow={(workflowId) => {
            pendingWorkflowId = workflowId;
            activeTab = 'workflows';
          }}
          onopenimport={openImportModal}
        />
      {:else if activeTab === 'workflows'}
        <WorkflowCatalogEditor
          {snapshot}
          trusted={workflowMutationsAllowed}
          initialWorkflowId={pendingWorkflowId}
          importDisabledReason={importStartDisabledReason}
          onopenphase={(phaseId) => {
            const idx = phases.findIndex((p) => p.id === phaseId);
            if (idx >= 0) selectedPhaseIndex = idx;
            activeTab = 'phases';
          }}
          onopenimport={openImportModal}
          oneditorchange={(open) => (workflowEditorOpenInTab = open)}
          ondirtychange={({ dirty, savePending }) => {
            workflowDirty = dirty;
            workflowSavePending = savePending;
          }}
          oninitialworkflowconsumed={() => (pendingWorkflowId = null)}
        />
      {:else if activeTab === 'models'}
        {#if modelsSaveError}
          <div class="attn" data-testid="models-save-error-banner" role="alert">
            <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
            <div class="body">Save rejected: {modelsSaveError}</div>
            <button type="button" class="icon-btn" aria-label="Dismiss Model Catalog save error" onclick={clearModelsSaveError}><svg class="i" aria-hidden="true"><use href="#i-x"></use></svg></button>
          </div>
        {/if}
        <ModelCatalogEditor
          availableModels={snapshot.availableModels}
          {models}
          {newModelInput}
          dirty={modelsDirty}
          savePending={modelsSavePending}
          canSave={isPrimary && modelBaseRevision !== undefined}
          onnewmodelinput={(backend, value) => {
            const updated = { ...newModelInput };
            updated[backend] = value;
            newModelInput = updated;
          }}
          onmodelchange={(backend, index, value) => models = withModelReplaced(models, backend, index, value)}
          onadd={addModel}
          onremove={(backend, index) => models = withModelRemoved(models, backend, index)}
          onsave={() => void saveModels()}
          ondetect={(backend) => models = withModelsDetected(
            models, backend, snapshot.availableModels?.[backend as keyof typeof snapshot.availableModels] ?? []
          )}
          onrevert={revertModels}
        />
      {/if}
    </div>
  </div>
</main>

{#if importModalOpen}
  <BuilderImportModal
    originatingElement={importModalOrigin}
    targetGate={importTargetGate}
    disabledReason={importStartDisabledReason}
    onclose={() => (importModalOpen = false)}
  />
{/if}
