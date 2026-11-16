<script lang="ts">
  // The canvas Builder's three panes, and the selection that ties them together.
  //
  // The "Add steps" palette on the left, flow in the middle, inspector on the
  // right, inside the redesign's `.shell` (sg-builder.css). This file owns exactly
  // two pieces of state, both of them view state that no host projection can
  // supply: what is selected, and whether the palette is collapsed to its rail.
  //
  // Selection resets when the open Workflow changes. Indices address the authored
  // arrays, so a selection carried across rows would point at a different node —
  // or at nothing — in the new one, and the inspector would render fields for it.
  //
  // Every edit goes out through `graph`, the same `WorkflowGraphActions` bundle the
  // list Builder used, so the rules still live in `workflow-catalog-state.ts` and
  // no rule is expressible in this markup.
  //
  // What the operator does on the canvas is said on the dashboard's status line, as
  // the workflow builder mockup's editor says it: what is now selected, what an add
  // put on the canvas, and what a delete took away. A move says where the step now
  // stands in the saved order, which its card most often does not show. The effect
  // below says nothing, because the operator did not make that change.
  //
  // Escape, a press on the canvas's ground (WorkflowFlowCanvas) and the inspector's
  // back button show the Workflow again, the first two as in the mockup. Focus on
  // the fields the inspector takes away goes back to the card or the arm that was
  // selected.
  import { tick } from 'svelte';
  import { statusLine } from '../../lib/status-line.svelte';
  import type {
    BuilderLifecycle,
    PortablePhaseDefinition,
    PortablePipelineDefinition,
    PortableWorkflowDefinition
  } from '../../lib/snapshot-types';
  import type { AnchoredWorkflowDefects, WorkflowNodeTarget } from './workflow-catalog-state';
  import type { WorkflowGraphActions } from './workflow-catalog-actions';
  import {
    connectionName,
    moveAnnouncement,
    nodeTitle,
    selectionAfterMove,
    selectionAnnouncement,
    type WorkflowFlowSelection
  } from './workflow-flow-view';
  import type { MutableWorkflow } from './types';
  import WorkflowActionPalette from './WorkflowActionPalette.svelte';
  import WorkflowFlowCanvas from './WorkflowFlowCanvas.svelte';
  import WorkflowInspector from './WorkflowInspector.svelte';

  interface Props {
    row: MutableWorkflow;
    pipelines: readonly PortablePipelineDefinition[];
    phases?: readonly PortablePhaseDefinition[];
    workflows?: readonly PortableWorkflowDefinition[];
    allWorkflows?: readonly MutableWorkflow[];
    defects: AnchoredWorkflowDefects;
    /** False when trust, readiness, or an in-flight save blocks mutation. */
    editable: boolean;
    graph: WorkflowGraphActions;
    /**
     * Feature 186 (US3, T021, D-2) — the actual mount site for `WorkflowInspector`
     * is here, not in `WorkflowCatalogEditor` directly, so the prop crosses this
     * intermediate component before it reaches it.
     */
    lifecycle?: BuilderLifecycle;
    restoredNodeId?: string | null;
    onworkflowpatch: (patch: Partial<MutableWorkflow>) => void;
    onopenworkflow?: (workflowId: string, fromNodeId?: string) => void;
    onopenphase?: (phaseId: string) => void;
  }

  const p: Props = $props();

  let selection = $state<WorkflowFlowSelection>({ kind: 'workflow' });
  let paletteOpen = $state(true);
  let openedKey = $state<string | null>(null);

  $effect(() => {
    if (openedKey === p.row.sourceKey) return;
    openedKey = p.row.sourceKey;
    const restoredIdx = p.restoredNodeId
      ? p.row.nodes.findIndex((node) => node.nodeId === p.restoredNodeId)
      : -1;
    selection = restoredIdx >= 0 ? { kind: 'node', index: restoredIdx } : { kind: 'workflow' };
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
   * The head's Undo button, in `WorkflowToolbar`. A delete takes the button that
   * was pressed away with what it deleted, and Undo is where the mockup sends
   * focus next, since it brings the deleted item back.
   */
  const UNDO_BUTTON_ID = 'wf-undo';

  /**
   * The selected card's or arm's button: the canvas reports the selection as the
   * one button it holds pressed.
   */
  const SELECTED_ON_CANVAS = '.canvas-wrap button[aria-pressed="true"]';

  /** WorkflowCatalogEditor's root, which holds the editor's head as well as these panes. */
  const EDITOR_ROOT = '.editor';

  let shell = $state<HTMLDivElement | undefined>(undefined);

  function select(next: WorkflowFlowSelection): void {
    selection = next;
    statusLine.announce(selectionAnnouncement(p.row.nodes, p.row.connections, next));
  }

  /**
   * Back to the Workflow, from Escape or the inspector's back button. The
   * inspector swaps the step's or the branch's fields for the Workflow's, so focus
   * on one of them, or on the back button, would fall to the page: it goes back to
   * the card or the arm that was selected, where the operator came from. Focus
   * that survives, on the canvas or in the palette, stays where it is, and nothing
   * is said when the Workflow already shows.
   */
  async function showWorkflow(): Promise<void> {
    if (selection.kind === 'workflow') return;
    const selected = shell?.querySelector<HTMLElement>(SELECTED_ON_CANVAS) ?? null;
    const focusWasInside = shell?.contains(document.activeElement) === true;
    select({ kind: 'workflow' });
    await tick();
    const focusStayed = shell?.contains(document.activeElement) === true;
    if (focusWasInside && !focusStayed && selected?.isConnected === true) selected.focus();
  }

  /**
   * Escape shows the Workflow again, as in the mockup, unless something nearer
   * already answered it (an open menu, the export panel, the open Workflow list, a
   * confirmation dialog) or it was pressed outside the Workflow editor. The key's
   * own work is left alone, so the palette's search field still clears.
   */
  function showWorkflowOnEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
    const target = event.target;
    const editor = shell?.closest(EDITOR_ROOT) ?? shell;
    const inEditor =
      target === document.body || (target instanceof Node && editor?.contains(target) === true);
    if (inEditor) void showWorkflow();
  }

  /**
   * Every add appends: a step goes to the end of the authored list, and an arm to
   * the end of the connections (`workflow-catalog-state.ts`). So whatever the row
   * gained is what was added, and a refused add (no Phase or Pipeline for a `+` to
   * run, a source that is gone) gains nothing and says nothing.
   */
  async function announceAdded(add: () => void): Promise<void> {
    const nodeCount = p.row.nodes.length;
    const connectionCount = p.row.connections.length;
    add();
    await tick();
    const node = p.row.nodes.length > nodeCount ? p.row.nodes.at(-1) : undefined;
    if (node) {
      statusLine.announce(`Added ${nodeTitle(node)}.`);
      return;
    }
    const connection =
      p.row.connections.length > connectionCount ? p.row.connections.at(-1) : undefined;
    if (connection) statusLine.announce(`Added ${connectionName(p.row.nodes, connection)}.`);
  }

  function addNode(target: WorkflowNodeTarget): void {
    void announceAdded(() => p.graph.addNodeRunning(target));
  }

  function insertAfter(nodeId: string): void {
    void announceAdded(() => p.graph.insertAfter(nodeId));
  }

  function splice(connectionIndex: number): void {
    void announceAdded(() => p.graph.spliceInto(connectionIndex));
  }

  function addBranch(nodeId: string): void {
    void announceAdded(() => p.graph.addBranch(nodeId));
  }

  async function announceDeleted(name: string): Promise<void> {
    statusLine.announce(`Deleted ${name}. Undo restores it.`);
    await tick();
    const undo = document.getElementById(UNDO_BUTTON_ID);
    if (undo instanceof HTMLButtonElement && !undo.disabled) undo.focus();
  }

  /**
   * Removing a node removes what the inspector was showing. Falling back to the
   * Workflow is the only honest answer — keeping the index would show the node
   * that shifted into the slot as though the operator had selected it.
   */
  function removeNode(index: number): void {
    const node = p.row.nodes.at(index);
    p.graph.removeNode(index);
    selection = { kind: 'workflow' };
    if (node) void announceDeleted(nodeTitle(node));
  }

  function removeConnection(index: number): void {
    const connection = p.row.connections.at(index);
    const name = connection ? connectionName(p.row.nodes, connection) : null;
    p.graph.removeConnection(index);
    selection = { kind: 'workflow' };
    if (name !== null) void announceDeleted(name);
  }

  /**
   * Reorder runs from the selected card's toolbar, so the selection has to go
   * where the node went. Left on the old index, the inspector and the toolbar
   * would jump to the node that moved into its place.
   */
  function moveNode(index: number, delta: number): void {
    const count = p.row.nodes.length;
    const nodeId = p.row.nodes.at(index)?.nodeId;
    p.graph.moveNode(index, delta);
    selection = selectionAfterMove(selection, index, delta, count);
    if (nodeId !== undefined) void announceMoved(nodeId, index);
  }

  /**
   * A move changes the step's place in the saved order, and the canvas places the
   * steps a run can reach by their connections, so the card most often stays put.
   * The line says where the step went once the row holds it there; a move that
   * changed nothing says nothing, as a refused add does.
   */
  async function announceMoved(nodeId: string, from: number): Promise<void> {
    await tick();
    const said = moveAnnouncement(p.row.nodes, nodeId, from);
    if (said !== null) statusLine.announce(said);
  }
</script>

<svelte:document onkeydown={showWorkflowOnEscape} />

<div class="shell" data-testid="workflow-flow-builder" bind:this={shell}>
  <WorkflowActionPalette
    pipelines={p.pipelines}
    phases={p.phases}
    workflows={p.workflows}
    currentWorkflowId={p.row.workflowId}
    readonly={!p.editable}
    splitTargetId={selectedNodeId}
    onaddnode={addNode}
    onaddsplit={() => {
      if (selectedNodeId) addBranch(selectedNodeId);
    }}
    collapsed={!paletteOpen}
    ontoggle={() => (paletteOpen = !paletteOpen)}
  />

  <WorkflowFlowCanvas
    nodes={p.row.nodes}
    connections={p.row.connections}
    startNodeIds={p.row.startNodeIds}
    control={p.row.control}
    pipelines={p.pipelines}
    phases={p.phases}
    workflows={p.workflows}
    allWorkflows={p.allWorkflows}
    nodeDefects={p.defects.byNode}
    connectionDefects={p.defects.byConnection}
    readonly={!p.editable}
    {selection}
    onselect={select}
    oninsertafter={insertAfter}
    onsplice={splice}
    onnodemove={moveNode}
    onnoderemove={removeNode}
    onopenworkflow={p.onopenworkflow}
  />

  <WorkflowInspector
    row={p.row}
    {selection}
    pipelines={p.pipelines}
    phases={p.phases}
    workflows={p.workflows}
    allWorkflows={p.allWorkflows}
    actions={p.graph}
    defects={p.defects}
    editable={p.editable}
    lifecycle={p.lifecycle}
    onworkflowpatch={p.onworkflowpatch}
    onnodepatch={p.graph.patchNode}
    onstarttoggle={p.graph.toggleStartNode}
    onbranchadd={addBranch}
    onretarget={p.graph.retargetConnection}
    onconnectionpatch={p.graph.patchConnection}
    onconditiontoggle={p.graph.toggleCondition}
    onconditionpatch={p.graph.patchCondition}
    onconditionvalue={p.graph.setConditionValue}
    onconditionvalueadd={p.graph.addConditionValue}
    onconditionvalueremove={p.graph.removeConditionValue}
    onconnectionmove={p.graph.moveConnection}
    onconnectionremove={removeConnection}
    onopenworkflow={p.onopenworkflow}
    onopenphase={p.onopenphase}
    onselectworkflow={() => void showWorkflow()}
  />
</div>
