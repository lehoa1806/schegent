<script lang="ts">
  // One node card on the canvas.
  //
  // Supports Phase nodes (`kind: 'phase'`), child Workflow nodes
  // (`kind: 'workflow'`), and legacy Pipeline nodes. Child Workflow nodes offer
  // bounded inline preview expansion and drill-down ("Open child Workflow
  // definition").
  import type { FlowNodeSlot } from "./workflow-flow-layout";
  import {
    nodeTargetSummary,
    nodeTitle,
    type WorkflowFlowView,
  } from "./workflow-flow-view";
  import {
    buildChildWorkflowPreview,
    type ChildWorkflowPreviewNode,
  } from "./workflow-catalog-state";
  import type { WorkflowNode } from "../../lib/snapshot-types";
  import WorkflowRowDefects from "./WorkflowRowDefects.svelte";

  interface Props {
    view: WorkflowFlowView;
    slot: FlowNodeSlot;
  }

  const { view, slot }: Props = $props();

  const index = $derived(slot.nodeIndex);
  const node = $derived<WorkflowNode | undefined>(view.nodes[index]);
  const defects = $derived(view.nodeDefects[index] ?? []);
  const target = $derived(node ? nodeTargetSummary(view, node) : null);
  const selected = $derived(
    view.selection?.kind === "node" && view.selection.index === index,
  );
  const inCycle = $derived(
    node !== undefined && view.cycleNodeIds.includes(node.nodeId),
  );
  const title = $derived(node ? nodeTitle(node) : "");
  const initial = $derived(title.slice(0, 1).toUpperCase() || "?");

  let previewExpanded = $state(false);
  const childPreview = $derived(
    node?.workflowId && previewExpanded
      ? buildChildWorkflowPreview(node.workflowId, view.workflows ?? [])
      : null,
  );

  function flattenPreview(
    nodes: readonly ChildWorkflowPreviewNode[],
    depth = 0,
  ): readonly { readonly node: ChildWorkflowPreviewNode; readonly depth: number }[] {
    const out: { readonly node: ChildWorkflowPreviewNode; readonly depth: number }[] = [];
    for (const item of nodes) {
      out.push({ node: item, depth });
      if (item.children.length > 0) {
        out.push(...flattenPreview(item.children, depth + 1));
      }
    }
    return out;
  }
</script>

{#if node && target}
  <div class="wf-node-row">
    <div class="wf-node-col">
      <button
        class="wf-node"
        class:is-selected={selected}
        data-testid="workflow-node-{index}"
        data-invalid={defects.length > 0 ? "true" : undefined}
        aria-pressed={selected}
        aria-describedby={defects.length > 0
          ? `workflow-node-defects-${index}`
          : undefined}
        onclick={() => view.onselect({ kind: "node", index })}
      >
        <span class="wf-node-head">
          <span
            class="wf-chip"
            class:wf-chip-start={slot.isStart}
            class:wf-chip-pipeline={!slot.isStart}
            aria-hidden="true"
          >
            {initial}
          </span>
          <span class="wf-node-title" data-testid="workflow-node-title-{index}"
            >{title}</span
          >
          <span class="wf-handle" aria-hidden="true">⠿</span>
        </span>
        <span class="wf-node-body" data-testid="workflow-node-pipeline-{index}">
          {target.resolved ? target.name : target.id || node.nodeId}
        </span>
        <span class="wf-node-foot">
          {#if slot.isStart}
            <span
              class="wf-badge is-start"
              data-testid="workflow-node-start-badge-{index}">Start</span
            >
          {/if}
          <span
            class="wf-badge"
            data-testid="workflow-node-kind-badge-{index}"
          >
            {target.kind === "phase"
              ? "Phase"
              : target.kind === "workflow"
                ? "Workflow"
                : "Pipeline"}
          </span>
          {#if node.label?.trim()}
            <span class="wf-badge">{node.nodeId}</span>
          {/if}
          {#if !target.resolved}
            <span
              class="wf-badge is-defect"
              data-testid="workflow-node-unknown-pipeline-{index}"
            >
              {target.kind === "phase"
                ? "Unknown Phase"
                : target.kind === "workflow"
                  ? "Unknown Workflow"
                  : "Unknown Pipeline"}
            </span>
          {/if}
          {#if inCycle}
            <span
              class="wf-badge is-defect"
              data-testid="workflow-node-cycle-{index}">In a cycle</span
            >
          {/if}
          {#if defects.length > 0}
            <span class="wf-badge is-defect">Error</span>
          {/if}
        </span>
      </button>

      {#if node.workflowId !== undefined}
        <div class="wf-node-child-controls">
          <button
            type="button"
            class="btn btn-ghost"
            data-testid="workflow-node-preview-toggle-{index}"
            onclick={() => (previewExpanded = !previewExpanded)}
          >
            {previewExpanded ? "Hide preview" : "Preview steps"}
          </button>
          {#if view.onopenworkflow}
            {@const childWorkflowId = node.workflowId}
            {@const currentNodeId = node.nodeId}
            <button
              type="button"
              class="btn btn-ghost"
              data-testid="workflow-node-open-child-{index}"
              onclick={() => view.onopenworkflow?.(childWorkflowId, currentNodeId)}
            >
              Open child Workflow definition
            </button>
          {/if}
        </div>
        {#if previewExpanded && childPreview}
          <div
            class="wf-node-preview"
            data-testid="workflow-node-preview-{index}"
          >
            {#if childPreview.truncatedReason === "cycle"}
              <span class="wf-badge is-defect" data-testid="workflow-node-preview-cycle-{index}">
                Cycle detected in child Workflow preview
              </span>
            {:else if childPreview.truncatedReason === "max-depth"}
              <span class="wf-badge" data-testid="workflow-node-preview-depth-{index}">
                Max preview depth reached
              </span>
            {:else if childPreview.truncatedReason === "missing"}
              <span class="wf-badge is-defect" data-testid="workflow-node-preview-missing-{index}">
                Child Workflow definition not found
              </span>
            {:else}
              {#each flattenPreview(childPreview.nodes) as entry (entry.depth + "::" + entry.node.nodeId)}
                <div
                  class="wf-node-preview-item"
                  data-testid="workflow-node-preview-step-{index}-{entry.node.nodeId}"
                >
                  <span class="wf-badge">{entry.node.kind}</span>
                  <span>{entry.node.label} ({entry.node.targetId})</span>
                  {#if entry.node.truncatedReason}
                    <span class="wf-badge is-defect">
                      {entry.node.truncatedReason === "cycle"
                        ? "Cycle detected"
                        : "Depth limit reached"}
                    </span>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      {/if}

      <WorkflowRowDefects id="workflow-node-defects-{index}" {defects} />
    </div>

    {#if !view.readonly}
      <div class="wf-node-actions">
        <button
          class="icon-btn"
          data-testid="workflow-node-up-{index}"
          aria-label="Move node {index + 1} earlier"
          disabled={index === 0}
          onclick={() => view.onnodemove(index, -1)}>↑</button
        >
        <button
          class="icon-btn"
          data-testid="workflow-node-down-{index}"
          aria-label="Move node {index + 1} later"
          disabled={index === view.nodes.length - 1}
          onclick={() => view.onnodemove(index, 1)}>↓</button
        >
        <button
          class="icon-btn destructive-icon"
          data-testid="workflow-node-remove-{index}"
          aria-label="Remove node {index + 1}"
          onclick={() => view.onnoderemove(index)}>✕</button
        >
      </div>
    {/if}
  </div>
{/if}
