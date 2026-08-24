<script lang="ts">
  // The Actions palette: what can be added to the flow.
  //
  // Every item is a BUTTON, and the six-dot glyph beside it is decoration
  // (`aria-hidden`). The reference design makes drag the way to add a node; FR-042
  // makes that unacceptable on its own, because a drag is the one gesture a
  // keyboard cannot produce. Click and Enter are therefore the operation, not a
  // fallback to it.
  //
  // The Pipelines group is the effective Pipeline catalog and nothing else. It is
  // not a fixed list of action kinds, because a Workflow node runs an
  // operator-defined Pipeline — the contract has no node-kind union to enumerate.
  // The reference design's Messages group (Email, Text message, WhatsApp) and its
  // Time delay have no member in `WorkflowNode`, so they are absent rather than
  // rendered as controls that could not do anything; adding any of them is a
  // contract change, not a palette entry.
  //
  // `Split` is in Logic because a split is not a node either: it is a second
  // connection leaving one node. It therefore acts on the selected node, and says
  // so when nothing is selected instead of failing silently on click.
  import type { PortablePipelineDefinition } from '../../lib/snapshot-types';

  interface Props {
    pipelines: readonly PortablePipelineDefinition[];
    readonly: boolean;
    /** The node a Logic action applies to, or null when none is selected. */
    selectedNodeId: string | null;
    onaddnode: (pipelineId: string) => void;
    onbranchadd: (nodeId: string) => void;
    onclose: () => void;
  }

  const { pipelines, readonly, selectedNodeId, onaddnode, onbranchadd, onclose }: Props = $props();

  const splitHint = $derived(
    selectedNodeId === null
      ? 'Select a node on the canvas first: a split is another connection leaving it.'
      : `Add another branch leaving ${selectedNodeId}.`
  );
</script>

<div class="wf-palette" data-testid="workflow-palette">
  <div class="wf-palette-head">
    <h3 id="workflow-palette-label">Actions</h3>
    <button
      class="icon-btn"
      data-testid="workflow-palette-close"
      aria-label="Hide the Actions palette"
      onclick={onclose}>‹</button
    >
  </div>

  <div class="wf-palette-group" aria-labelledby="workflow-palette-pipelines">
    <div class="wf-palette-group-label" id="workflow-palette-pipelines">Pipelines</div>
    {#each pipelines as pipeline (pipeline.pipelineId)}
      <button
        class="wf-palette-item"
        data-testid="workflow-palette-pipeline-{pipeline.pipelineId}"
        disabled={readonly}
        title={pipeline.description ?? pipeline.name}
        onclick={() => onaddnode(pipeline.pipelineId)}
      >
        <span class="wf-chip wf-chip-pipeline" aria-hidden="true">
          {pipeline.name.slice(0, 1).toUpperCase() || 'P'}
        </span>
        <span class="wf-palette-label">{pipeline.name}</span>
        <span class="wf-handle" aria-hidden="true">⠿</span>
      </button>
    {/each}
    <!-- Outside the loop: an empty catalog is not a Pipeline. FR-045 — every node
         runs a Pipeline, so with none effective there is nothing to add. -->
    {#if pipelines.length === 0}
      <div class="wf-palette-empty" data-testid="workflow-palette-no-pipelines">
        No effective Pipeline to add.
      </div>
    {/if}
  </div>

  <div class="wf-palette-group" aria-labelledby="workflow-palette-logic">
    <div class="wf-palette-group-label" id="workflow-palette-logic">Logic</div>
    <button
      class="wf-palette-item"
      data-testid="workflow-palette-split"
      disabled={readonly || selectedNodeId === null}
      title={splitHint}
      onclick={() => selectedNodeId !== null && onbranchadd(selectedNodeId)}
    >
      <span class="wf-chip wf-chip-logic" aria-hidden="true">⑂</span>
      <span class="wf-palette-label">Split</span>
      <span class="wf-handle" aria-hidden="true">⠿</span>
    </button>
    <!-- The reason sits with the control it disables, the same rule the Save
         prerequisite follows. A dead button with no explanation beside it is the
         failure this pattern exists to avoid. -->
    {#if selectedNodeId === null}
      <div class="wf-palette-empty" data-testid="workflow-palette-split-hint">{splitHint}</div>
    {/if}
  </div>
</div>
