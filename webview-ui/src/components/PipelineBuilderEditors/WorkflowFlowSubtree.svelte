<script lang="ts">
  // One card and everything below it. Renders itself for each arm, which is what
  // makes a fork nest instead of flattening.
  //
  // The recursion terminates because `buildWorkflowFlowLayout` decides it, not
  // this file: an arm whose target is already placed elsewhere in the flow comes
  // back with `isJump`, and a jump renders a reference chip rather than
  // descending. A cycle and a diamond both arrive here as jumps, so neither can
  // recurse forever, and this component has no cycle check of its own to keep in
  // step with the layout's.
  //
  // Every arm carries a chip, including an unconditional one. The reference design
  // draws a bare line there, but a bare line is not selectable and the inspector
  // is where a condition gets added — so an unlabelled arm reads `Always` in the
  // quiet style rather than becoming the one edge the operator cannot click.
  import type { FlowNodeSlot } from './workflow-flow-layout';
  import type { WorkflowFlowView } from './workflow-flow-view';
  import { isSameFlowSelection } from './workflow-flow-view';
  import WorkflowFlowNode from './WorkflowFlowNode.svelte';
  import WorkflowFlowSubtree from './WorkflowFlowSubtree.svelte';

  interface Props {
    view: WorkflowFlowView;
    slot: FlowNodeSlot;
  }

  const { view, slot }: Props = $props();
</script>

<div class="wf-subtree">
  <WorkflowFlowNode {view} {slot} />

  {#if slot.branches.length === 0}
    <!-- A terminal: the `+` appends a node downstream, and `End` says the branch
         completes here. An empty offer is a completed branch, not a failure
         (FR-028), so this chip is deliberately neutral. -->
    {#if !view.readonly}
      <div class="wf-connector"></div>
      <button
        class="wf-insert"
        data-testid="workflow-insert-after-{slot.nodeId}"
        aria-label="Add a node after {slot.nodeId}"
        onclick={() => view.oninsertafter(slot.nodeId)}>+</button
      >
    {/if}
    <div class="wf-connector"></div>
    <span class="wf-end" data-testid="workflow-end-{slot.nodeId}">End</span>
  {:else}
    <div class="wf-connector"></div>
    <!-- `--wf-arms` is the only thing the fork's CSS cannot derive: the bar has to
         stop at the centre of the first and last arm, which is half a column in
         from each end. -->
    <div class="wf-branches" style="--wf-arms: {slot.branches.length}">
      {#each slot.branches as branch (branch.connectionIndex)}
        {@const defects = view.connectionDefects[branch.connectionIndex] ?? []}
        {@const child = branch.isJump ? undefined : view.slotsById.get(branch.targetNodeId)}
        {@const selected = isSameFlowSelection(
          { kind: 'connection', index: branch.connectionIndex },
          view.selection
        )}
        <div class="wf-branch">
          <button
            class="wf-branch-label"
            class:is-default={branch.kind === 'default'}
            class:is-plain={branch.kind === 'unconditional'}
            class:is-selected={selected}
            data-testid="workflow-branch-{branch.connectionIndex}"
            data-invalid={defects.length > 0 ? 'true' : undefined}
            aria-pressed={selected}
            aria-label="Branch {branch.connectionIndex + 1} to {branch.targetNodeId}"
            onclick={() =>
              view.onselect({ kind: 'connection', index: branch.connectionIndex })}
          >
            {branch.label ?? 'Always'}
          </button>
          {#if !view.readonly}
            <div class="wf-connector"></div>
            <!-- Splices onto this connection rather than forking off it: the arm
                 still leads where it led, with the new node on the way. -->
            <button
              class="wf-insert"
              data-testid="workflow-splice-{branch.connectionIndex}"
              aria-label="Add a node on branch {branch.connectionIndex + 1}"
              onclick={() => view.onsplice(branch.connectionIndex)}>+</button
            >
          {/if}
          <div class="wf-connector"></div>
          {#if child}
            <WorkflowFlowSubtree {view} slot={child} />
          {:else}
            <!-- The target is drawn elsewhere in the flow. Naming it is what keeps
                 a diamond and a cycle readable without drawing either twice. -->
            <span class="wf-jump" data-testid="workflow-jump-{branch.connectionIndex}">
              → {branch.targetNodeId}
            </span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
