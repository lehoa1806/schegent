<script lang="ts">
  // The inspector: the fields of whatever the canvas has in focus.
  //
  // Supports Workflow settings, public ports & bindings, execution defaults,
  // dependent-parent impact, and Phase / child-Workflow / Pipeline node configuration.
  import {
    EFFORT_LEVELS,
    type BuilderLifecycle,
    type Effort,
    type PortablePhaseDefinition,
    type PortablePipelineDefinition,
    type PortableWorkflowDefinition,
    type WorkflowConnection,
    type WorkflowNode,
  } from "../../lib/snapshot-types";
  import {
    dependentWorkflowsForWorkflow,
    type AnchoredWorkflowDefects,
    type WorkflowConditionPatch,
  } from "./workflow-catalog-state";
  import type { WorkflowGraphActions } from "./workflow-catalog-actions";
  import type { WorkflowFlowSelection } from "./workflow-flow-view";
  import type { MutableWorkflow } from "./types";
  import DefinitionLifecyclePanel from "../Builder/DefinitionLifecyclePanel.svelte";
  import WorkflowBranchInspector from "./WorkflowBranchInspector.svelte";
  import WorkflowPortsAndBindingsEditor from "./WorkflowPortsAndBindingsEditor.svelte";
  import WorkflowRowDefects from "./WorkflowRowDefects.svelte";

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
    defects: AnchoredWorkflowDefects;
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
  const nodePipeline = $derived(
    node
      ? (p.pipelines.find((entry) => entry.pipelineId === node.pipelineId) ??
          null)
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

  function effectiveNodeKind(
    target: WorkflowNode,
  ): "phase" | "workflow" | "pipeline" {
    if (target.kind === "phase" || target.phaseId !== undefined) return "phase";
    if (target.kind === "workflow" || target.workflowId !== undefined) {
      return "workflow";
    }
    return "pipeline";
  }

  function switchNodeKind(index: number, kind: "phase" | "workflow" | "pipeline"): void {
    if (kind === "phase") {
      p.onnodepatch(index, { kind: "phase", phaseId: phases[0]?.phaseId ?? "", workflowId: undefined, pipelineId: undefined });
    } else if (kind === "workflow") {
      p.onnodepatch(index, { kind: "workflow", workflowId: childWorkflowOptions[0]?.workflowId ?? "", phaseId: undefined, pipelineId: undefined });
    } else {
      p.onnodepatch(index, { kind: undefined, pipelineId: p.pipelines[0]?.pipelineId ?? "", phaseId: undefined, workflowId: undefined });
    }
  }
</script>

<div class="wf-inspector" data-testid="workflow-inspector">
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
    />
  {:else if node && p.selection.kind === "node"}
    {@const index = p.selection.index}
    {@const nKind = effectiveNodeKind(node)}
    <div
      class="wf-inspector-section"
      data-testid="workflow-node-inspector-{index}"
    >
      <button type="button" class="btn btn-ghost btn-sm" data-testid="workflow-settings-btn" onclick={() => p.onselectworkflow?.()}>← Workflow</button>
      <h3>Node {index + 1}</h3>
      <span class="wf-inspector-sub" data-testid="workflow-node-inspector-id"
        >{node.nodeId}</span
      >
      <WorkflowRowDefects
        id="workflow-node-inspector-defects-{index}"
        defects={p.defects.byNode[index] ?? []}
      />

      {#if phases.length > 0 || childWorkflowOptions.length > 0}
        <label class="wf-field">
          Step Type
          <select
            class="select-input"
            data-testid="workflow-node-kind-select-{index}"
            aria-label="Node {index + 1} step type"
            value={nKind}
            disabled={readonly}
            onchange={(event) =>
              switchNodeKind(
                index,
                event.currentTarget.value as "phase" | "workflow" | "pipeline",
              )}
          >
            <option value="phase">Phase</option>
            <option value="workflow">Child Workflow</option>
            {#if p.pipelines.length > 0 || nKind === "pipeline"}
              <option value="pipeline">Pipeline</option>
            {/if}
          </select>
        </label>
      {/if}

      {#if nKind === "phase"}
        <label class="wf-field">
          Runs Phase
          <select
            class="select-input"
            data-testid="workflow-node-phase-select-{index}"
            aria-label="Node {index + 1} runs Phase"
            value={node.phaseId ?? ""}
            disabled={readonly}
            onchange={(event) =>
              p.onnodepatch(index, {
                kind: "phase",
                phaseId: event.currentTarget.value,
                workflowId: undefined,
                pipelineId: undefined,
              })}
          >
            {#if node.phaseId !== undefined && !phases.some((entry) => entry.phaseId === node.phaseId)}
              <option value={node.phaseId}
                >{node.phaseId} (not effective)</option
              >
            {/if}
            {#each phases as phase (phase.phaseId)}
              <option value={phase.phaseId}>{phase.name}</option>
            {/each}
          </select>
        </label>
      {:else if nKind === "workflow"}
        <label class="wf-field">
          Runs Workflow
          <select
            class="select-input"
            data-testid="workflow-node-workflow-select-{index}"
            aria-label="Node {index + 1} runs Workflow"
            value={node.workflowId ?? ""}
            disabled={readonly}
            onchange={(event) =>
              p.onnodepatch(index, {
                kind: "workflow",
                workflowId: event.currentTarget.value,
                phaseId: undefined,
                pipelineId: undefined,
              })}
          >
            {#if node.workflowId !== undefined && !childWorkflowOptions.some((entry) => entry.workflowId === node.workflowId)}
              <option value={node.workflowId}
                >{node.workflowId} (not effective)</option
              >
            {/if}
            {#each childWorkflowOptions as wf (wf.workflowId)}
              <option value={wf.workflowId}>{wf.name}</option>
            {/each}
          </select>
        </label>
        {#if node.workflowId && p.onopenworkflow}
          {@const childId = node.workflowId}
          {@const fromId = node.nodeId}
          <button
            type="button"
            class="btn btn-ghost"
            data-testid="workflow-inspector-open-child-{index}"
            onclick={() => p.onopenworkflow?.(childId, fromId)}
          >
            Open child Workflow definition
          </button>
        {/if}
      {:else}
        <label class="wf-field">
          Runs Pipeline
          <select
            class="select-input"
            data-testid="workflow-node-pipeline-select-{index}"
            aria-label="Node {index + 1} runs Pipeline"
            value={node.pipelineId ?? ""}
            disabled={readonly}
            onchange={(event) =>
              p.onnodepatch(index, { pipelineId: event.currentTarget.value })}
          >
            {#if node.pipelineId !== undefined && !p.pipelines.some((entry) => entry.pipelineId === node.pipelineId)}
              <option value={node.pipelineId}
                >{node.pipelineId} (not effective)</option
              >
            {/if}
            {#each p.pipelines as pipeline (pipeline.pipelineId)}
              <option value={pipeline.pipelineId}>{pipeline.name}</option>
            {/each}
          </select>
        </label>
      {/if}

      <label class="wf-field">
        Label
        <input class="text-input" data-testid="workflow-node-label-{index}" aria-label="Node {index + 1} label" value={node.label ?? ""} {readonly} placeholder={node.nodeId} oninput={(event) => p.onnodepatch(index, { label: event.currentTarget.value })} />
      </label>
      <label class="checkbox-field">
        <input type="checkbox" data-testid="workflow-node-start-{index}" aria-label="Node {index + 1} may start the Workflow" checked={p.row.startNodeIds.includes(node.nodeId)} disabled={readonly} onchange={() => p.onstarttoggle(node.nodeId)} />
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
      {:else if nodeChildWorkflow}
        <div class="row-ports" data-testid="workflow-node-ports-{index}">
          <span class="form-label">Child Workflow Ports</span>
          {#each nodeChildWorkflow.inputs ?? [] as port (port.portId)}
            <span class="wf-badge">in {port.portId}</span>
          {/each}
          {#each nodeChildWorkflow.outputs ?? [] as port (port.portId)}
            <span class="wf-badge">out {port.portId}</span>
          {/each}
        </div>
      {/if}

      {#if !readonly}
        <button
          class="btn btn-secondary"
          data-testid="workflow-node-branch-add-{index}"
          onclick={() => p.onbranchadd(node.nodeId)}
          >Add branch from this node</button
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
          oninput={(event) =>
            p.onworkflowpatch({ workflowId: event.currentTarget.value })}
        />
      </label>
      <label class="wf-field">
        Name
        <input
          class="text-input"
          data-testid="workflow-field-name"
          value={p.row.name}
          {readonly}
          oninput={(event) =>
            p.onworkflowpatch({ name: event.currentTarget.value })}
        />
      </label>
      <label class="wf-field">
        Description
        <textarea
          class="text-area"
          data-testid="workflow-field-description"
          value={p.row.description ?? ""}
          {readonly}
          oninput={(event) =>
            p.onworkflowpatch({ description: event.currentTarget.value })}
        ></textarea>
      </label>
      <div class="phase-badges">
        <span class="status-badge status-{p.row.sourceStatus}"
          >{p.row.sourceStatus}</span
        >
        {#if dependentParents.length > 0}
          <span
            class="status-badge"
            data-testid="workflow-dependent-parents"
          >
            Used by {dependentParents.length}
            {dependentParents.length === 1 ? "Workflow" : "Workflows"}:
            {dependentParents.map((d) => d.name || d.workflowId).join(", ")}
          </span>
        {/if}
      </div>

      <DefinitionLifecyclePanel
        kind="workflow"
        definitionId={p.row.workflowId}
        definitionName={p.row.name || "Untitled Workflow"}
        lifecycle={p.lifecycle}
        defects={p.row.sourceErrors}
      />

      {#if p.actions}
        <WorkflowPortsAndBindingsEditor
          workflow={p.row}
          {readonly}
          actions={p.actions}
          defects={p.defects.rest}
        />

        <div class="wf-inspector-section" data-testid="workflow-execution-defaults">
          <div class="wf-inspector-heading">Execution Defaults</div>
          <label class="wf-field">
            Default Runner
            <select
              class="select-input"
              data-testid="workflow-default-runner"
              value={p.row.executionDefaults?.runner ?? ""}
              disabled={readonly}
              onchange={(event) =>
                p.actions?.patchExecutionDefaults?.({
                  runner: event.currentTarget.value || undefined,
                })}
            >
              <option value="">[Inherit]</option>
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="agy">agy</option>
            </select>
          </label>
          <label class="wf-field">
            Default Model
            <input
              class="text-input"
              data-testid="workflow-default-model"
              value={p.row.executionDefaults?.model ?? ""}
              {readonly}
              oninput={(event) =>
                p.actions?.patchExecutionDefaults?.({
                  model: event.currentTarget.value.trim() || undefined,
                })}
            />
          </label>
          <label class="wf-field">
            Default Effort
            <select
              class="select-input"
              data-testid="workflow-default-effort"
              value={p.row.executionDefaults?.effort ?? ""}
              disabled={readonly}
              onchange={(event) =>
                p.actions?.patchExecutionDefaults?.({
                  effort: (event.currentTarget.value || undefined) as
                    | Effort
                    | undefined,
                })}
            >
              <option value="">[Inherit]</option>
              {#each EFFORT_LEVELS as effort (effort)}
                <option value={effort}>{effort}</option>
              {/each}
            </select>
          </label>
          <label class="wf-field">
            Recommended Next (comma-separated Workflow IDs)
            <input
              class="text-input"
              data-testid="workflow-recommended-next"
              value={(p.row.recommendedNext ?? []).join(", ")}
              {readonly}
              oninput={(event) =>
                p.actions?.setRecommendedNext?.(
                  event.currentTarget.value
                    .split(",")
                    .map((item) => item.trim())
                    .filter((item) => item.length > 0),
                )}
            />
          </label>
        </div>
      {/if}

      {#if p.defects.rest.length > 0}
        <ul
          class="field-errors"
          data-testid="workflow-field-errors"
          role="alert"
        >
          {#each p.defects.rest as defect (defect.field + defect.code)}
            <li>{defect.field}: {defect.message}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
