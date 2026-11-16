<script lang="ts">
  // A child Workflow card's preview line, drawn as the redesign's `.preview`
  // (sg-builder.css): the steps the child runs, listed on request, and a link
  // that opens its definition.
  //
  // The steps are listed only when asked for. `buildChildWorkflowPreview` walks
  // every nested call down to its depth limit, which is work a closed card does
  // not need.
  import {
    buildChildWorkflowPreview,
    type ChildWorkflowPreviewNode
  } from './workflow-catalog-state';
  import type { WorkflowFlowView } from './workflow-flow-view';

  interface Props {
    view: WorkflowFlowView;
    index: number;
    nodeId: string;
    workflowId: string;
    title: string;
  }

  const { view, index, nodeId, workflowId, title }: Props = $props();

  // Whole sprite references, so the sprite test can check each one names a symbol.
  const KIND_ICONS: Readonly<Record<ChildWorkflowPreviewNode['kind'], string>> = {
    phase: '#i-phase',
    workflow: '#i-workflow',
    pipeline: '#i-build'
  };

  let expanded = $state(false);
  const preview = $derived(
    expanded ? buildChildWorkflowPreview(workflowId, view.workflows ?? []) : null
  );

  /**
   * `path` is the chain of node ids from the previewed Workflow down to this entry. The preview
   * expands every call node in place, so a grandchild called twice repeats its node ids at the
   * same depth; only the path tells those entries apart.
   */
  interface PreviewEntry {
    readonly node: ChildWorkflowPreviewNode;
    readonly depth: number;
    readonly path: string;
  }

  function flattenPreview(
    nodes: readonly ChildWorkflowPreviewNode[],
    depth = 0,
    parentPath = ''
  ): readonly PreviewEntry[] {
    const out: PreviewEntry[] = [];
    for (const item of nodes) {
      const path = parentPath === '' ? item.nodeId : `${parentPath}/${item.nodeId}`;
      out.push({ node: item, depth, path });
      if (item.children.length > 0) {
        out.push(...flattenPreview(item.children, depth + 1, path));
      }
    }
    return out;
  }
</script>

<div class="preview wf-preview">
  <span class="wf-preview-links">
    <button
      type="button"
      class="linkbtn"
      data-testid="workflow-node-preview-toggle-{index}"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      {expanded ? 'Hide preview' : 'Preview steps'}
    </button>
    {#if view.onopenworkflow}
      <button
        type="button"
        class="linkbtn"
        data-testid="workflow-node-open-child-{index}"
        aria-label="Open the definition of {title}"
        onclick={() => view.onopenworkflow?.(workflowId, nodeId)}
      >
        Open
      </button>
    {/if}
  </span>
  {#if preview}
    <div class="wf-preview-body" data-testid="workflow-node-preview-{index}">
      {#if preview.truncatedReason === 'cycle'}
        <p class="wf-preview-note is-defect" data-testid="workflow-node-preview-cycle-{index}">
          Cycle detected in child Workflow preview
        </p>
      {:else if preview.truncatedReason === 'max-depth'}
        <p class="wf-preview-note" data-testid="workflow-node-preview-depth-{index}">
          Max preview depth reached
        </p>
      {:else if preview.truncatedReason === 'missing'}
        <p class="wf-preview-note is-defect" data-testid="workflow-node-preview-missing-{index}">
          Child Workflow definition not found
        </p>
      {:else}
        <ul class="wf-preview-steps">
          {#each flattenPreview(preview.nodes) as entry (entry.path)}
            <li
              class="wf-preview-step"
              style:--wf-depth={entry.depth}
              data-testid="workflow-node-preview-step-{index}-{entry.path}"
            >
              <svg class="i" aria-hidden="true"><use href={KIND_ICONS[entry.node.kind]}></use></svg>
              <span class="sr-only">{entry.node.kind}</span>
              <span class="wf-preview-name">{entry.node.label}</span>
              <span class="wf-preview-id">{entry.node.targetId}</span>
              {#if entry.node.truncatedReason}
                <span class="wf-preview-note is-defect">
                  {entry.node.truncatedReason === 'cycle' ? 'Cycle detected' : 'Depth limit reached'}
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
