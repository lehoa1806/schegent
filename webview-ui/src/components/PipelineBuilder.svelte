<script lang="ts">
  import type { WorkflowSnapshot } from '../lib/snapshot-types';
  import {
    deactivateDefinition,
    draftTokenOfRecord,
    saveDefinitionDraft,
    type LifecycleResult
  } from '../lib/catalog-lifecycle';
  import { saveModels as saveModelsHelper } from '../lib/save-models';
  import ModelCatalogEditor from './PipelineBuilderEditors/ModelCatalogEditor.svelte';
  import PhaseCatalogEditor from './PipelineBuilderEditors/PhaseCatalogEditor.svelte';
  import ProcessImportPreflight from './ProcessImport/ProcessImportPreflight.svelte';
  import PipelineCatalogEditor from './PipelineBuilderEditors/PipelineCatalogEditor.svelte';
  import WorkflowCatalogEditor from './PipelineBuilderEditors/WorkflowCatalogEditor.svelte';
  import type { BuilderTab, MutablePhase, PhaseEditState } from './PipelineBuilderEditors/types';
  import { PipelineCatalogStore } from './PipelineBuilderEditors/pipeline-catalog-store.svelte';
  import {
    effectivePhasesToMutable,
    formatPhaseSaveRejection,
    phaseTooltip,
    rebasePhaseMutation,
    sourceRecordToMutable,
    toSavePhaseRow,
    type PhaseCatalogMutation
  } from './PipelineBuilderEditors/phase-catalog-state';
  import {
    addPhaseRow, duplicatePhaseRow, movePhaseRow, phasesAtHistoryStep, resetPhaseRow,
    retryConditionToggle, updatePhaseRow, withPhaseHistoryEntry, withRawJsonToggled,
    type PhaseMutationEdit, type PhaseRowsEdit
  } from './PipelineBuilderEditors/phase-catalog-actions';
  import { initialModels, withModelAdded, withModelRemoved, withModelReplaced, withModelsDetected } from './PipelineBuilderEditors/model-catalog-state';
  import BuilderTabs from './Builder/BuilderTabs.svelte';
  import TrustBanner from './TrustBanner.svelte';
  import './PipelineBuilderEditors/pipeline-builder.css';
  import './PipelineBuilderEditors/workflow-flow.css';
  interface Props {
    snapshot: WorkflowSnapshot;
    initialTab?: BuilderTab;
  }
  const { snapshot, initialTab }: Props = $props();
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
  // Feature 180 (T1554, FR-002) — the default moves with the strip, so `tabs[0]`
  // is still the tab that carries `tabindex="0"` on open. Held as a literal
  // rather than read off `BUILDER_TABS[0]`: deriving it would couple the shell
  // to the strip's internals to save one string.
  let activeTab = $state<BuilderTab>(initialTab ?? 'phases');
  let phases = $state<MutablePhase[]>([]);
  let effectivePhases = $state<MutablePhase[]>([]);
  let models = $state<Record<string, string[]>>({});
  let initialized = $state(false);
  let lastAdoptedModels: Record<string, readonly string[]> | null = null; // re-sync on snapshot change
  let saveError = $state<string | null>(null);
  let saveErrorTimer: ReturnType<typeof setTimeout> | null = null;
  let phaseMutation = $state<PhaseCatalogMutation | null>(null);
  let phaseMutationSourceKey = $state<string | null>(null);
  // Feature 101 (T026) — both handshake flags are booleans now. They were named
  // after the revision string the retired `savePhases` ack carried, and the acks
  // carry no revision: what the effect below has always read out of them is
  // "a write landed" and "the last write was refused as stale".
  let phaseSavePending = $state(false); let phaseSaveAccepted = $state(false); let phaseRebasePending = $state(false);
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
      if (phaseRebasePending && phaseMutation && revision !== adoptedPhaseRevision) {
        phases = rebasePhaseMutation(catalog.records, phases, phaseMutation, phaseMutationSourceKey);
        adoptedPhaseRevision = revision; phaseRebasePending = false;
      }
      const acceptedRefresh = phaseSaveAccepted && revision !== adoptedPhaseRevision;
      const shouldAdopt = adoptedPhaseRevision === '' || phaseMutation === null || acceptedRefresh;
      if (revision !== adoptedPhaseRevision && shouldAdopt) {
        phases = catalog.records.map(sourceRecordToMutable);
        adoptedPhaseRevision = revision;
        phaseSavePending = false;
        phaseMutation = null;
        phaseMutationSourceKey = null;
        selectedPhaseIndex = null; phaseSaveAccepted = false; phaseRebasePending = false;
      }
    }
  });
  /**
   * Feature 101 (T026, FR-026a) — one lifecycle write, sent and settled.
   *
   * `send` is a thunk rather than a request because the two writers differ in
   * more than payload: a draft save is ungated and a deactivation raises its
   * confirmation inside the helper (FR-049). What they share is this — the
   * pending gate, the refusal handling, and when to stop waiting — so that is
   * what lives here and nothing else does.
   */
  function submitPhaseWrite(send: () => Promise<LifecycleResult>): void {
    if (phaseSavePending) return;
    phaseSavePending = true; phaseSaveAccepted = false;
    void send().then((result) => {
      if (result.status === 'rejected') {
        phaseSavePending = false;
        // Feature 100 (T509b) — the operator closed the removal prompt. Nothing
        // was sent and nothing failed, so no error is reported.
        if (result.reason === 'declined') {
          phaseMutation = null; phaseMutationSourceKey = null;
          return;
        }
        if (result.reason === 'stale-catalog') phaseRebasePending = true;
        showSaveError(formatPhaseSaveRejection(result.reason, result.result));
        return;
      }
      saveError = null;
      phaseSaveAccepted = true;
      // FR-026d — an unchanged save is a success that writes nothing, so the
      // projection will not move and no snapshot is coming. Settle here, or the
      // editor waits on a revision change that never arrives.
      if ((result.result as { appended?: boolean } | undefined)?.appended === false) {
        phaseSavePending = false; phaseSaveAccepted = false;
        phaseMutation = null; phaseMutationSourceKey = null;
      }
    });
  }
  /**
   * FR-026a — save writes a DRAFT of the one edited definition.
   *
   * The whole-layer publish this replaced made an edit live and manufactured a
   * fresh version of every untouched sibling as a side effect (FR-026b, FR-026c).
   * The row is found by source key rather than by id because the id is itself an
   * editable field.
   */
  function savePhaseDraft(): void {
    const catalog = snapshot.phaseCatalog;
    if (!phaseMutation || catalog?.state !== 'ready') return;
    const row = phases.find((candidate) => candidate.sourceKey === phaseMutationSourceKey);
    if (!row) return;
    const record = catalog.records.find((candidate) => candidate.key === row.sourceKey);
    submitPhaseWrite(() =>
      saveDefinitionDraft({
        kind: 'phase',
        id: row.id,
        expectedDraftVersion: draftTokenOfRecord(record),
        body: toSavePhaseRow(row)
      })
    );
  }
  function saveModels(): void {
    void saveModelsHelper(JSON.parse(JSON.stringify(models)));
  }
  let selectedPhaseIndex = $state<number | null>(null);
  let phaseHistory = $state<MutablePhase[][]>([]);
  let phaseHistoryIndex = $state(-1);
  let isPhaseUndoRedoAction = false;
  let editStateById = $state<Record<string, PhaseEditState>>({});
  // Feature 101 (T002) — the row mutations live in `phase-catalog-actions.ts`.
  // Each returns the rows and pending-mutation state its edit leaves behind, or
  // `null` when it refuses; this is the one place that assignment happens.
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
  function movePhase(index: number, target: number): void {
    if (phaseMutation) return;
    applyPhaseEdit(movePhaseRow(phases, index, target, selectedPhaseIndex));
  }
  function stepPhaseHistory(step: number): void {
    isPhaseUndoRedoAction = true;
    phaseHistoryIndex = step;
    phases = phasesAtHistoryStep(phaseHistory, step);
  }
  $effect(() => {
    if (!initialized) return;
    const currentStr = JSON.stringify(phases);
    if (!isPhaseUndoRedoAction) {
      const recorded = withPhaseHistoryEntry(phaseHistory, phaseHistoryIndex, currentStr);
      if (recorded) { phaseHistory = recorded.history; phaseHistoryIndex = recorded.index; }
    }
    isPhaseUndoRedoAction = false;
  });
  // Feature 100 (T509b) — the confirmation moved into `deactivateDefinition`,
  // the only function that can post the command it authorises (FR-049). This
  // handler supplies what the prompt needs to say and no longer asks itself.
  // It stays here rather than moving with the others because it submits.
  //
  // Feature 101 (T026) — removal is still a deactivation and not a draft: a draft
  // changes what the definition WILL be, and this changes whether it runs at all.
  // The proposed row list it used to compute is gone with the whole-layer payload
  // — an omission was how a package expressed a removal, and a package no longer
  // carries this write.
  function removePhase(index: number, originatingElement?: HTMLElement | null): void {
    const phase = phases[index];
    const catalog = snapshot.phaseCatalog;
    if (!phase || !phaseMutationsAllowed || catalog?.state !== 'ready') return;
    const record = catalog.records.find((candidate) => candidate.key === phase.sourceKey);
    phaseMutation = { kind: 'remove', phaseId: phase.id };
    phaseMutationSourceKey = phase.sourceKey;
    submitPhaseWrite(() =>
      deactivateDefinition(
        { kind: 'phase', id: phase.id, expectedDraftVersion: draftTokenOfRecord(record) },
        { definitionName: phase.name, originatingElement: originatingElement ?? null }
      )
    );
  }
  let newModelInput = $state<Record<string, string>>({});
  // The catalog transforms live in `model-catalog-state.ts` beside the seeding
  // and merge rules they share; this is the one binding that needs a body,
  // because an accepted add is also what clears the input box.
  function addModel(backend: string): void {
    const next = withModelAdded(models, backend, newModelInput[backend] ?? '');
    if (!next) return;
    models = next;
    newModelInput[backend] = '';
  }
