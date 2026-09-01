<script lang="ts">
  // The inspector: the fields of whatever the canvas has in focus.
  //
  // The list Builder put the Workflow's identity in a form above the graph and
  // every node and connection field inline on its row. The canvas has no room for
  // either, so all three move here and the selection decides which is showing.
  // `workflow` is the resting selection rather than "nothing selected" — the
  // identity fields have to be reachable without first clicking a node.
  //
  // Holds no rule and sends nothing. Every control calls back into the one gate in
  // `WorkflowCatalogEditor`, which is what refuses the edit when the row is not an
  // editable draft.
  import type {
    BuilderLifecycle,
    PortablePipelineDefinition,
    WorkflowConnection,
    WorkflowNode
  } from '../../lib/snapshot-types';
  import type { AnchoredWorkflowDefects, WorkflowConditionPatch } from './workflow-catalog-state';
  import type { WorkflowFlowSelection } from './workflow-flow-view';
  import type { MutableWorkflow } from './types';
  import DefinitionLifecyclePanel from '../Builder/DefinitionLifecyclePanel.svelte';
  import WorkflowBranchInspector from './WorkflowBranchInspector.svelte';
  import WorkflowRowDefects from './WorkflowRowDefects.svelte';

  interface Props {
    row: MutableWorkflow;
    selection: WorkflowFlowSelection;
    pipelines: readonly PortablePipelineDefinition[];
    defects: AnchoredWorkflowDefects;
    /** False for a stored row: only an unsaved draft is editable (FR-026). */
    editable: boolean;
    /** Feature 186 (US3, T020, D-2) — absent on a host with no catalog store wired. */
    lifecycle?: BuilderLifecycle;
    onworkflowpatch: (patch: Partial<MutableWorkflow>) => void;
    onnodepatch: (index: number, patch: Partial<WorkflowNode>) => void;
    onstarttoggle: (nodeId: string) => void;
    onbranchadd: (nodeId: string) => void;
    onretarget: (
      index: number,
      end: 'from' | 'to',
      patch: { nodeId?: string; portId?: string }
    ) => void;
    onconnectionpatch: (index: number, patch: Partial<WorkflowConnection>) => void;
    onconditiontoggle: (index: number, conditional: boolean) => void;
    onconditionpatch: (index: number, patch: WorkflowConditionPatch) => void;
    onconditionvalue: (index: number, valueIndex: number, text: string) => void;
    onconditionvalueadd: (index: number) => void;
    onconditionvalueremove: (index: number, valueIndex: number) => void;
    onconnectionmove: (index: number, delta: number) => void;
    onconnectionremove: (index: number) => void;
  }

  const p: Props = $props();

  const readonly = $derived(!p.editable);
  const node = $derived(
    p.selection.kind === 'node' ? (p.row.nodes[p.selection.index] ?? null) : null
  );
  const connection = $derived(
    p.selection.kind === 'connection' ? (p.row.connections[p.selection.index] ?? null) : null
  );
  /** The Pipeline the selected node names, for the port reference below it. */
  const nodePipeline = $derived(
    node ? (p.pipelines.find((entry) => entry.pipelineId === node.pipelineId) ?? null) : null
  );
</script>

