<script lang="ts">
  // Feature 083 (US1, T037; US5, T056) — the Workflow Library and its Builder.
  //
  // This file owns the catalog, the lifecycle writes, and the save. The surface
  // itself is a canvas: `WorkflowFlowTopBar` names which Workflow is open and
  // `WorkflowFlowBuilder` holds the palette, the flow, and the inspector — so the
  // identity fields moved into that inspector and the Library list moved into the
  // top bar's picker. Every edit is still one pure call into
  // `workflow-catalog-state.ts` routed through `applyGraphEdit`, so no rule is
  // expressible in this markup or in any of the canvas components below it.
  //
  // `remove` and `reset` are the two destructive writes. Both confirm first, in
  // `workflow-catalog-actions.ts`, where the prompt and the mutation it
  // authorises stay in one scope (T059, FR-035).
  //
  // Rows come from the authoritative `workflowCatalog` projection and nothing
  // else. Every mutating control stays unavailable until that projection
  // arrives (FR-028), while trust says otherwise (FR-029), and — after a
  // submitted save — until a snapshot arrives whose `revision` differs from the
  // one submitted. Waiting on the revision rather than on the ack is what makes
  // the gate honest: the ack says the host accepted the write, the new revision
  // says the projection the operator is looking at reflects it.
  //
  // Feature 099 (T494a, FR-043) — no scope. One layer means one revision, one
  // destination for a save, and no writable-scope picker; a "layer" here is now
  // just the catalog.
  import type {
    BuilderLifecycle,
    PortablePipelineDefinition,
    WorkflowSnapshot
  } from '../../lib/snapshot-types';
  import {
    deactivateDefinition,
    draftTokenOfRecord,
    saveDefinitionDraft,
    type LifecycleResult
  } from '../../lib/catalog-lifecycle';
  import {
    buildWorkflowRemoval,
    makeWorkflowGraphActions,
    takenWorkflowIds,
    withWorkflowDraftEdited
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
  import CatalogEmptyState from '../Builder/CatalogEmptyState.svelte';
  import WorkflowFlowBuilder from './WorkflowFlowBuilder.svelte';
  import WorkflowFlowTopBar from './WorkflowFlowTopBar.svelte';
  import WorkflowToolbar from './WorkflowToolbar.svelte';
  import type { MutableWorkflow } from './types';

  interface Props {
    snapshot: WorkflowSnapshot;
    /** Workspace Trust, resolved host-side; the host re-checks on save. */
    trusted: boolean;
  }

  const { snapshot, trusted }: Props = $props();

  /** Rows the operator created but the host has not accepted yet. */
  let drafts = $state<MutableWorkflow[]>([]);
  let selectedKey = $state<string | null>(null);
  let saveError = $state<string | null>(null);
  /** The revision submitted with the in-flight save; null when none is. */
  let submittedRevision = $state<string | null>(null);

  const catalog = $derived(snapshot.workflowCatalog);
  const ready = $derived(catalog?.state === 'ready');
  const revision = $derived(ready ? (catalog?.revision ?? '') : '');

  const persisted = $derived(
    ready ? (catalog?.records ?? []).map(sourceRecordToMutableWorkflow) : []
  );
  /**
   * Feature 101 (US1, T037, FR-013) — lifecycle facts, keyed by projection
   * record and handed to the list. Deliberately not folded into
   * `sourceRecordToMutableWorkflow`: that function builds the editable copy, and
   * `toSaveWorkflowRow` strips every projection-only field back off it before a
   * save goes out. A lifecycle field there would be one more strip to remember,
   * and the one that got missed would send a projected view field back to the
   * host — exactly what FR-010 forbids.
   */
  const lifecycleByKey = $derived(
    new Map<string, BuilderLifecycle | undefined>(
      (catalog?.records ?? []).map((record) => [record.key, record.lifecycle])
    )
  );
  /**
   * A node may only run a Pipeline the effective catalog resolves, and only the
   * ports that Pipeline declares can be connected. Reading the effective rows
   * rather than the raw ones is the same rule the host applies when it resolves
   * a binding: an invalid Pipeline must not appear authorable here when runtime
   * resolution will not honor it.
   */
  const effectivePipelines = $derived<readonly PortablePipelineDefinition[]>(
    snapshot.pipelineCatalog?.state === 'ready' ? snapshot.pipelineCatalog.effective : []
  );
  /**
   * A node runs a Pipeline, so an empty effective layer leaves a Workflow with
   * nothing to compose (FR-045). Read every pass, never latched, so the first
   * valid Pipeline re-enables the Builder without a reload. Absent is not
   * empty: an unresolved catalog blocks the save but is no evidence that no
   * Pipeline exists, so only the resolved case explains itself.
   */
  const noEffectivePipeline = $derived(effectivePipelines.length === 0);
  const pipelinesResolved = $derived(snapshot.pipelineCatalog?.state === 'ready');
  const rows = $derived<MutableWorkflow[]>([...persisted, ...drafts]);
  const selected = $derived(rows.find((row) => row.sourceKey === selectedKey) ?? null);

  /**
   * A save is in flight until the projection moves. The host's ack is not
   * enough — the operator would be editing against a revision the next save
   * would then be rejected for.
   */
  const savePending = $derived(submittedRevision !== null && revision === submittedRevision);

  $effect(() => {
    // Once the catalog moves, the draft has landed: adopt the host's rows.
    if (submittedRevision !== null && revision !== '' && revision !== submittedRevision) {
      submittedRevision = null;
      drafts = [];
    }
  });

  const draftErrors = $derived<readonly WorkflowDraftError[]>(
    selected
      ? validateWorkflowDraft(
          selected,
          rows
            .filter((row) => row.sourceKey !== selected.sourceKey)
            .map((row) => row.workflowId)
        )
      : []
  );

  /**
   * Host defects and advisory ones share one list, bucketed by the row that has
   * to show them (FR-044). Nothing anchored elsewhere is dropped: `rest` still
   * renders in the summary list below the Builder.
   */
  const defects = $derived(
    selected
      ? anchorWorkflowDefects(
          boundFieldErrors([...selected.sourceErrors, ...draftErrors]).visible,
          selected
        )
      : { byNode: [], byConnection: [], rest: [] }
  );

  const mutatingDisabled = $derived(!trusted || !ready || savePending);
  /**
   * Only an unsaved draft is editable. Editing a stored row in place would
   * need an `edit` mutation and its own revision handling; duplicating it is
   * the path this release offers (FR-026).
   */
  const editable = $derived(selected !== null && !selected.persisted && !mutatingDisabled);
  const saveDisabled = $derived(!editable || draftErrors.length > 0 || noEffectivePipeline);
  /**
   * Duplicate is the one action a stored row offers, so it is gated on trust
   * and readiness only — not on `editable`, which is false for every stored row
   * and would make the control permanently dead exactly where it is needed.
   */
  const duplicateDisabled = $derived(selected === null || mutatingDisabled);
  /**
   * Only a stored row can be removed: a draft has nothing persisted to delete,
   * and discarding it is not a write (FR-026).
   */
  const removeDisabled = $derived(
    selected === null || !selected.persisted || mutatingDisabled
  );

  /** Stage a freshly built draft as the selection; both creation paths end here. */
  function selectNewDraft(draft: MutableWorkflow): void {
    drafts = [...drafts, draft];
    selectedKey = draft.sourceKey;
    saveError = null;
  }

  function addWorkflow(): void {
    if (mutatingDisabled) return;
    selectNewDraft(makeNewWorkflowDraft(takenWorkflowIds(rows)));
  }

  /**
   * Copy the selected row under a free id. The original is untouched — the copy
   * is a new draft, and duplicating is the only way to base a Workflow on one
   * the catalog already holds.
   */
  function duplicateWorkflow(): void {
    if (duplicateDisabled || !selected) return;
    selectNewDraft(makeDuplicateWorkflowDraft(selected, takenWorkflowIds(rows)));
  }

  function patchSelected(patch: Partial<MutableWorkflow>): void {
    if (!selected) return;
    drafts = withWorkflowDraftEdited(drafts, selected.sourceKey, (row) => ({ ...row, ...patch }));
  }

  /**
   * Apply one pure graph edit to the selected draft. Every condition control
   * routes through here, so the rules stay in `workflow-catalog-state.ts` and
   * the markup below stays declarative.
   */
  function applyGraphEdit(edit: (workflow: MutableWorkflow) => MutableWorkflow): void {
    if (!selected || !editable) return;
    drafts = withWorkflowDraftEdited(drafts, selected.sourceKey, edit);
  }

  const graph = makeWorkflowGraphActions(applyGraphEdit, () => effectivePipelines);

  /**
   * The one send path. Feature 101 (T028) — a write names one definition, not the
   * layer: the whole-array publish it replaced made every untouched row live
   * again as a side effect of saving one (FR-026c). `send` is a thunk because a
   * draft save is ungated while a deactivation raises its confirmation inside the
   * helper (FR-049); everything the two share — the pending gate and the refusal
   * handling — is here. `catalog-lifecycle.ts` remains the only module that may
   * name a lifecycle command (`tests/lint/catalog-lifecycle-dispatch.test.ts`).
   */
  async function submit(send: () => Promise<LifecycleResult>): Promise<void> {
    submittedRevision = revision;
    saveError = null;
    const outcome = await send();

    if (outcome.status === 'rejected') {
      // No new revision is coming, so the pending gate has to be released here
      // or every control stays dead until the view is reloaded.
      submittedRevision = null;
      // Feature 100 (T509b) — the operator closed the removal prompt. Nothing was
      // sent and nothing failed, so the banner stays clear.
      if (outcome.reason === 'declined') return;
      saveError = formatWorkflowSaveRejection(
        outcome.reason,
        outcome.result as Parameters<typeof formatWorkflowSaveRejection>[1]
      );
      return;
    }
    // FR-026d — an unchanged save writes no version, so the projection will not
    // move. Release the gate here; the effect above never will.
    if ((outcome.result as { appended?: boolean } | undefined)?.appended === false) {
      submittedRevision = null;
    }
  }

  /** FR-026a — save writes a DRAFT of the one selected Workflow. */
  async function save(): Promise<void> {
    if (saveDisabled || !selected) return;
    const row = selected;
    const record = catalog?.state === 'ready'
      ? catalog.records.find((candidate) => candidate.key === row.sourceKey)
      : undefined;
    await submit(() =>
      saveDefinitionDraft({
        kind: 'workflow',
        id: row.workflowId,
        expectedDraftVersion: draftTokenOfRecord(record),
        body: toSaveWorkflowRow(row)
      })
    );
  }

  /**
   * Feature 100 (T509b) — the confirmation now lives inside
   * `deactivateDefinition`, which raises it before dispatch (FR-049). A declined
   * prompt comes back as a `declined` rejection that `submit` treats as a no-op,
   * so nothing is sent and no error is reported.
   *
   * Feature 101 (T028) — only a stored row can be removed (`removeDisabled`), so
   * the record behind it is what carries the write token.
   */
  async function removeSelected(event: MouseEvent): Promise<void> {
    if (removeDisabled || !selected || catalog?.state !== 'ready') return;
    const row = selected;
    const record = catalog.records.find((candidate) => candidate.key === row.sourceKey);
    const removal = buildWorkflowRemoval({
      row,
      expectedDraftVersion: draftTokenOfRecord(record),
      originatingElement: event.currentTarget as HTMLElement
    });
    await submit(() => deactivateDefinition(removal.request, removal.options));
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
  <WorkflowFlowTopBar
    {rows}
    {selected}
    {selectedKey}
    {lifecycleByKey}
    onselect={(key) => (selectedKey = key)}
  />

  <WorkflowToolbar
    {savePending}
    {mutatingDisabled}
    noPipelines={noEffectivePipeline && pipelinesResolved}
    {duplicateDisabled}
    {removeDisabled}
    {saveDisabled}
    {selected}
    onadd={addWorkflow}
    onduplicate={duplicateWorkflow}
    onremove={removeSelected}
    onsave={save}
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
      <button
        class="save-error-dismiss"
        aria-label="Dismiss Workflow save error"
        onclick={() => (saveError = null)}
      >
        ✕
      </button>
    </div>
  {/if}

  <!-- Feature 101 (US6, T065, FR-032/FR-033) — the front door, and this tab's
       only import entry: the Workflows tab never grew a standalone preflight
       region. Ordered after the trust check by construction — PipelineBuilder
       gates the three definition tabs, so an untrusted workspace never reaches
       here and the guidance can never point at an action that cannot succeed. -->
  <CatalogEmptyState kind="workflow" count={rows.length} />

  {#if selected}
    <WorkflowFlowBuilder
      row={selected}
      pipelines={effectivePipelines}
      {defects}
      {editable}
      {graph}
      onworkflowpatch={patchSelected}
    />
  {:else}
    <div class="catalog-state" data-testid="workflows-no-selection">
      Select a Workflow to view it.
    </div>
  {/if}
{/if}
