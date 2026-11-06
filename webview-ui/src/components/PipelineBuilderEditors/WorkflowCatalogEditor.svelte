<script lang="ts">
  // Feature 083 / 264 (FR-R5-F05) — the unified Workflow Library and Builder.
  //
  // Owns the catalog projection, per-workflow undo/redo/discard history,
  // hierarchy breadcrumb navigation, lifecycle writes, and draft saves.
  import type {
    BuilderLifecycle,
    PortablePhaseDefinition,
    PortablePipelineDefinition,
    PortableWorkflowDefinition,
    WorkflowSnapshot
  } from '../../lib/snapshot-types';
  import {
    deactivateDefinition,
    draftTokenOfRecord,
    saveDefinitionDraft,
    type CatalogWriteWait,
    type LifecycleResult
  } from '../../lib/catalog-lifecycle';
  import {
    buildWorkflowRemoval,
    makeWorkflowGraphActions,
    mergeWorkflowRows,
    pushWorkflowHistory,
    stepWorkflowHistory,
    takenWorkflowIds,
    withWorkflowDraftEdited,
    type WorkflowHistoryTrack
  } from './workflow-catalog-actions';
  import {
    anchorWorkflowDefects,
    boundFieldErrors,
    formatWorkflowSaveRejection,
    makeDuplicateWorkflowDraft,
    makeNewWorkflowDraft,
    sourceRecordToMutableWorkflow,
    toSaveWorkflowRow,
    validateWorkflowDraft,
    type WorkflowDraftError
  } from './workflow-catalog-state';
  import { reselectIndex, type DefinitionIdentity } from '../../lib/builder-selection';
  import {
    hydrateWorkflowSlice,
    readPersistedBuilderState,
    writePersistedWorkflowSlice
  } from '../../lib/builder-webview-state';
  import CatalogEmptyState from '../Builder/CatalogEmptyState.svelte';
  import ProcessImportPreflight from '../ProcessImport/ProcessImportPreflight.svelte';
  import {
    importDisabledReason,
    storedWritableLayers
  } from '../ProcessImport/process-exchange-entry';
  import WorkflowFlowBuilder from './WorkflowFlowBuilder.svelte';
  import WorkflowFlowTopBar, { type WorkflowBreadcrumbEntry } from './WorkflowFlowTopBar.svelte';
  import WorkflowToolbar from './WorkflowToolbar.svelte';
  import type { MutableWorkflow } from './types';

  interface Props {
    snapshot: WorkflowSnapshot;
    /** Workspace Trust, resolved host-side; the host re-checks on save. */
    trusted: boolean;
    initialWorkflowId?: string | null;
    onopenphase?: (phaseId: string) => void;
  }

  const { snapshot, trusted, initialWorkflowId = null, onopenphase }: Props = $props();
  // svelte-ignore state_referenced_locally
  const initialWfSlice = (() => {
    const raw = readPersistedBuilderState()?.workflowSlice;
    return raw ? hydrateWorkflowSlice(raw, snapshot) : null;
  })();
  /** Rows the operator created but the host has not accepted yet. */
  let drafts = $state<MutableWorkflow[]>(initialWfSlice?.drafts ?? []);
  /** In-place edits to persisted Workflows, keyed by `sourceKey`. */
  let editedByKey = $state<Record<string, MutableWorkflow>>(initialWfSlice?.editedByKey ?? {});
  /** Per-Workflow undo/redo stacks, keyed by `sourceKey`. */
  let historyByKey = $state<Record<string, WorkflowHistoryTrack>>(initialWfSlice?.historyByKey ?? {});
  /** Breadcrumb trail when drilling into child Workflows. */
  let breadcrumbs = $state<WorkflowBreadcrumbEntry[]>(initialWfSlice?.breadcrumbs ?? []);
  let selectedKey = $state<string | null>(initialWfSlice?.selectedKey ?? null);
  let selectedId = $state<string | null>(initialWfSlice?.selectedId ?? null);
  let restoredNodeId = $state<string | null>(initialWfSlice?.restoredNodeId ?? null);
  let saveError = $state<string | null>(null);
  /** The revision submitted with the in-flight save; null when none is. */
  let submittedRevision = $state<string | null>(null);
  let submittedKey = $state<string | null>(null);

  const catalog = $derived(snapshot.workflowCatalog);
  const ready = $derived(catalog?.state === 'ready');
  const revision = $derived(ready ? (catalog?.revision ?? '') : '');

  const persisted = $derived(
    ready ? (catalog?.records ?? []).map(sourceRecordToMutableWorkflow) : []
  );
  const lifecycleByKey = $derived(
    new Map<string, BuilderLifecycle | undefined>(
      (catalog?.records ?? []).map((record) => [record.key, record.lifecycle])
    )
  );
  const effectivePhases = $derived<readonly PortablePhaseDefinition[]>(
    snapshot.phaseCatalog?.state === 'ready' ? snapshot.phaseCatalog.effective : []
  );
  const effectiveWorkflows = $derived<readonly PortableWorkflowDefinition[]>(
    snapshot.workflowCatalog?.state === 'ready' ? snapshot.workflowCatalog.effective : []
  );
  const effectivePipelines = $derived<readonly PortablePipelineDefinition[]>(
    snapshot.pipelineCatalog?.state === 'ready' ? snapshot.pipelineCatalog.effective : []
  );
  const hasBuildingBlocks = $derived(
    effectivePhases.length > 0 || effectivePipelines.length > 0
  );
  const buildingBlocksResolved = $derived(
    snapshot.phaseCatalog?.state === 'ready' || snapshot.pipelineCatalog?.state === 'ready'
  );
  const noBuildingBlocks = $derived(!hasBuildingBlocks);
  const rows = $derived<MutableWorkflow[]>(mergeWorkflowRows(persisted, editedByKey, drafts));
  const selected = $derived(rows.find((row) => row.sourceKey === selectedKey) ?? null);
  const isSelectedDirty = $derived(
    selected !== null && (!selected.persisted || selected.sourceKey in editedByKey)
  );
  const selectedHistory = $derived(
    selected && selected.sourceKey in historyByKey ? historyByKey[selected.sourceKey] : null
  );
  const canUndo = $derived(selectedHistory !== null && selectedHistory.index > 0);
  const canRedo = $derived(
    selectedHistory !== null && selectedHistory.index < selectedHistory.snapshots.length - 1
  );
  const canReset = $derived(
    selected !== null && selected.persisted && selected.sourceKey in editedByKey
  );

  const savePending = $derived(submittedRevision !== null && revision === submittedRevision);

  $effect(() => {
    // Once the catalog moves, clear only the saved row's draft/edit state so unsaved parents stay intact.
    if (submittedRevision !== null && revision !== '' && revision !== submittedRevision) {
      const key = submittedKey;
      submittedRevision = null;
      submittedKey = null;
      if (key !== null) {
        drafts = drafts.filter((d) => d.sourceKey !== key);
        const { [key]: _ed, ...restEdited } = editedByKey;
        editedByKey = restEdited;
        const { [key]: _hist, ...restHist } = historyByKey;
        historyByKey = restHist;
      } else {
        drafts = [];
        editedByKey = {};
        historyByKey = {};
      }
    }
  });

  $effect(() => {
    if (!ready) return;
    writePersistedWorkflowSlice({
      adoptedRevision: revision,
      drafts,
      editedByKey,
      historyByKey,
      selectedKey,
      selectedId,
      breadcrumbs,
      restoredNodeId
    });
  });

  $effect(() => {
    if (selectedKey === null) return;
    if (rows.some((row) => row.sourceKey === selectedKey)) return;
    const index = reselectIndex(rows, { sourceKey: selectedKey, id: selectedId ?? '' }, identity);
    select(index === null ? null : rows[index].sourceKey, true);
  });

  let appliedInitialWorkflowId: string | null = null;
  $effect(() => {
    if (!initialWorkflowId) {
      appliedInitialWorkflowId = null;
      return;
    }
    if (appliedInitialWorkflowId === initialWorkflowId) return;
    const target = rows.find((row) => row.workflowId === initialWorkflowId);
    if (!target) return;
    appliedInitialWorkflowId = initialWorkflowId;
    select(target.sourceKey);
  });

  function identity(row: MutableWorkflow): DefinitionIdentity {
    return { sourceKey: row.sourceKey, id: row.workflowId };
  }
  function select(key: string | null, preserveBreadcrumbs = false, fromNode: string | null = null): void {
    selectedKey = key;
    selectedId = key === null ? null : (rows.find((row) => row.sourceKey === key)?.workflowId ?? selectedId);
    restoredNodeId = fromNode;
    if (!preserveBreadcrumbs) breadcrumbs = [];
  }
  function openChildWorkflow(workflowId: string, fromNodeId?: string): void {
    const target = rows.find((row) => row.workflowId === workflowId);
    if (!target || !selected) return;
    breadcrumbs = [
      ...breadcrumbs,
      { sourceKey: selected.sourceKey, workflowId: selected.workflowId, name: selected.name || selected.workflowId, ...(fromNodeId ? { fromNodeId } : {}) }
    ];
    select(target.sourceKey, true, null);
  }
  function selectBreadcrumb(index: number): void {
    if (index < 0 || index >= breadcrumbs.length) return;
    const crumb = breadcrumbs[index];
    breadcrumbs = breadcrumbs.slice(0, index);
    select(crumb.sourceKey, true, crumb.fromNodeId ?? null);
  }
  const draftErrors = $derived<readonly WorkflowDraftError[]>(
    selected ? validateWorkflowDraft(selected, rows.filter((row) => row.sourceKey !== selected.sourceKey).map((row) => row.workflowId)) : []
  );
  const draftNodesUnresolved = $derived(
    selected !== null &&
      selected.nodes.some((node) => {
        if (node.phaseId) return !effectivePhases.some((phase) => phase.phaseId === node.phaseId);
        if (node.workflowId) return !effectiveWorkflows.some((wf) => wf.workflowId === node.workflowId) && !rows.some((row) => row.workflowId === node.workflowId);
        if (node.pipelineId) return !effectivePipelines.some((pipe) => pipe.pipelineId === node.pipelineId);
        return false;
      })
  );
  const defects = $derived(
    selected ? anchorWorkflowDefects(boundFieldErrors([...selected.sourceErrors, ...draftErrors]).visible, selected) : { byNode: [], byConnection: [], rest: [] }
  );
  const mutatingDisabled = $derived(!trusted || !ready || savePending);
  const editable = $derived(selected !== null && !mutatingDisabled);
  const saveDisabled = $derived(!editable || !isSelectedDirty || draftErrors.length > 0 || noBuildingBlocks || draftNodesUnresolved);
  const duplicateDisabled = $derived(selected === null || mutatingDisabled);
  const removeDisabled = $derived(selected === null || !selected.persisted || mutatingDisabled);
  const importLayers = $derived(storedWritableLayers(snapshot.phaseCatalog?.records ?? [], snapshot.workflowCatalog?.records ?? []));
  const importUnavailable = $derived(importDisabledReason({ trusted, savePending, mutationActive: isSelectedDirty || drafts.length > 0 }));

  function selectNewDraft(draft: MutableWorkflow): void {
    drafts = [...drafts, draft];
    historyByKey = pushWorkflowHistory(historyByKey, draft.sourceKey, draft, draft);
    select(draft.sourceKey);
    saveError = null;
  }

  function addWorkflow(): void {
    if (mutatingDisabled) return;
    selectNewDraft(makeNewWorkflowDraft(takenWorkflowIds(rows)));
  }

  function duplicateWorkflow(): void {
    if (duplicateDisabled || !selected) return;
    selectNewDraft(makeDuplicateWorkflowDraft(selected, takenWorkflowIds(rows)));
  }

  function applyRowEdit(edit: (workflow: MutableWorkflow) => MutableWorkflow): void {
    if (!selected || !editable) return;
    const current = selected;
    const next = edit(current);
    historyByKey = pushWorkflowHistory(historyByKey, current.sourceKey, current, next);
    if (current.persisted) {
      editedByKey = { ...editedByKey, [current.sourceKey]: next };
    } else {
      drafts = withWorkflowDraftEdited(drafts, current.sourceKey, () => next);
    }
  }

  function patchSelected(patch: Partial<MutableWorkflow>): void {
    applyRowEdit((row) => ({ ...row, ...patch }));
  }

  function applyGraphEdit(edit: (workflow: MutableWorkflow) => MutableWorkflow): void {
    applyRowEdit(edit);
  }

  function undoSelected(): void {
    if (!selected || !canUndo) return;
    const stepped = stepWorkflowHistory(historyByKey, selected.sourceKey, -1);
    if (!stepped) return;
    historyByKey = stepped.nextHistory;
    if (selected.persisted) {
      editedByKey = { ...editedByKey, [selected.sourceKey]: stepped.workflow };
    } else {
      drafts = withWorkflowDraftEdited(drafts, selected.sourceKey, () => stepped.workflow);
    }
  }

  function redoSelected(): void {
    if (!selected || !canRedo) return;
    const stepped = stepWorkflowHistory(historyByKey, selected.sourceKey, 1);
    if (!stepped) return;
    historyByKey = stepped.nextHistory;
    if (selected.persisted) {
      editedByKey = { ...editedByKey, [selected.sourceKey]: stepped.workflow };
    } else {
      drafts = withWorkflowDraftEdited(drafts, selected.sourceKey, () => stepped.workflow);
    }
  }

  function resetSelected(): void {
    if (!selected || !canReset) return;
    const nextEdited = { ...editedByKey };
    delete nextEdited[selected.sourceKey];
    editedByKey = nextEdited;
    const nextHistory = { ...historyByKey };
    delete nextHistory[selected.sourceKey];
    historyByKey = nextHistory;
  }

  const graph = makeWorkflowGraphActions(
    applyGraphEdit,
    () => effectivePipelines,
    () => effectivePhases,
    () => effectiveWorkflows
  );

  const lifetime = new AbortController();
  $effect(() => () => lifetime.abort());
  function showLateWrite(late: LifecycleResult): void {
    saveError = late.status === 'rejected' && late.reason !== 'declined'
      ? formatWorkflowSaveRejection(late.reason, late.result as Parameters<typeof formatWorkflowSaveRejection>[1])
      : null;
  }

  async function submit(
    targetKey: string | null,
    send: (wait: CatalogWriteWait) => Promise<LifecycleResult>
  ): Promise<void> {
    submittedRevision = revision;
    submittedKey = targetKey;
    saveError = null;
    const outcome = await send({ signal: lifetime.signal, onLateOutcome: showLateWrite });

    if (outcome.status === 'rejected') {
      submittedRevision = null;
      submittedKey = null;
      if (outcome.reason === 'declined') return;
      saveError = formatWorkflowSaveRejection(
        outcome.reason,
        outcome.result as Parameters<typeof formatWorkflowSaveRejection>[1]
      );
      return;
    }
    if ((outcome.result as { appended?: boolean } | undefined)?.appended === false) {
      submittedRevision = null;
      submittedKey = null;
    }
  }

  async function save(): Promise<void> {
    if (saveDisabled || !selected) return;
    const row = selected;
    const record = catalog?.state === 'ready'
      ? catalog.records.find((candidate) => candidate.key === row.sourceKey)
      : undefined;
    await submit(row.sourceKey, (wait) =>
      saveDefinitionDraft(
        {
          kind: 'workflow',
          id: row.workflowId,
          expectedDraftVersion: draftTokenOfRecord(record),
          body: toSaveWorkflowRow(row)
        },
        undefined,
        wait
      )
    );
  }

  async function removeSelected(event: MouseEvent): Promise<void> {
    if (removeDisabled || !selected || catalog?.state !== 'ready') return;
    const row = selected;
    const record = catalog.records.find((candidate) => candidate.key === row.sourceKey);
    const removal = buildWorkflowRemoval({
      row,
      expectedDraftVersion: draftTokenOfRecord(record),
      originatingElement: event.currentTarget as HTMLElement
    });
    await submit(row.sourceKey, (wait) =>
      deactivateDefinition(removal.request, { ...removal.options, wait })
    );
  }
