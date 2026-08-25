<script lang="ts">
  // One node card on the canvas.
  //
  // The card is a button and selecting it is its only job — every edit to the
  // node happens in the inspector, so this file holds no field, no rule, and no
  // write. That is what the list Builder's row did too; the row just carried the
  // controls inline because it had the width for them.
  //
  // Reorder and remove stay BUTTONS beside the card, not a drag handle on it.
  // FR-042 is unchanged by the redesign: a drag is the one gesture a keyboard
  // cannot make, so the reference design's handle is rendered as decoration
  // (`.wf-handle`, aria-hidden) and the operation lives on controls that Tab
  // reaches and Enter activates.
  //
  // The defect cue is a border AND a badge AND a described-by list: colour alone
  // reaches neither a screen reader nor a monochrome display (FR-044).
  import type { FlowNodeSlot } from './workflow-flow-layout';
  import { nodeTitle, pipelineOf, type WorkflowFlowView } from './workflow-flow-view';
  import type { WorkflowNode } from '../../lib/snapshot-types';
  import WorkflowRowDefects from './WorkflowRowDefects.svelte';

  interface Props {
    view: WorkflowFlowView;
    slot: FlowNodeSlot;
  }

  const { view, slot }: Props = $props();

  const index = $derived(slot.nodeIndex);
  // `noUncheckedIndexedAccess` is off, so an out-of-range index types as a
  // node while yielding `undefined` at run time. The guards below are real
  // protection; annotating the truth is what makes them legible to the type
  // checker (and to `no-unnecessary-condition`) instead of reading as dead.
  const node = $derived<WorkflowNode | undefined>(view.nodes[index]);
  const defects = $derived(view.nodeDefects[index] ?? []);
  const pipeline = $derived(node ? pipelineOf(view, node) : null);
  const selected = $derived(view.selection?.kind === 'node' && view.selection.index === index);
  const inCycle = $derived(node !== undefined && view.cycleNodeIds.includes(node.nodeId));
  const title = $derived(node ? nodeTitle(node) : '');
  /** First letter of what the card is titled by; see `.wf-chip` on why a letter. */
  const initial = $derived(title.slice(0, 1).toUpperCase() || '?');
</script>

{#if node}
  <div class="wf-node-row">
    <div class="wf-node-col">
      <button
        class="wf-node"
        class:is-selected={selected}
        data-testid="workflow-node-{index}"
        data-invalid={defects.length > 0 ? 'true' : undefined}
        aria-pressed={selected}
        aria-describedby={defects.length > 0 ? `workflow-node-defects-${index}` : undefined}
        onclick={() => view.onselect({ kind: 'node', index })}
      >
        <span class="wf-node-head">
          <span class="wf-chip" class:wf-chip-start={slot.isStart} class:wf-chip-pipeline={!slot.isStart} aria-hidden="true">
            {initial}
          </span>
          <span class="wf-node-title" data-testid="workflow-node-title-{index}">{title}</span>
          <span class="wf-handle" aria-hidden="true">⠿</span>
        </span>
        <!-- The Pipeline is the body, never the title: two nodes may run the same
             one and only `nodeId` tells them apart. A Pipeline the effective
             catalog does not hold still shows its identifier, because that is the
             `unknown-pipeline` defect the operator has to act on. -->
        <span class="wf-node-body" data-testid="workflow-node-pipeline-{index}">
          {pipeline?.name ?? node.pipelineId}
        </span>
        <span class="wf-node-foot">
          {#if slot.isStart}
            <span class="wf-badge is-start" data-testid="workflow-node-start-badge-{index}">Start</span>
          {/if}
          {#if node.label?.trim()}
            <span class="wf-badge">{node.nodeId}</span>
          {/if}
          {#if pipeline === null}
            <span class="wf-badge is-defect" data-testid="workflow-node-unknown-pipeline-{index}">
              Unknown Pipeline
            </span>
          {/if}
          {#if inCycle}
            <span class="wf-badge is-defect" data-testid="workflow-node-cycle-{index}">In a cycle</span>
          {/if}
          {#if defects.length > 0}
            <span class="wf-badge is-defect">Error</span>
          {/if}
        </span>
      </button>
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
