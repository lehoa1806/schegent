<script lang="ts">
  // One node card on the canvas, drawn as the redesign's `.node` (sg-builder.css):
  // the kind's tile and the title, the target's identifier under them, what the
  // target runs on, and a row of badges.
  //
  // The card is a box holding one button rather than a button itself. The selected
  // card's toolbar and a child Workflow's preview line are controls of their own,
  // and a button cannot hold another. The button carries what the whole card used
  // to: the selection, `aria-pressed`, `data-invalid` and the description. Its name
  // is its content.
  //
  // The defect list is visually hidden. The red border and the issue badge are the
  // card's cue, the inspector lists the defects once the card is selected, and the
  // button's description still reads them.
  import type { FlowNodeSlot } from './workflow-flow-layout';
  import {
    issueCountLabel,
    nodeControlLabel,
    nodeRunSummary,
    nodeTargetSummary,
    nodeTitle,
    phaseOfNode,
    type WorkflowFlowView,
    type WorkflowNodeTargetKind
  } from './workflow-flow-view';
  import { formatPhaseRetrySummary, type WorkflowNode } from '../../lib/snapshot-types';
  import { resolveRetryCapOutcome } from '../../../../src/contracts/retry-cap-outcome';
  import WorkflowChildPreview from './WorkflowChildPreview.svelte';
  import WorkflowNodeToolbar from './WorkflowNodeToolbar.svelte';
  import WorkflowRowDefects from './WorkflowRowDefects.svelte';

  interface Props {
    view: WorkflowFlowView;
    slot: FlowNodeSlot;
  }

  const { view, slot }: Props = $props();

  interface KindFace {
    /** The kind's tile, as a whole sprite reference the sprite test can check. */
    readonly icon: string;
    /** Read before the identifier, because the tile says the kind only by colour and shape. */
    readonly word: string;
    /** The badge on a card whose target the catalog does not hold. */
    readonly unknown: string;
  }

  const KIND_FACES: Readonly<Record<WorkflowNodeTargetKind, KindFace>> = {
    phase: { icon: '#i-phase', word: 'Phase', unknown: 'Unknown Phase' },
    workflow: { icon: '#i-workflow', word: 'child Workflow', unknown: 'Unknown Workflow' },
    pipeline: { icon: '#i-build', word: 'Pipeline', unknown: 'Unknown Step' }
  };

  const index = $derived(slot.nodeIndex);
  const node = $derived<WorkflowNode | undefined>(view.nodes[index]);
  const defects = $derived(view.nodeDefects[index] ?? []);
  const target = $derived(node ? nodeTargetSummary(view, node) : null);
  const face = $derived(target ? KIND_FACES[target.kind] : null);
  const summary = $derived(node ? nodeRunSummary(view, node) : null);
  const phaseDef = $derived(node ? phaseOfNode(view, node) : null);
  const phaseRetrySummary = $derived(
    phaseDef && phaseDef.retryCondition?.trim()
      ? formatPhaseRetrySummary({
          retryCondition: phaseDef.retryCondition,
          capOutcome: resolveRetryCapOutcome(phaseDef, undefined)
        })
      : null
  );
  const selected = $derived(view.selection?.kind === 'node' && view.selection.index === index);
  const candidateIndex = $derived(
    node && view.control ? view.control.candidates.findIndex((c) => c.nodeId === node.nodeId) : -1
  );
  const candidateEntry = $derived(
    candidateIndex >= 0 && view.control ? (view.control.candidates[candidateIndex] ?? null) : null
  );
  const candidateText = $derived(
    candidateEntry
      ? `Candidate #${candidateIndex + 1}: ${candidateEntry.candidateId} · ${candidateEntry.maxAttempts ?? 1} attempts`
      : null
  );
  const inCycle = $derived(node !== undefined && view.cycleNodeIds.includes(node.nodeId));
  const title = $derived(node ? nodeTitle(node) : '');
  /** A labelled node is titled by its label, so its own identifier moves to a badge. */
  const labelled = $derived(Boolean(node?.label?.trim()));
  const issues = $derived(issueCountLabel(defects.length));
  const hasBadges = $derived(
    slot.isStart ||
      node?.control !== undefined ||
      labelled ||
      candidateText !== null ||
      phaseRetrySummary !== null ||
      target?.resolved === false ||
      inCycle ||
      defects.length > 0
  );

  const DELETE_KEYS: readonly string[] = ['Delete', 'Backspace'];

  /**
   * Delete or Backspace deletes the selected step, the toolbar's Delete by key, so it says the same
   * and hands focus to Undo the same way. The builder mockup listens on the whole page; here the
   * keys act from the selected card alone (its button, its toolbar, its preview line), so a key
   * meant for the inspector's fields or for another card never deletes this one. Only a button
   * takes them, so a text field never does. A key held with a modifier is left to whatever binds
   * it, and a key held down deletes one step.
   */
  function onCardKeydown(event: KeyboardEvent): void {
    if (!selected || view.readonly || event.defaultPrevented || event.repeat) return;
    if (!DELETE_KEYS.includes(event.key)) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (!(event.target instanceof HTMLButtonElement)) return;
    event.preventDefault();
    view.onnoderemove(index);
  }