<div class="wf-inspector" data-testid="workflow-inspector">
  {#if connection && p.selection.kind === 'connection'}
    <WorkflowBranchInspector
      index={p.selection.index}
      {connection}
      nodes={p.row.nodes}
      pipelines={p.pipelines}
      defects={p.defects.byConnection[p.selection.index] ?? []}
      {readonly}
      connectionCount={p.row.connections.length}
      onretarget={p.onretarget}
      onpatch={p.onconnectionpatch}
      onconditiontoggle={p.onconditiontoggle}
      onconditionpatch={p.onconditionpatch}
      onconditionvalue={p.onconditionvalue}
      onconditionvalueadd={p.onconditionvalueadd}
      onconditionvalueremove={p.onconditionvalueremove}
      onmove={p.onconnectionmove}
      onremove={p.onconnectionremove}
    />
  {:else if node && p.selection.kind === 'node'}
    {@const index = p.selection.index}
    <div class="wf-inspector-section" data-testid="workflow-node-inspector-{index}">
      <h3>Node {index + 1}</h3>
      <!-- The identifier is shown, never edited: connections and starts address
           it, which is exactly what makes reorder safe (FR-043). -->
      <span class="wf-inspector-sub" data-testid="workflow-node-inspector-id">{node.nodeId}</span>
      <WorkflowRowDefects
        id="workflow-node-inspector-defects-{index}"
        defects={p.defects.byNode[index] ?? []}
      />

      <label class="wf-field">
        Runs Pipeline
        <select
          class="select-input"
          data-testid="workflow-node-pipeline-select-{index}"
          aria-label="Node {index + 1} runs Pipeline"
          value={node.pipelineId}
          disabled={readonly}
          onchange={(event) => p.onnodepatch(index, { pipelineId: event.currentTarget.value })}
        >
          <!-- A Pipeline the node names but the effective catalog does not hold
               still has to be selectable, or changing anything else on the node
               would silently retarget it. -->
          {#if !p.pipelines.some((entry) => entry.pipelineId === node.pipelineId)}
            <option value={node.pipelineId}>{node.pipelineId} (not effective)</option>
          {/if}
          {#each p.pipelines as pipeline (pipeline.pipelineId)}
            <option value={pipeline.pipelineId}>{pipeline.name}</option>
          {/each}
        </select>
      </label>

      <label class="wf-field">
        Label
        <input
          class="text-input"
          data-testid="workflow-node-label-{index}"
          aria-label="Node {index + 1} label"
          value={node.label ?? ''}
          {readonly}
          placeholder={node.nodeId}
          oninput={(event) => p.onnodepatch(index, { label: event.currentTarget.value })}
        />
      </label>

      <label class="checkbox-field">
        <input
          type="checkbox"
          data-testid="workflow-node-start-{index}"
          aria-label="Node {index + 1} may start the Workflow"
          checked={p.row.startNodeIds.includes(node.nodeId)}
          disabled={readonly}
          onchange={() => p.onstarttoggle(node.nodeId)}
        />
        <span class="form-label">May start the Workflow</span>
      </label>

      {#if nodePipeline}
        <div class="row-ports" data-testid="workflow-node-ports-{index}">
          <span class="form-label">Ports</span>
          {#each nodePipeline.inputs as port (port.portId)}
            <span class="wf-badge">in {port.portId}</span>
          {/each}
          {#each nodePipeline.outputs as port (port.portId)}
            <span class="wf-badge">out {port.portId}</span>
          {/each}
        </div>
      {/if}

      {#if !readonly}
        <!-- A split is another connection leaving this node, not a node of its
             own, so it is authored from the node it leaves. -->
        <button
          class="btn btn-secondary"
          data-testid="workflow-node-branch-add-{index}"
          onclick={() => p.onbranchadd(node.nodeId)}>Add branch from this node</button
        >
      {/if}
    </div>
  {:else}
    <div class="wf-inspector-section" data-testid="workflow-settings-inspector">
      <h3>Workflow</h3>
      <label class="wf-field">
        Identifier
        <input
          class="text-input"
          data-testid="workflow-field-workflowId"
          value={p.row.workflowId}
          readonly={p.row.persisted || readonly}
          oninput={(event) => p.onworkflowpatch({ workflowId: event.currentTarget.value })}
        />
      </label>
      <label class="wf-field">
        Name
        <input
          class="text-input"
          data-testid="workflow-field-name"
          value={p.row.name}
          {readonly}
          oninput={(event) => p.onworkflowpatch({ name: event.currentTarget.value })}
        />
      </label>
      <label class="wf-field">
        Description
        <textarea
          class="text-area"
          data-testid="workflow-field-description"
          value={p.row.description ?? ''}
          {readonly}
          oninput={(event) => p.onworkflowpatch({ description: event.currentTarget.value })}
        ></textarea>
      </label>
      <div class="phase-badges">
        <span class="status-badge status-{p.row.sourceStatus}">{p.row.sourceStatus}</span>
      </div>

      <!-- Feature 186 (US3, T020, D-1, D-2) — the open Workflow's lifecycle
           facts and actions, reachable without opening the picker (FR-001,
           FR-002). Mounted only in this resting branch: a selected node or
           connection is part of the Workflow, not the open definition itself. -->
      <DefinitionLifecyclePanel
        kind="workflow"
        definitionId={p.row.workflowId}
        definitionName={p.row.name || 'Untitled Workflow'}
        lifecycle={p.lifecycle}
        defects={p.row.sourceErrors}
      />

      <!-- Only what no node and no branch could show: anything anchored to one of
           those renders on it (FR-044), and repeating it here would make this the
           place to read defects instead. -->
      {#if p.defects.rest.length > 0}
        <ul class="field-errors" data-testid="workflow-field-errors" role="alert">
          {#each p.defects.rest as defect (defect.field + defect.code)}
            <li>{defect.field}: {defect.message}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
