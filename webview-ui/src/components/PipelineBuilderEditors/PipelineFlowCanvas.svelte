<script lang="ts">
  // Feature 184 (FR-R3-141, T017) — the Pipeline canvas: the sequence, in order.
  //
  // ONE lane, and no layout call. The Workflow canvas has two lanes and a 291-line
  // placement module because a Workflow is a graph whose nodes have to be *placed*
  // and can be unreachable from every start. A Pipeline is an ordered `string[]`;
  // there is no second lane because there is no such thing as a Phase the sequence
  // does not reach, and there is no `buildPipelineFlowLayout` because `#each`
  // already renders a list in order (FR-036).
  //
  // Two empty states, not one, and each names only the surface that can resolve it
  // (FR-040). "No Pipeline open" is fixed from the picker in the top bar; "no Phase
  // in this Pipeline" is fixed from the palette. A single shared sentence would
  // send half the operators to the wrong control, which is what the old
  // `Select a Pipeline to edit or add a new one.` did for the second state.
  import {
    pipelineErrorRegionId,
    pipelineErrorDescribedBy,
    pipelineSequenceStatus,
    type PipelineDraftError
  } from './pipeline-catalog-state';
  import PipelineFieldErrors from './PipelineFieldErrors.svelte';
  import PipelineFlowNode from './PipelineFlowNode.svelte';
  import type { PipelineFlowView } from './pipeline-flow-view';
  import type { MutablePipeline } from './types';

  interface Props {
    /** Null when nothing is open — the state the picker resolves. */
    pipeline: MutablePipeline | null;
    view: PipelineFlowView;
    /** The `sequence`-anchored errors: they name the list, not one position. */
    sequenceErrors: readonly PipelineDraftError[];
  }

  const { pipeline, view, sequenceErrors }: Props = $props();
</script>

<div class="wf-canvas" data-testid="pipelines-canvas">
  {#if pipeline === null}
    <div class="empty-selection" data-testid="pipelines-canvas-no-selection">
      No Pipeline is open. Choose one from the list above, or add a new one.
    </div>
  {:else}
    <div class="sequence-label" id="pipeline-phases-label-{pipeline.id}">Phase sequence</div>
    <!-- FR-039 — the order is announced as text. Visual position alone is not a
         cue every reader has, and reordering changes nothing else on screen. -->
    <div
      class="sequence-status"
      data-testid="pipelines-sequence-status"
      role="status"
      aria-live="polite"
    >
      {pipelineSequenceStatus(pipeline)}
    </div>

    {#if view.phases.length === 0}
      <div class="empty-selection" data-testid="pipelines-canvas-empty">
        No Phase in this Pipeline yet. Add one from the Phases palette.
      </div>
    {:else}
      <div class="wf-lanes">
        <div
          class="wf-lane"
          data-testid="pipelines-lane-sequence"
          role="list"
          aria-labelledby="pipeline-phases-label-{pipeline.id}"
          aria-describedby={pipelineErrorDescribedBy(pipeline, 'sequence', sequenceErrors)}
        >
          <!-- Keyed by position, because the same Phase id may appear twice and a
               keyed-by-id `#each` would throw on the second one. -->
          {#each view.phases as _phaseId, position (position)}
            <div role="listitem">
              <PipelineFlowNode
                {view}
                {position}
                errorRegionId={pipelineErrorRegionId(pipeline, `phase-${position}`)}
              />
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Under the lane: a sequence error names the list as a whole, so it belongs
         beside the list rather than on any one card. -->
    <PipelineFieldErrors
      id={pipelineErrorRegionId(pipeline, 'sequence')}
      errors={sequenceErrors}
      testId="pipelines-sequence-errors"
    />
  {/if}
</div>
