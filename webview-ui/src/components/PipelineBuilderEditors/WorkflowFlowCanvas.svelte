<script lang="ts">
  // The canvas: lanes of flow, laid out by `workflow-flow-layout.ts`.
  //
  // This file assembles the view bundle and renders one subtree per root. It
  // decides nothing about placement — that is the layout module's job, and the
  // split is what lets the placement rules be tested without mounting anything.
  //
  // Two lanes, not one. Nodes reachable from a start are the flow; nodes no start
  // reaches are `unreachable-node` defects, and they render BELOW under their own
  // heading rather than being hidden. A canvas that draws only the reachable graph
  // would hide the very node the operator has to connect or delete to make the
  // save pass, with the host's defect pointing at something invisible.
  import type { PortablePipelineDefinition, WorkflowConnection, WorkflowNode } from '../../lib/snapshot-types';
  import { buildWorkflowFlowLayout, type FlowNodeSlot } from './workflow-flow-layout';
  import type { WorkflowFlowSelection, WorkflowFlowView } from './workflow-flow-view';
  import type { WorkflowDraftError } from './workflow-catalog-state';
  import WorkflowFlowSubtree from './WorkflowFlowSubtree.svelte';

  interface Props {
    nodes: readonly WorkflowNode[];
    connections: readonly WorkflowConnection[];
    startNodeIds: readonly string[];
    pipelines: readonly PortablePipelineDefinition[];
    /** Both indexed alongside their authored list; see `anchorWorkflowDefects`. */
    nodeDefects: readonly (readonly WorkflowDraftError[])[];
    connectionDefects: readonly (readonly WorkflowDraftError[])[];
    readonly: boolean;
    selection: WorkflowFlowSelection | null;
    onselect: (selection: WorkflowFlowSelection) => void;
    oninsertafter: (nodeId: string) => void;
    onsplice: (connectionIndex: number) => void;
    onnodemove: (index: number, delta: number) => void;
    onnoderemove: (index: number) => void;
    onbranchadd: (nodeId: string) => void;
  }

  const props: Props = $props();

  const layout = $derived(
    buildWorkflowFlowLayout({
      nodes: props.nodes,
      connections: props.connections,
      startNodeIds: props.startNodeIds
    })
  );

  /** Every placed slot, so an arm can find the subtree its target renders as. */
  const slotsById = $derived(
    new Map<string, FlowNodeSlot>(
      [...layout.slots, ...layout.detached].map((slot) => [slot.nodeId, slot])
    )
  );

  /** Pre-order means a root is exactly a slot the walk entered at depth 0. */
  const roots = $derived(layout.slots.filter((slot) => slot.depth === 0));
  const detachedRoots = $derived(layout.detached.filter((slot) => slot.depth === 0));

  const view = $derived<WorkflowFlowView>({
    nodes: props.nodes,
    slotsById,
    pipelines: props.pipelines,
    nodeDefects: props.nodeDefects,
    connectionDefects: props.connectionDefects,
    cycleNodeIds: layout.cycleNodeIds,
    readonly: props.readonly,
    selection: props.selection,
    onselect: props.onselect,
    oninsertafter: props.oninsertafter,
    onsplice: props.onsplice,
    onnodemove: props.onnodemove,
    onnoderemove: props.onnoderemove,
    onbranchadd: props.onbranchadd
  });
</script>

<div class="wf-canvas" data-testid="workflow-canvas">
  {#if props.nodes.length === 0}
    <div class="empty-selection" data-testid="workflow-canvas-empty">
      No nodes yet. Add one from Actions.
    </div>
  {:else}
    <div class="wf-lanes">
      {#if roots.length > 0}
        <div class="wf-lane" data-testid="workflow-lane-flow">
          {#each roots as slot (slot.nodeId)}
            <WorkflowFlowSubtree {view} {slot} />
          {/each}
        </div>
      {/if}

      {#if detachedRoots.length > 0}
        <div class="wf-lane" data-testid="workflow-lane-detached">
          <!-- Says what is wrong AND why it matters: an unreachable node blocks
               the save, and "not connected" alone does not convey that. -->
          <span class="wf-lane-note is-defect" data-testid="workflow-lane-detached-note">
            {roots.length === 0
              ? 'No start node is set, so nothing below can run. Select a node and mark it a start.'
              : 'Reachable from no start. Connect these or remove them before saving.'}
          </span>
          {#each detachedRoots as slot (slot.nodeId)}
            <WorkflowFlowSubtree {view} {slot} />
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