</script>

{#if node && target && face}
  <!-- The card catches Delete and Backspace as they bubble up from its own buttons, which are what
       take focus; it is a container, not a control, so it has no role to give. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="node wf-card"
    class:sel={selected}
    class:defect={defects.length > 0}
    onkeydown={onCardKeydown}
  >
    <button
      type="button"
      class="wf-card-hit"
      data-testid="workflow-node-{index}"
      data-invalid={defects.length > 0 ? 'true' : undefined}
      aria-pressed={selected}
      aria-describedby={defects.length > 0 ? `workflow-node-defects-${index}` : undefined}
      onclick={() => view.onselect({ kind: 'node', index })}
    >
      <span class="row1">
        <span class="kicon k-{target.kind}" aria-hidden="true">
          <svg class="i" aria-hidden="true"><use href={face.icon}></use></svg>
        </span>
        <span class="name" data-testid="workflow-node-title-{index}">{title}</span>
      </span>
      <span class="id">
        <span class="sr-only">{face.word}</span>
        <span data-testid="workflow-node-pipeline-{index}">{target.id || node.nodeId}</span>
      </span>
      {#if summary !== null}
        <span class="sum" data-testid="workflow-node-summary-{index}">{summary}</span>
      {/if}
      {#if hasBadges}
        <span class="badges">
          {#if slot.isStart}
            <span class="badge start" data-testid="workflow-node-start-badge-{index}">
              <svg class="i" aria-hidden="true"><use href="#i-start"></use></svg>Start
            </span>
          {/if}
          {#if node.control}
            <span class="badge loop" data-testid="workflow-node-control-{index}">
              <svg class="i" aria-hidden="true"
                ><use href={node.control.kind === 'for-each' ? '#i-each' : '#i-repeat'}></use></svg
              >{nodeControlLabel(node.control)}
            </span>
          {/if}
          {#if labelled}
            <span class="badge wf-badge-id">{node.nodeId}</span>
          {/if}
          {#if candidateText !== null}
            <span class="badge wf-badge-long" data-testid="workflow-node-candidate-badge-{index}">
              <svg class="i" aria-hidden="true"><use href="#i-swap"></use></svg>{candidateText}
            </span>
          {/if}
          {#if phaseRetrySummary}
            <span class="badge wf-badge-long" data-testid="workflow-node-retry-policy-{index}">
              <svg class="i" aria-hidden="true"><use href="#i-refresh"></use></svg>{phaseRetrySummary}
            </span>
          {/if}
          {#if !target.resolved}
            <span class="badge err" data-testid="workflow-node-unknown-pipeline-{index}">
              <svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg>{face.unknown}
            </span>
          {/if}
          {#if inCycle}
            <span class="badge err" data-testid="workflow-node-cycle-{index}">
              <svg class="i" aria-hidden="true"><use href="#i-loop"></use></svg>In a cycle
            </span>
          {/if}
          {#if defects.length > 0}
            <span class="badge err">
              <svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg>{issues}
            </span>
          {/if}
        </span>
      {/if}
    </button>

    {#if selected && !view.readonly}
      <WorkflowNodeToolbar
        {index}
        count={view.nodes.length}
        {title}
        onmove={(delta) => view.onnodemove(index, delta)}
        onremove={() => view.onnoderemove(index)}
      />
    {/if}

    {#if node.workflowId !== undefined}
      <WorkflowChildPreview {view} {index} nodeId={node.nodeId} workflowId={node.workflowId} {title} />
    {/if}

    {#if defects.length > 0}
      <div class="sr-only">
        <WorkflowRowDefects id="workflow-node-defects-{index}" {defects} />
      </div>
    {/if}
  </div>
{/if}
