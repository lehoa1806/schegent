<script lang="ts">
  // The canvas Builder's three panes, and the selection that ties them together.
  //
  // Palette on the left, flow in the middle, inspector on the right — the
  // reference design's layout. This file owns exactly two pieces of state, both of
  // them view state that no host projection can supply: what is selected, and
  // whether the palette is showing.
  //
  // Selection resets when the open Workflow changes. Indices address the authored
  // arrays, so a selection carried across rows would point at a different node —
  // or at nothing — in the new one, and the inspector would render fields for it.
  //
  // Every edit goes out through `graph`, the same `WorkflowGraphActions` bundle the
  // list Builder used, so the rules still live in `workflow-catalog-state.ts` and
  // no rule is expressible in this markup.
  import type { BuilderLifecycle, PortablePipelineDefinition } from '../../lib/snapshot-types';
  import type { AnchoredWorkflowDefects } from './workflow-catalog-state';
  import type { WorkflowGraphActions } from './workflow-catalog-actions';
  import type { WorkflowFlowSelection } from './workflow-flow-view';
  import type { MutableWorkflow } from './types';
  import WorkflowActionPalette from './WorkflowActionPalette.svelte';
  import WorkflowFlowCanvas from './WorkflowFlowCanvas.svelte';
  import WorkflowInspector from './WorkflowInspector.svelte';

  interface Props {
    row: MutableWorkflow;
    pipelines: readonly PortablePipelineDefinition[];
    defects: AnchoredWorkflowDefects;
    /** False for a stored row: only an unsaved draft is editable (FR-026). */
    editable: boolean;
    graph: WorkflowGraphActions;
    /**
     * Feature 186 (US3, T021, D-2) — the actual mount site for `WorkflowInspector`
     * is here, not in `WorkflowCatalogEditor` directly, so the prop crosses this
     * intermediate component before it reaches it.
     */
    lifecycle?: BuilderLifecycle;
    onworkflowpatch: (patch: Partial<MutableWorkflow>) => void;
  }

  const p: Props = $props();

  let selection = $state<WorkflowFlowSelection>({ kind: 'workflow' });
  let paletteOpen = $state(true);
  let openedKey = $state<string | null>(null);

  $effect(() => {
    if (openedKey === p.row.sourceKey) return;
    openedKey = p.row.sourceKey;
    selection = { kind: 'workflow' };
  });

  /**
   * The node a Logic action applies to. Read from the row every pass rather than
   * latched: a removal shifts every later index, and a stale id would send the
   * next split to whichever node moved into the slot.
   */
  const selectedNodeId = $derived(
    selection.kind === 'node' ? (p.row.nodes[selection.index]?.nodeId ?? null) : null
  );

  /**
   * Removing a node removes what the inspector was showing. Falling back to the
   * Workflow is the only honest answer — keeping the index would show the node
   * that shifted into the slot as though the operator had selected it.
   */
  function removeNode(index: number): void {
    p.graph.removeNode(index);
    selection = { kind: 'workflow' };
  }

  function removeConnection(index: number): void {
    p.graph.removeConnection(index);
    selection = { kind: 'workflow' };
  }
</script>

<div class="wf-shell" data-testid="workflow-flow-builder">
  {#if paletteOpen}
    <WorkflowActionPalette
      pipelines={p.pipelines}
      readonly={!p.editable}
      {selectedNodeId}
      onaddnode={p.graph.addNodeRunning}
      onbranchadd={p.graph.addBranch}
      onclose={() => (paletteOpen = false)}
    />
  {:else}
    <div class="wf-palette-rail" data-testid="workflow-palette-rail">
      <button
        class="icon-btn"
        data-testid="workflow-palette-open"
        aria-label="Show the Actions palette"
        onclick={() => (paletteOpen = true)}>›</button
      >
    </div>
  {/if}

  <WorkflowFlowCanvas
    nodes={p.row.nodes}
    connections={p.row.connections}
    startNodeIds={p.row.startNodeIds}
    pipelines={p.pipelines}
    nodeDefects={p.defects.byNode}
    connectionDefects={p.defects.byConnection}
    readonly={!p.editable}
    {selection}
    onselect={(next) => (selection = next)}
    oninsertafter={p.graph.insertAfter}
    onsplice={p.graph.spliceInto}
    onnodemove={p.graph.moveNode}
    onnoderemove={removeNode}
    onbranchadd={p.graph.addBranch}
  />

  <WorkflowInspector
    row={p.row}
    {selection}
    pipelines={p.pipelines}
    defects={p.defects}
    editable={p.editable}
    lifecycle={p.lifecycle}
    onworkflowpatch={p.onworkflowpatch}
    onnodepatch={p.graph.patchNode}
    onstarttoggle={p.graph.toggleStartNode}
    onbranchadd={p.graph.addBranch}
    onretarget={p.graph.retargetConnection}
    onconnectionpatch={p.graph.patchConnection}
    onconditiontoggle={p.graph.toggleCondition}
    onconditionpatch={p.graph.patchCondition}
    onconditionvalue={p.graph.setConditionValue}
    onconditionvalueadd={p.graph.addConditionValue}
    onconditionvalueremove={p.graph.removeConditionValue}
    onconnectionmove={p.graph.moveConnection}
    onconnectionremove={removeConnection}
  />
</div>
