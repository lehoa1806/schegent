<script lang="ts">
  // Feature 083 / 264 / 326 — the unified Workflows tab: switches between the
  // searchable Workflows list (`WorkflowCatalogList`) and the full-page Canvas
  // Editor (`WorkflowFlowBuilder`), owning catalog projection, per-workflow
  // undo/redo/discard history, breadcrumb drill-down, export modal, and saves.
  import { onDestroy } from 'svelte';
  import type {
    BuilderLifecycle, PortablePhaseDefinition, PortablePipelineDefinition, PortableWorkflowDefinition, WorkflowSnapshot
  } from '../../lib/snapshot-types';
  import type { WorkflowExportInclusion } from '../../lib/messages';
  import { exportWorkflowYaml } from '../../lib/process-yaml-ipc';
  import {
    deactivateDefinition, draftTokenOfRecord, saveDefinitionDraft,
    type CatalogWriteWait, type LifecycleResult
  } from '../../lib/catalog-lifecycle';
  import {
    buildWorkflowRemoval, makeWorkflowGraphActions, mergeWorkflowRows, pushWorkflowHistory,
    stepWorkflowHistory, takenWorkflowIds, withWorkflowDraftEdited, type WorkflowHistoryTrack
  } from './workflow-catalog-actions';
  import {
    formatWorkflowSaveRejection, makeDuplicateWorkflowDraft, makeNewWorkflowDraft,
    sourceRecordToMutableWorkflow, toSaveWorkflowRow, validateWorkflowDraft,
    visibleWorkflowDefects, type WorkflowDraftError
  } from './workflow-catalog-state';
  import { reselectIndex, type DefinitionIdentity } from '../../lib/builder-selection';
  import { hydrateWorkflowSlice, readPersistedBuilderState, writePersistedWorkflowSlice } from '../../lib/builder-webview-state';
  import WorkflowCatalogList from './WorkflowCatalogList.svelte';
  import WorkflowExportDialog from './WorkflowExportDialog.svelte';
  import WorkflowFlowBuilder from './WorkflowFlowBuilder.svelte';
  import WorkflowFlowTopBar, { type WorkflowBreadcrumbEntry } from './WorkflowFlowTopBar.svelte';
  import WorkflowToolbar from './WorkflowToolbar.svelte';
  import { hasUnresolvedWorkflowNodes, type WorkflowStatusView } from './workflow-catalog-view';
  import type { MutableWorkflow } from './types';

  interface Props {
    snapshot: WorkflowSnapshot;
    /** Workspace Trust + primacy, resolved host-side; the host re-checks on save. */
    trusted: boolean;
    initialWorkflowId?: string | null;
    importDisabledReason?: string | null;
    onopenphase?: (phaseId: string) => void;
    onopenimport?: (originatingElement: HTMLElement | null) => void;
    oneditorchange?: (open: boolean) => void;
    ondirtychange?: (state: { readonly dirty: boolean; readonly savePending: boolean }) => void;
    oninitialworkflowconsumed?: () => void;
  }

  const {
    snapshot,
    trusted,
    initialWorkflowId = null,
    importDisabledReason = null,
    onopenphase,
    onopenimport,
    oneditorchange,
    ondirtychange,
    oninitialworkflowconsumed
  }: Props = $props();

  const initialWfSlice = (() => {
    const raw = readPersistedBuilderState()?.workflowSlice;
    return raw ? hydrateWorkflowSlice(raw, snapshot) : null;
  })();
  let drafts = $state<MutableWorkflow[]>(initialWfSlice?.drafts ?? []);
  let editedByKey = $state<Record<string, MutableWorkflow>>(initialWfSlice?.editedByKey ?? {});
  let historyByKey = $state<Record<string, WorkflowHistoryTrack>>(initialWfSlice?.historyByKey ?? {});
  let breadcrumbs = $state<WorkflowBreadcrumbEntry[]>(initialWfSlice?.breadcrumbs ?? []);
  let selectedKey = $state<string | null>(initialWfSlice?.selectedKey ?? null);
  let selectedId = $state<string | null>(initialWfSlice?.selectedId ?? null);
  let restoredNodeId = $state<string | null>(initialWfSlice?.restoredNodeId ?? null);
  let saveError = $state<string | null>(null);
  let submittedRevision = $state<string | null>(null);
  let submittedKey = $state<string | null>(null);
  let query = $state('');
  let view = $state<WorkflowStatusView>('all');
  let returnFocusKey: string | null = null;
  let exportInclusion = $state<WorkflowExportInclusion>('references-only');
  let exportTarget = $state<{
    readonly workflowId: string;
    readonly name: string;
    readonly originatingElement: HTMLElement | null;
  } | null>(null);

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
  const hasBuildingBlocks = $derived(effectivePhases.length > 0 || effectivePipelines.length > 0);
  const buildingBlocksResolved = $derived(
    snapshot.phaseCatalog?.state === 'ready' || snapshot.pipelineCatalog?.state === 'ready'
  );
  const noBuildingBlocks = $derived(!hasBuildingBlocks);
  const rows = $derived<MutableWorkflow[]>(mergeWorkflowRows(persisted, editedByKey, drafts));
  const selected = $derived(rows.find((row) => row.sourceKey === selectedKey) ?? null);
  const dirtyKeys = $derived(
    new Set<string>([
      ...drafts.map((draft) => draft.sourceKey),
      ...Object.keys(editedByKey)
    ])
  );
  const hasDirtyWorkflows = $derived(dirtyKeys.size > 0);
  const isSelectedDirty = $derived(selected !== null && dirtyKeys.has(selected.sourceKey));
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
    oneditorchange?.(ready && selected !== null);
  });

  $effect(() => {
    ondirtychange?.({ dirty: hasDirtyWorkflows, savePending });
  });
  onDestroy(() => {
    ondirtychange?.({ dirty: hasDirtyWorkflows, savePending: false });
  });

  $effect(() => {
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
    select(index === null ? null : rows[index].sourceKey, index !== null);
  });

  let appliedInitialWorkflowId: string | null = null;
  $effect(() => {
    if (!initialWorkflowId) {
      appliedInitialWorkflowId = null;
      return;
    }
    if (!ready || appliedInitialWorkflowId === initialWorkflowId) return;
    appliedInitialWorkflowId = initialWorkflowId;
    const target = rows.find((row) => row.workflowId === initialWorkflowId);
    if (target) select(target.sourceKey);
    oninitialworkflowconsumed?.();
  });

  function identity(row: MutableWorkflow): DefinitionIdentity {
    return { sourceKey: row.sourceKey, id: row.workflowId };
  }
  function takeReturnFocus(): string | null {
    const key = returnFocusKey;
    returnFocusKey = null;
    return key;
  }
  function select(key: string | null, preserveBreadcrumbs = false, fromNode: string | null = null): void {
    selectedKey = key;
    selectedId = key === null ? null : (rows.find((row) => row.sourceKey === key)?.workflowId ?? selectedId);
    restoredNodeId = fromNode;
    if (!preserveBreadcrumbs) breadcrumbs = [];
  }
  function closeEditor(): void {
    returnFocusKey = selected?.sourceKey ?? null;
    select(null);
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
      hasUnresolvedWorkflowNodes(selected.nodes, effectivePhases, effectiveWorkflows, effectivePipelines, rows)
  );
  const defects = $derived(
    selected ? visibleWorkflowDefects(selected, draftErrors) : { byNode: [], byConnection: [], rest: [], hiddenChecks: 0 }
  );
  const mutatingDisabled = $derived(!trusted || !ready || savePending);
  const editable = $derived(selected !== null && !mutatingDisabled);
  const saveDisabled = $derived(!editable || !isSelectedDirty || draftErrors.length > 0 || noBuildingBlocks || draftNodesUnresolved);
  const duplicateDisabled = $derived(selected === null || mutatingDisabled);
  const removeDisabled = $derived(selected === null || !selected.persisted || mutatingDisabled);

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
  function duplicateWorkflowByKey(sourceKey: string): void {
    if (mutatingDisabled) return;
    const target = rows.find((row) => row.sourceKey === sourceKey);
    if (!target) return;
    selectNewDraft(makeDuplicateWorkflowDraft(target, takenWorkflowIds(rows)));
  }
  function duplicateWorkflow(): void {
    if (duplicateDisabled || !selected) return;
    duplicateWorkflowByKey(selected.sourceKey);
  }
  function applyRowEdit(edit: (workflow: MutableWorkflow) => MutableWorkflow): void {
    if (!selected || !editable) return;
    const current = selected;
    const next = edit(current);
    if (next === current || JSON.stringify(next) === JSON.stringify(current)) return;
    historyByKey = pushWorkflowHistory(historyByKey, current.sourceKey, current, next);
    if (current.persisted) editedByKey = { ...editedByKey, [current.sourceKey]: next };
    else drafts = withWorkflowDraftEdited(drafts, current.sourceKey, () => next);
  }
  function patchSelected(patch: Partial<MutableWorkflow>): void {
    applyRowEdit((row) => ({ ...row, ...patch }));
  }
  function undoSelected(): void {
    if (!selected || !canUndo) return;
    const stepped = stepWorkflowHistory(historyByKey, selected.sourceKey, -1);
    if (!stepped) return;
    historyByKey = stepped.nextHistory;
    if (selected.persisted) editedByKey = { ...editedByKey, [selected.sourceKey]: stepped.workflow };
    else drafts = withWorkflowDraftEdited(drafts, selected.sourceKey, () => stepped.workflow);
  }
  function redoSelected(): void {
    if (!selected || !canRedo) return;
    const stepped = stepWorkflowHistory(historyByKey, selected.sourceKey, 1);
    if (!stepped) return;
    historyByKey = stepped.nextHistory;
    if (selected.persisted) editedByKey = { ...editedByKey, [selected.sourceKey]: stepped.workflow };
    else drafts = withWorkflowDraftEdited(drafts, selected.sourceKey, () => stepped.workflow);
  }
  function resetSelected(): void {
    if (!selected || !canReset || mutatingDisabled) return;
    const nextEdited = { ...editedByKey };
    delete nextEdited[selected.sourceKey];
    editedByKey = nextEdited;
    const nextHistory = { ...historyByKey };
    delete nextHistory[selected.sourceKey];
    historyByKey = nextHistory;
  }

  const graph = makeWorkflowGraphActions(
    applyRowEdit,
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
        { kind: 'workflow', id: row.workflowId, expectedDraftVersion: draftTokenOfRecord(record), body: toSaveWorkflowRow(row) },
        undefined,
        wait
      )
    );
  }

  async function removeRow(row: MutableWorkflow, originatingElement: HTMLElement | null): Promise<void> {
    if (mutatingDisabled || !row.persisted || catalog?.state !== 'ready') return;
    const record = catalog.records.find((candidate) => candidate.key === row.sourceKey);
    const removal = buildWorkflowRemoval({
      row,
      expectedDraftVersion: draftTokenOfRecord(record),
      originatingElement: originatingElement ?? document.body
    });
    await submit(row.sourceKey, (wait) =>
      deactivateDefinition(removal.request, { ...removal.options, wait })
    );
  }

  function openExportFor(row: MutableWorkflow, originatingElement: HTMLElement | null): void {
    if (!row.persisted) return;
    exportTarget = { workflowId: row.workflowId, name: row.name || row.workflowId, originatingElement };
  }

  function confirmExport(): void {
    if (!exportTarget) return;
    exportWorkflowYaml(exportTarget.workflowId, exportInclusion);
    exportTarget = null;
  }
