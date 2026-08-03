<script lang="ts">
  // Feature 083 (US1, T037; US5, T056) — the Workflow Library and its Builder.
  //
  // This file owns the list, the identity fields, and the save; every graph row
  // lives in `WorkflowGraphEditor` so both stay inside the 500-line Svelte
  // budget. Every edit is one pure call into `workflow-catalog-state.ts` routed
  // through `applyGraphEdit`, so no rule is expressible in this markup.
  //
  // `remove` and `reset` are the two destructive writes. Both confirm first, in
  // `workflow-catalog-actions.ts`, where the prompt and the mutation it
  // authorises stay in one scope (T059, FR-035).
  //
  // Rows come from the authoritative `workflowCatalog` projection and nothing
  // else. Every mutating control stays unavailable until that projection
  // arrives (FR-028), while trust says otherwise (FR-029), and — after a
  // submitted save — until a snapshot arrives whose `revisions[scope]` differs
  // from the one submitted. Waiting on the revision rather than on the ack is
  // what makes the gate honest: the ack says the host accepted the write, the
  // new revision says the projection the operator is looking at reflects it.
  import type {
    PortablePipelineDefinition,
    WorkflowNode,
    WorkflowSnapshot,
    WritableWorkflowDefinitionScope
  } from '../../lib/snapshot-types';
  import { saveWorkflows, type SaveWorkflowsRequest } from '../../lib/save-workflows';
  import {
    confirmWorkflowLayerReset,
    confirmWorkflowRemoval
  } from './workflow-catalog-actions';
  import {
    addWorkflowConditionValue,
    addWorkflowConnection,
    addWorkflowNode,
    anchorWorkflowDefects,
    boundFieldErrors,
    formatWorkflowSaveRejection,
    makeDuplicateWorkflowDraft,
    makeNewWorkflowDraft,
    makeWorkflowCondition,
    makeWorkflowConnectionDraft,
    makeWorkflowNodeDraft,
    moveWorkflowConnection,
    moveWorkflowNode,
    parseWorkflowConditionLiteral,
    removeWorkflowConditionValue,
    removeWorkflowConnection,
    removeWorkflowNode,
    retargetWorkflowConnection,
    sourceRecordToMutableWorkflow,
    toggleWorkflowStartNode,
    toSaveWorkflowRow,
    updateWorkflowCondition,
    updateWorkflowConditionValue,
    updateWorkflowConnection,
    updateWorkflowNode,
    validateWorkflowDraft,
    type WorkflowConditionPatch,
    type WorkflowDraftError
  } from './workflow-catalog-state';
  import WorkflowGraphEditor from './WorkflowGraphEditor.svelte';
  import WorkflowLibraryList from './WorkflowLibraryList.svelte';
  import WorkflowToolbar from './WorkflowToolbar.svelte';
  import type { MutableWorkflow } from './types';

  const WRITABLE_SCOPES: readonly WritableWorkflowDefinitionScope[] = ['workspace', 'user'];

  interface Props {
    snapshot: WorkflowSnapshot;
    /** `workflowOverrides`, resolved host-side; the host re-checks on save. */
    trusted: boolean;
  }

  const { snapshot, trusted }: Props = $props();

  let scope = $state<WritableWorkflowDefinitionScope>('workspace');
  /** Rows the operator created but the host has not accepted yet. */
  let drafts = $state<MutableWorkflow[]>([]);
  let selectedKey = $state<string | null>(null);
  let saveError = $state<string | null>(null);
  /** The revision submitted with the in-flight save; null when none is. */
  let submittedRevision = $state<string | null>(null);

  const catalog = $derived(snapshot.workflowCatalog);
  const ready = $derived(catalog?.state === 'ready');
  const revision = $derived(ready ? (catalog?.revisions[scope] ?? '') : '');

  const persisted = $derived(
    ready ? (catalog?.records ?? []).map(sourceRecordToMutableWorkflow) : []
  );
  /**
   * A node may only run a Pipeline the effective catalog resolves, and only the
   * ports that Pipeline declares can be connected. Reading the effective layer
   * rather than the raw rows is the same rule the host applies when it resolves
   * a binding: a shadowed or invalid Pipeline must not appear authorable here
   * when runtime resolution will not honor it.
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
    // Once the layer moves, the draft has landed: adopt the host's rows.
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
            .filter((row) => row.scope === selected.scope && row.sourceKey !== selected.sourceKey)
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
   * need an `edit` mutation and its own revision handling; duplicating it into
   * a writable scope is the path this release offers (FR-026).
   */
  const editable = $derived(selected !== null && !selected.persisted && !mutatingDisabled);
  const saveDisabled = $derived(!editable || draftErrors.length > 0 || noEffectivePipeline);
  /**
   * Duplicate is the one action a built-in row offers, so it is gated on trust
   * and readiness only — not on `editable`, which is false for every stored row
   * and would make the control permanently dead exactly where it is needed.
   */
  const duplicateDisabled = $derived(selected === null || mutatingDisabled);
  /**
   * Only a stored row in a writable scope can be removed. A draft has nothing
   * persisted to delete — discarding it is not a write — and a built-in row is
   * read-only (FR-026).
   */
  const removeDisabled = $derived(
    selected === null || !selected.persisted || selected.scope === 'built-in' || mutatingDisabled
  );

  function scopeIdsFor(target: WritableWorkflowDefinitionScope): readonly string[] {
    return rows.filter((row) => row.scope === target).map((row) => row.workflowId);
  }

  function addWorkflow(): void {
    if (mutatingDisabled) return;
    const draft = makeNewWorkflowDraft(scope, scopeIdsFor(scope));
    drafts = [...drafts, draft];
    selectedKey = draft.sourceKey;
    saveError = null;
  }

  /**
   * Copy the selected row into the writable scope the picker names, under an id
   * free in that scope. The original is untouched — the copy is a new draft, and
   * a duplicate of a built-in row is the only way to base a Workflow on one.
   */
  function duplicateWorkflow(): void {
    if (duplicateDisabled || !selected) return;
    const draft = makeDuplicateWorkflowDraft(selected, scope, scopeIdsFor(scope));
    drafts = [...drafts, draft];
    selectedKey = draft.sourceKey;
    saveError = null;
  }

  function patchSelected(patch: Partial<MutableWorkflow>): void {
    if (!selected) return;
    const key = selected.sourceKey;
    drafts = drafts.map((row) => (row.sourceKey === key ? { ...row, ...patch } : row));
  }

  /**
   * Apply one pure graph edit to the selected draft. Every condition control
   * routes through here, so the rules stay in `workflow-catalog-state.ts` and
   * the markup below stays declarative.
   */
  function applyGraphEdit(edit: (workflow: MutableWorkflow) => MutableWorkflow): void {
    if (!selected || !editable) return;
    const key = selected.sourceKey;
    drafts = drafts.map((row) => (row.sourceKey === key ? edit(row) : row));
  }

  /**
   * Turn one connection conditional, or unconditional again. The seed reads the
   * connection's own source node: FR-023 bounds a condition to the branching
   * node or an ancestor, and the branching node always qualifies.
   */
  function toggleCondition(index: number, conditional: boolean): void {
    applyGraphEdit((workflow) => {
      const connection = workflow.connections[index];
      if (!connection) return workflow;
      return updateWorkflowConnection(workflow, index, {
        condition: conditional ? makeWorkflowCondition(connection.from.nodeId) : undefined
      });
    });
  }

  const addNode = (): void =>
    applyGraphEdit((workflow) => {
      const pipelineId = effectivePipelines[0]?.pipelineId;
      return pipelineId === undefined
        ? workflow
        : addWorkflowNode(workflow, makeWorkflowNodeDraft(workflow, pipelineId));
    });

  const removeNode = (index: number): void =>
    applyGraphEdit((workflow) => removeWorkflowNode(workflow, index));

  const moveNode = (index: number, delta: number): void =>
    applyGraphEdit((workflow) => moveWorkflowNode(workflow, index, delta));

  const patchNode = (index: number, patch: Partial<WorkflowNode>): void =>
    applyGraphEdit((workflow) => updateWorkflowNode(workflow, index, patch));

  const toggleStartNode = (nodeId: string): void =>
    applyGraphEdit((workflow) => toggleWorkflowStartNode(workflow, nodeId));

  const addConnection = (): void =>
    applyGraphEdit((workflow) =>
      addWorkflowConnection(workflow, makeWorkflowConnectionDraft(workflow, effectivePipelines))
    );

  const removeConnection = (index: number): void =>
    applyGraphEdit((workflow) => removeWorkflowConnection(workflow, index));

  const moveConnection = (index: number, delta: number): void =>
    applyGraphEdit((workflow) => moveWorkflowConnection(workflow, index, delta));

  const retargetConnection = (
    index: number,
    end: 'from' | 'to',
    patch: { nodeId?: string; portId?: string }
  ): void =>
    applyGraphEdit((workflow) =>
      retargetWorkflowConnection(workflow, index, end, patch, effectivePipelines)
    );

  const patchCondition = (index: number, patch: WorkflowConditionPatch): void =>
    applyGraphEdit((workflow) => updateWorkflowCondition(workflow, index, patch));

  const setConditionValue = (index: number, valueIndex: number, text: string): void =>
    applyGraphEdit((workflow) =>
      updateWorkflowConditionValue(workflow, index, valueIndex, parseWorkflowConditionLiteral(text))
    );

  /**
   * The one send path. Every write is the whole target layer, not one row: the
   * Workflow save command is all-or-nothing, so a partial payload would
   * silently delete every row it omitted. The `saveWorkflows` helper is the
   * only way to send it — the lint gate in
   * `tests/lint/no-inline-save-catalog.test.ts` fails any component that names
   * the command itself.
   */
  async function submit(request: SaveWorkflowsRequest): Promise<void> {
    submittedRevision = request.expectedRevision;
    saveError = null;
    const outcome = await saveWorkflows(request);

    if (outcome.status === 'rejected') {
      // No new revision is coming, so the pending gate has to be released here
      // or every control stays dead until the view is reloaded.
      submittedRevision = null;
      saveError = formatWorkflowSaveRejection(
        outcome.reason,
        outcome.result as Parameters<typeof formatWorkflowSaveRejection>[1]
      );
    }
  }

  function layerOf(target: WritableWorkflowDefinitionScope): MutableWorkflow[] {
    return rows.filter((row) => row.scope === target);
  }

  async function save(): Promise<void> {
    if (saveDisabled || !selected) return;
    const target = selected.scope;
    // Narrowing, not a guard against a reachable state: only a draft is
    // saveable here and a draft is always created in a writable scope.
    if (target === 'built-in') return;
    await submit({
      scope: target,
      expectedRevision: catalog?.revisions[target] ?? '',
      mutation: { kind: 'create', workflowId: selected.workflowId },
      workflows: layerOf(target).map(toSaveWorkflowRow)
    });
  }

  /**
   * Removal and reset both confirm before they build anything, in
   * `workflow-catalog-actions.ts`. A declined prompt returns null and nothing
   * is sent — including the pending gate, which is only raised by `submit`.
   *
   * The layer passed in is the **stored** one, not `rows`: an unsaved draft is
   * not part of what the host holds, and carrying one along would make the
   * write an add and a remove at once. The host's intent algebra refuses that,
   * so the removal would fail for a reason unrelated to the removal.
   */
  async function removeSelected(event: MouseEvent): Promise<void> {
    if (removeDisabled || !selected) return;
    const target = selected.scope;
    if (target === 'built-in') return;
    const request = await confirmWorkflowRemoval({
      row: selected,
      scope: target,
      expectedRevision: catalog?.revisions[target] ?? '',
      layer: persisted.filter((row) => row.scope === target),
      originatingElement: event.currentTarget as HTMLElement
    });
    if (request) await submit(request);
  }

  async function resetLayer(event: MouseEvent): Promise<void> {
    if (mutatingDisabled) return;
    const request = await confirmWorkflowLayerReset({
      scope,
      expectedRevision: catalog?.revisions[scope] ?? '',
      // Stored rows only: a draft is not yet a definition in this scope, so
      // counting it would overstate what the reset actually deletes.
      workflowCount: persisted.filter((row) => row.scope === scope).length,
      originatingElement: event.currentTarget as HTMLElement
    });
    if (request) await submit(request);
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
  <WorkflowToolbar
    {scope}
    scopes={WRITABLE_SCOPES}
    {savePending}
    {mutatingDisabled}
    noPipelines={noEffectivePipeline && pipelinesResolved}
    {duplicateDisabled}
    {removeDisabled}
    {saveDisabled}
    onscope={(next) => (scope = next)}
    onadd={addWorkflow}
    onduplicate={duplicateWorkflow}
    onremove={removeSelected}
    onreset={resetLayer}
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

  <div class="split-pane">
    <div class="pane-left">
      <WorkflowLibraryList {rows} {selectedKey} onselect={(key) => (selectedKey = key)} />
    </div>

    <div class="pane-right">
      {#if selected}
        {@const row = selected}
        <label class="field">
          Identifier
          <input
            data-testid="workflow-field-workflowId"
            value={row.workflowId}
            readonly={row.persisted}
            disabled={!editable}
            oninput={(event) => patchSelected({ workflowId: event.currentTarget.value })}
          />
        </label>
        <label class="field">
          Name
          <input
            data-testid="workflow-field-name"
            value={row.name}
            disabled={!editable}
            oninput={(event) => patchSelected({ name: event.currentTarget.value })}
          />
        </label>
        <label class="field">
          Description
          <textarea
            data-testid="workflow-field-description"
            value={row.description ?? ''}
            disabled={!editable}
            oninput={(event) => patchSelected({ description: event.currentTarget.value })}
          ></textarea>
        </label>
        <div class="phase-badges">
          <span class="scope-badge">{row.scope}</span>
          <span class="status-badge status-{row.sourceStatus}">{row.sourceStatus}</span>
        </div>

        <WorkflowGraphEditor
          nodes={row.nodes}
          connections={row.connections}
          startNodeIds={row.startNodeIds}
          pipelines={effectivePipelines}
          nodeDefects={defects.byNode}
          connectionDefects={defects.byConnection}
          readonly={!editable}
          onnodeadd={addNode}
          onnoderemove={removeNode}
          onnodemove={moveNode}
          onnodepatch={patchNode}
          onstarttoggle={toggleStartNode}
          onconnectionadd={addConnection}
          onconnectionremove={removeConnection}
          onconnectionmove={moveConnection}
          onconnectionretarget={retargetConnection}
          onconditiontoggle={toggleCondition}
          onconditionpatch={patchCondition}
          onconditionvalue={setConditionValue}
          onconditionvalueadd={(index) =>
            applyGraphEdit((workflow) => addWorkflowConditionValue(workflow, index))}
          onconditionvalueremove={(index, valueIndex) =>
            applyGraphEdit((workflow) => removeWorkflowConditionValue(workflow, index, valueIndex))}
        />

        <!-- Only what no row could show: everything anchored to a node or a
             connection already renders on that row (FR-044), and repeating it
             here would make the summary the place to read defects instead. -->
        {#if defects.rest.length > 0}
          <ul class="field-errors" data-testid="workflow-field-errors" role="alert">
            {#each defects.rest as defect (defect.field + defect.code)}
              <li>{defect.field}: {defect.message}</li>
            {/each}
          </ul>
        {/if}
      {:else}
        <div class="catalog-state" data-testid="workflows-no-selection">
          Select a Workflow to view it.
        </div>
      {/if}
    </div>
  </div>
{/if}
