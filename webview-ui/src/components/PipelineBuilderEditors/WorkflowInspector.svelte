<script lang="ts">
  // The inspector: the settings of whatever the canvas has in focus. A branch, a
  // step, or with neither, the Workflow itself. Each mode draws its own head and
  // body, so the head and a step's tabs stay put while the body scrolls, and a step
  // or a branch offers the way back to the Workflow.
  import type {
    BuilderLifecycle,
    PortablePhaseDefinition,
    PortablePipelineDefinition,
    PortableWorkflowDefinition,
    WorkflowConnection,
    WorkflowNode,
  } from "../../lib/snapshot-types";
  import {
    dependentWorkflowsForWorkflow,
    type VisibleWorkflowDefects,
    type WorkflowConditionPatch,
  } from "./workflow-catalog-state";
  import type { WorkflowGraphActions } from "./workflow-catalog-actions";
  import type { WorkflowFlowSelection } from "./workflow-flow-view";
  import type { MutableWorkflow } from "./types";
  import WorkflowBranchInspector from "./WorkflowBranchInspector.svelte";
  import WorkflowNodeInspector from "./WorkflowNodeInspector.svelte";
  import WorkflowSettingsInspector from "./WorkflowSettingsInspector.svelte";

  interface Props {
    row: MutableWorkflow;
    selection: WorkflowFlowSelection;
    pipelines: readonly PortablePipelineDefinition[];
    phases?: readonly PortablePhaseDefinition[];
    workflows?: readonly PortableWorkflowDefinition[];
    allWorkflows?: readonly {
      readonly workflowId: string;
      readonly name: string;
      readonly nodes: readonly WorkflowNode[];
    }[];
    actions?: WorkflowGraphActions;
    defects: VisibleWorkflowDefects;
    editable: boolean;
    lifecycle?: BuilderLifecycle;
    onworkflowpatch: (patch: Partial<MutableWorkflow>) => void;
    onnodepatch: (index: number, patch: Partial<WorkflowNode>) => void;
    onstarttoggle: (nodeId: string) => void;
    onbranchadd: (nodeId: string) => void;
    onretarget: (
      index: number,
      end: "from" | "to",
      patch: { nodeId?: string; portId?: string; kind?: "node" | "return" },
    ) => void;
    onconnectionpatch: (
      index: number,
      patch: Partial<WorkflowConnection>,
    ) => void;
    onconditiontoggle: (index: number, conditional: boolean) => void;
    onconditionpatch: (index: number, patch: WorkflowConditionPatch) => void;
    onconditionvalue: (index: number, valueIndex: number, text: string) => void;
    onconditionvalueadd: (index: number) => void;
    onconditionvalueremove: (index: number, valueIndex: number) => void;
    onconnectionmove: (index: number, delta: number) => void;
    onconnectionremove: (index: number) => void;
    onopenworkflow?: (workflowId: string, fromNodeId: string) => void;
    onopenphase?: (phaseId: string) => void;
    onselectworkflow?: () => void;
  }

  const p: Props = $props();

  const readonly = $derived(!p.editable);
  const phases = $derived(p.phases ?? []);
  const workflows = $derived(p.workflows ?? []);
  const childWorkflowOptions = $derived.by(() => {
    const out: { readonly workflowId: string; readonly name: string }[] = [];
    const seen: string[] = [];
    for (const wf of [...workflows, ...(p.allWorkflows ?? [])]) {
      if (!wf.workflowId || wf.workflowId === p.row.workflowId || seen.includes(wf.workflowId)) continue;
      seen.push(wf.workflowId);
      out.push({ workflowId: wf.workflowId, name: wf.name || wf.workflowId });
    }
    return out;
  });
  const node = $derived(
    p.selection.kind === "node"
      ? (p.row.nodes[p.selection.index] ?? null)
      : null,
  );
  const connection = $derived(
    p.selection.kind === "connection"
      ? (p.row.connections[p.selection.index] ?? null)
      : null,
  );
  const nodeChildWorkflow = $derived(
    node?.workflowId
      ? (workflows.find((entry) => entry.workflowId === node.workflowId) ??
          null)
      : null,
  );
  const dependentParents = $derived(
    dependentWorkflowsForWorkflow(
      p.row.workflowId,
      p.allWorkflows ?? workflows,
    ),
  );
</script>

<section class="inspector" data-testid="workflow-inspector" aria-label="Inspector">
  {#if connection && p.selection.kind === "connection"}
    <WorkflowBranchInspector
      index={p.selection.index}
      {connection}
      nodes={p.row.nodes}
      pipelines={p.pipelines}
      {workflows}
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
      onback={p.onselectworkflow}
    />
  {:else if node && p.selection.kind === "node"}
    <WorkflowNodeInspector
      row={p.row}
      index={p.selection.index}
      {node}
      pipelines={p.pipelines}
      {phases}
      {workflows}
      {childWorkflowOptions}
      childWorkflow={nodeChildWorkflow}
      defects={p.defects.byNode.at(p.selection.index) ?? []}
      {readonly}
      onnodepatch={p.onnodepatch}
      onstarttoggle={p.onstarttoggle}
      onbranchadd={p.onbranchadd}
      onopenworkflow={p.onopenworkflow}
      onopenphase={p.onopenphase}
      onselectworkflow={p.onselectworkflow}
    />
  {:else}
    <WorkflowSettingsInspector
      row={p.row}
      {phases}
      {dependentParents}
      actions={p.actions}
      defects={p.defects.rest}
      hiddenChecks={p.defects.hiddenChecks}
      {readonly}
      lifecycle={p.lifecycle}
      onworkflowpatch={p.onworkflowpatch}
      onopenworkflow={p.onopenworkflow}
      onopenphase={p.onopenphase}
    />
  {/if}
</section>