</script>
<main class="pb" data-testid="pipeline-builder-root">
  <div class="header">
    <h2>Builder</h2>
    <p>Author and manage reusable phases, pipelines, workflows, and models.</p>
    <BuilderTabs {activeTab} onactivate={(tab) => activeTab = tab} />
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
        trusted={pipelineMutationsAllowed}
        {saveError}
        savePending={pipelineStore.savePending}
        mutationActive={pipelineStore.mutationActive}
        editableSourceKey={pipelineStore.mutationSourceKey}
        getPhaseTooltip={(phaseId) => phaseTooltip(effectivePhases, phaseId)}
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
        onaddphase={(phaseId) => pipelineStore.appendPhaseId(phaseId)}
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
        onadd={() => { if (!phaseMutation) applyPhaseEdit(addPhaseRow(phases)); }}
        onremove={removePhase}
        onreset={(index) => applyPhaseEdit(resetPhaseRow(phases, index, snapshot.phaseCatalog?.records))}
        onphasechange={updatePhase}
        onmoveup={(index) => movePhase(index, index - 1)}
        onmovedown={(index) => movePhase(index, index + 1)}
        onundo={() => { if (phaseHistoryIndex > 0) stepPhaseHistory(phaseHistoryIndex - 1); }}
        onredo={() => { if (phaseHistoryIndex < phaseHistory.length - 1) stepPhaseHistory(phaseHistoryIndex + 1); }}
        onsave={savePhaseDraft}
        ondismisssaveerror={() => saveError = null}
        ontoggleraw={(id) => editStateById = withRawJsonToggled(editStateById, id)}
        onrawsave={(index, parsed) => updatePhase(index, parsed as Partial<MutablePhase>)}
        ontoggleretry={(index) => updatePhase(index, retryConditionToggle(phases[index]))}
        onretrychange={(index, e) => updatePhase(index, { retryCondition: e.source })}
        onduplicate={(index) => { if (!phaseMutation) applyPhaseEdit(duplicatePhaseRow(phases, index)); }}
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
        onmodelchange={(backend, index, value) => models = withModelReplaced(models, backend, index, value)}
        onadd={addModel}
        onremove={(backend, index) => models = withModelRemoved(models, backend, index)}
        onsave={saveModels}
        ondetect={(backend) => models = withModelsDetected(
          models, backend, snapshot.availableModels?.[backend as keyof typeof snapshot.availableModels] ?? []
        )}
      />
    {/if}
  </div>
</main>