</script>

{#if !catalog}
  <div
    class="catalog-state"
    role="status"
    aria-live="polite"
    aria-busy="true"
    data-testid="workflow-catalog-loading"
  >
    Loading authoritative Workflow catalog…
  </div>
{:else if catalog.state === 'error'}
  <div class="catalog-state catalog-error" role="alert" data-testid="workflow-catalog-error">
    {catalog.error?.message ??
      'The Workflow catalog could not be loaded. Reload the view to retry.'}
  </div>
{:else}
  <div
    data-testid="workflow-catalog-editor"
    data-selected-workflow-id={selected?.workflowId ?? undefined}
  >
    <WorkflowFlowTopBar
      {rows}
      {selected}
      {selectedKey}
      {lifecycleByKey}
      dirty={isSelectedDirty}
      {breadcrumbs}
      onselect={(key) => select(key)}
      onbreadcrumbselect={selectBreadcrumb}
    />

    <WorkflowToolbar
      {savePending}
      {mutatingDisabled}
      noPipelines={noBuildingBlocks && buildingBlocksResolved}
      {duplicateDisabled}
      {removeDisabled}
      {saveDisabled}
      {canUndo}
      {canRedo}
      {canReset}
      {selected}
      onadd={addWorkflow}
      onduplicate={duplicateWorkflow}
      onremove={removeSelected}
      onsave={save}
      onundo={undoSelected}
      onredo={redoSelected}
      onreset={resetSelected}
    />

    {#if catalog.warnings.length > 0}
      <div class="catalog-warning" role="status" aria-live="polite" data-testid="workflow-catalog-warnings">
        {#each catalog.warnings as warning (warning.code + warning.message)}
          <div>{warning.message}</div>
        {/each}
      </div>
    {/if}

    {#if saveError}
      <div class="save-error-banner" data-testid="workflow-save-error-banner" role="alert">
        <span class="save-error-text">Save rejected: {saveError}</span>
        <button class="save-error-dismiss" aria-label="Dismiss Workflow save error" onclick={() => (saveError = null)}>✕</button>
      </div>
    {/if}

    <CatalogEmptyState kind="workflow" count={rows.length} disabledReason={importUnavailable} />
    {#if rows.length > 0}
      <ProcessImportPreflight layers={importLayers} disabledReason={importUnavailable} />
    {/if}

    {#if selected}
      <WorkflowFlowBuilder
        row={selected}
        pipelines={effectivePipelines}
        phases={effectivePhases}
        workflows={effectiveWorkflows}
        allWorkflows={rows}
        {defects}
        {editable}
        {graph}
        lifecycle={lifecycleByKey.get(selected.sourceKey)}
        {restoredNodeId}
        onworkflowpatch={patchSelected}
        onopenworkflow={openChildWorkflow}
        {onopenphase}
      />
    {:else}
      <div class="catalog-state" data-testid="workflows-no-selection">
        Select a Workflow to view it.
      </div>
    {/if}
  </div>
{/if}