</script>

{#snippet notices()}
  {#if catalog?.state === 'ready' && catalog.warnings.length > 0}
    <div class="attn warn" role="status" aria-live="polite" data-testid="workflow-catalog-warnings">
      <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
      <div class="body">
        {#each catalog.warnings as warning (warning.code + warning.message)}
          <div>{warning.message}</div>
        {/each}
      </div>
    </div>
  {/if}
  {#if saveError}
    <div class="attn" data-testid="workflow-save-error-banner" role="alert">
      <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
      <div class="body">Save rejected: {saveError}</div>
      <button type="button" class="icon-btn" aria-label="Dismiss Workflow save error" onclick={() => (saveError = null)}><svg class="i" aria-hidden="true"><use href="#i-x"></use></svg></button>
    </div>
  {/if}
{/snippet}

{#if !catalog}
  <div class="catalog-state" role="status" aria-live="polite" aria-busy="true" data-testid="workflow-catalog-loading">
    Loading authoritative Workflow catalog…
  </div>
{:else if catalog.state === 'error'}
  <div class="catalog-state catalog-error" role="alert" data-testid="workflow-catalog-error">
    {catalog.error?.message ?? 'The Workflow catalog could not be loaded. Reload the view to retry.'}
  </div>
{:else if selected}
  <div
    class="editor"
    data-testid="workflow-catalog-editor"
    data-selected-workflow-id={selected.workflowId}
  >
    <div class="ed-head">
      <WorkflowFlowTopBar
        {rows}
        {selected}
        {selectedKey}
        {lifecycleByKey}
        dirty={isSelectedDirty}
        {breadcrumbs}
        onselect={(key) => select(key)}
        onbreadcrumbselect={selectBreadcrumb}
        onclose={closeEditor}
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
        onduplicate={duplicateWorkflow}
        onremove={(event) => void removeRow(selected, event.currentTarget instanceof HTMLElement ? event.currentTarget : null)}
        onsave={save}
        onundo={undoSelected}
        onredo={redoSelected}
        onreset={resetSelected}
        onopenexport={(origin) => openExportFor(selected, origin)}
      />
    </div>
    {@render notices()}
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
  </div>
{:else}
  <WorkflowCatalogList
    {rows}
    {lifecycleByKey}
    {dirtyKeys}
    {mutatingDisabled}
    {importDisabledReason}
    bind:query
    bind:view
    {takeReturnFocus}
    {notices}
    onselect={(key) => select(key)}
    onadd={addWorkflow}
    onduplicate={duplicateWorkflowByKey}
    onexport={openExportFor}
    onremove={removeRow}
    {onopenimport}
  />
{/if}

{#if exportTarget}
  <WorkflowExportDialog
    workflowId={exportTarget.workflowId}
    workflowName={exportTarget.name}
    inclusion={exportInclusion}
    originatingElement={exportTarget.originatingElement}
    oninclusionchange={(value) => (exportInclusion = value)}
    onconfirm={confirmExport}
    oncancel={() => (exportTarget = null)}
  />
{/if}
