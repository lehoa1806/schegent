<script lang="ts">
  // Feature 083 (US5, T056) — the node half of the list Builder.
  //
  // Split from WorkflowGraphEditor so both stay inside the 500-line Svelte
  // budget and so the node list can be rendered on its own in a test.
  //
  // A node's identifier is assigned once and shown, never edited: connections
  // and starts address it, and the operator names the node through `label`
  // instead (FR-043). That is what makes reorder safe — moving a row changes no
  // identifier, so no endpoint needs remapping, unlike the Pipeline binding case.
  //
  // Reorder is two buttons, not a drag handle. Drag-and-drop would be the only
  // way to express the operation and would exclude every pointerless operator
  // (FR-042); buttons are reachable by Tab and activated by Enter or Space for
  // free, so the keyboard path is the only path rather than a fallback.
  import type { PortablePipelineDefinition, WorkflowNode } from '../../lib/snapshot-types';
  import type { WorkflowDraftError } from './workflow-catalog-state';
  import WorkflowRowDefects from './WorkflowRowDefects.svelte';

  interface Props {
    nodes: readonly WorkflowNode[];
    startNodeIds: readonly string[];
    pipelines: readonly PortablePipelineDefinition[];
    /** Indexed alongside `nodes`; see `anchorWorkflowDefects`. */
    defects: readonly (readonly WorkflowDraftError[])[];
    readonly: boolean;
    onadd: () => void;
    onremove: (index: number) => void;
    onmove: (index: number, delta: number) => void;
    onpatch: (index: number, patch: Partial<WorkflowNode>) => void;
    onstarttoggle: (nodeId: string) => void;
  }

  const {
    nodes,
    startNodeIds,
    pipelines,
    defects,
    readonly,
    onadd,
    onremove,
    onmove,
    onpatch,
    onstarttoggle
  }: Props = $props();

  /** A Pipeline the node names but the catalog does not hold still has to show. */
  function pipelineLabel(pipelineId: string): string {
    return pipelines.find((entry) => entry.pipelineId === pipelineId)?.name ?? pipelineId;
  }
</script>

<div class="node-rows">
  <div class="sequence-label" id="workflow-nodes-label">Nodes</div>
  <ol class="sequence-list" aria-labelledby="workflow-nodes-label" data-testid="workflow-nodes">
    {#each nodes as node, index (node.nodeId)}
      {@const rowDefects = defects[index] ?? []}
      <li
        class="sequence-item"
        data-testid="workflow-node-{index}"
        data-invalid={rowDefects.length > 0 ? 'true' : undefined}
        aria-describedby={rowDefects.length > 0 ? `workflow-node-defects-${index}` : undefined}
      >
        <span class="node-id" data-testid="workflow-node-id-{index}">{node.nodeId}</span>
        <select
          class="select-input"
          data-testid="workflow-node-pipeline-{index}"
          aria-label="Node {index + 1} runs Pipeline"
          value={node.pipelineId}
          disabled={readonly}
          onchange={(event) => onpatch(index, { pipelineId: event.currentTarget.value })}
        >
          {#if !pipelines.some((entry) => entry.pipelineId === node.pipelineId)}
            <option value={node.pipelineId}>{pipelineLabel(node.pipelineId)}</option>
          {/if}
          {#each pipelines as pipeline (pipeline.pipelineId)}
            <option value={pipeline.pipelineId}>{pipeline.name}</option>
          {/each}
        </select>
        <input
          class="text-input"
          data-testid="workflow-node-label-{index}"
          aria-label="Node {index + 1} label"
          value={node.label ?? ''}
          {readonly}
          placeholder="label"
          oninput={(event) => onpatch(index, { label: event.currentTarget.value })}
        />
        <label class="checkbox-field">
          <input
            type="checkbox"
            data-testid="workflow-node-start-{index}"
            aria-label="Node {index + 1} may start the Workflow"
            checked={startNodeIds.includes(node.nodeId)}
            disabled={readonly}
            onchange={() => onstarttoggle(node.nodeId)}
          />
          <span class="form-label">Start</span>
        </label>
        {#if !readonly}
          <button
            class="icon-btn"
            data-testid="workflow-node-up-{index}"
            aria-label="Move node {index + 1} earlier"
            disabled={index === 0}
            onclick={() => onmove(index, -1)}>↑</button
          >
          <button
            class="icon-btn"
            data-testid="workflow-node-down-{index}"
            aria-label="Move node {index + 1} later"
            disabled={index === nodes.length - 1}
            onclick={() => onmove(index, 1)}>↓</button
          >
          <button
            class="icon-btn destructive-icon"
            data-testid="workflow-node-remove-{index}"
            aria-label="Remove node {index + 1}"
            onclick={() => onremove(index)}>✕</button
          >
        {/if}
        <WorkflowRowDefects id="workflow-node-defects-{index}" defects={rowDefects} />
      </li>
    {/each}
  </ol>
  <!-- Outside the `<ol>`: a list element may hold only list items. -->
  {#if nodes.length === 0}
    <div class="empty-selection" data-testid="workflow-nodes-empty">No nodes yet.</div>
  {/if}
  {#if !readonly}
    <button
      class="btn btn-secondary"
      data-testid="workflow-node-add"
      disabled={pipelines.length === 0}
      onclick={onadd}>Add node</button
    >
  {/if}
</div>
