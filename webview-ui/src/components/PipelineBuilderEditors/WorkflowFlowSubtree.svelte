<script lang="ts">
  // One card and everything below it. Renders itself for each arm, which is what
  // makes a fork nest instead of flattening.
  //
  // The recursion terminates because `buildWorkflowFlowLayout` decides it, not
  // this file: an arm whose target is already placed elsewhere in the flow comes
  // back with `isJump`, and a jump renders a reference rather than descending. A
  // cycle and a diamond both arrive here as jumps, so neither can recurse forever,
  // and this component has no cycle check of its own to keep in step with the
  // layout's.
  //
  // An arm is drawn as the redesign draws an edge (sg-builder.css): a line with an
  // arrowhead, a chip on it when the arm has a condition, waits for the operator or
  // has a defect, and a `+` that splices a step onto it. A plain arm has no chip,
  // but its line is still a button. The inspector is where a condition gets added,
  // so an arm nobody can select is an arm nobody can make conditional; its name
  // says which two cards it joins, since nothing visible does.
  import type { FlowNodeSlot } from './workflow-flow-layout';
  import {
    armName,
    isSameFlowSelection,
    issueCountLabel,
    nodeTitleById,
    type WorkflowFlowView
  } from './workflow-flow-view';
  import WorkflowFlowNode from './WorkflowFlowNode.svelte';
  import WorkflowFlowSubtree from './WorkflowFlowSubtree.svelte';

  interface Props {
    view: WorkflowFlowView;
    slot: FlowNodeSlot;
  }

  const { view, slot }: Props = $props();

  const sourceTitle = $derived(nodeTitleById(view, slot.nodeId));
</script>

<div class="wf-subtree">
  <WorkflowFlowNode {view} {slot} />

  {#if slot.branches.length === 0}
    <!-- A terminal: the `+` appends a step downstream, and `End` says the branch
         completes here. An empty offer is a completed branch, not a failure
         (FR-028), so this chip is deliberately neutral. -->
    <div class="wf-edge is-end">
      {#if !view.readonly}
        <button
          type="button"
          class="plus"
          data-testid="workflow-insert-after-{slot.nodeId}"
          aria-label="Add a step after {sourceTitle}"
          onclick={() => view.oninsertafter(slot.nodeId)}
        >
          <svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>
        </button>
      {/if}
    </div>
    <span class="wf-end" data-testid="workflow-end-{slot.nodeId}">End</span>
  {:else}
    <!-- `--wf-arms` is the only thing the fork's CSS cannot derive: the bar has to
         stop at the centre of the first and last arm, which is half a column in
         from each end. -->
    <div
      class="wf-branches"
      class:is-fork={slot.branches.length > 1}
      style="--wf-arms: {slot.branches.length}"
    >
      {#each slot.branches as branch (branch.connectionIndex)}
        {@const defects = view.connectionDefects[branch.connectionIndex] ?? []}
        {@const child = branch.isJump ? undefined : view.slotsById.get(branch.targetNodeId)}
        {@const selected = isSameFlowSelection(
          { kind: 'connection', index: branch.connectionIndex },
          view.selection
        )}
        {@const manual = view.connections.at(branch.connectionIndex)?.handoff === 'manual'}
        {@const chip = branch.label !== null || manual || defects.length > 0}
        {@const targetTitle = nodeTitleById(view, branch.targetNodeId)}
        <div class="wf-branch">
          <div
            class="wf-edge"
            class:is-labelled={chip}
            class:is-sel={selected}
            class:is-invalid={defects.length > 0}
          >
            <!-- Quoted, so the value is a plain string: a bare `class={expr}` sends it through
                 Svelte's clsx, and that code lands in the chunk the sidebar loads at startup. -->
            <button
              type="button"
              class="{chip ? 'elabel' : 'wf-edge-hit'}"
              class:sel={selected}
              data-testid="workflow-branch-{branch.connectionIndex}"
              data-invalid={defects.length > 0 ? 'true' : undefined}
              aria-pressed={selected}
              aria-label={armName(sourceTitle, targetTitle, branch.label, manual, defects.length)}
              onclick={() => view.onselect({ kind: 'connection', index: branch.connectionIndex })}
            >
              {#if branch.label !== null}{branch.label}{/if}
              {#if manual}
                <span class="appr">
                  <svg class="i" aria-hidden="true"><use href="#i-approve"></use></svg>Manual handoff
                </span>
              {/if}
              {#if defects.length > 0}
                <span class="wf-arm-issue">
                  <svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg>{issueCountLabel(
                    defects.length
                  )}
                </span>
              {/if}
            </button>
            {#if !view.readonly}
              <!-- Splices onto this connection rather than forking off it: the arm
                   still leads where it led, with the new step on the way. -->
              <button
                type="button"
                class="plus"
                data-testid="workflow-splice-{branch.connectionIndex}"
                aria-label="Insert a step between {sourceTitle} and {targetTitle}"
                onclick={() => view.onsplice(branch.connectionIndex)}
              >
                <svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>
              </button>
            {/if}
          </div>
          {#if child}
            <WorkflowFlowSubtree {view} slot={child} />
          {:else}
            <!-- The target is drawn elsewhere in the flow. Naming it is what keeps
                 a diamond and a cycle readable without drawing either twice. -->
            <span class="wf-jump" data-testid="workflow-jump-{branch.connectionIndex}">
              <svg class="i" aria-hidden="true"><use href="#i-loop"></use></svg>
              <span class="sr-only">Continues at</span>
              {targetTitle}
            </span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
