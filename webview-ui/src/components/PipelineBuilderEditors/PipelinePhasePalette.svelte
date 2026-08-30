<script lang="ts">
  // Feature 184 (FR-R3-141, T011) — the Phases palette: what can be added to the
  // sequence.
  //
  // Replaces the `<select>` + "Add Phase" button pair at the bottom of the old
  // form. That pair needed a pending value between its two halves; a palette does
  // not, because the click IS the commit. `PipelineCatalogStore.newPhaseId` and
  // `appendPhase()` existed only to hold that pending value and were removed with
  // it (FR-030) — a deliberate, recorded departure from T1550's filed wording.
  //
  // Every item is a BUTTON and the six-dot glyph beside it is decoration
  // (`aria-hidden`), following `WorkflowActionPalette`: click and Enter are the
  // operation, not a fallback to it.
  //
  // The one group is the effective Phase catalog and nothing else. There is no
  // Logic group and no Split (FR-027): a split is a second connection leaving a
  // node, and a Pipeline sequence has no connections to split. Rendering one here
  // would offer a control that could not do anything.
  import type { MutablePhase } from './types';

  interface Props {
    phases: readonly MutablePhase[];
    readonly: boolean;
    onaddphase: (phaseId: string) => void;
    onclose: () => void;
  }

  const { phases, readonly, onaddphase, onclose }: Props = $props();
</script>

<div class="wf-palette" data-testid="pipelines-palette">
  <div class="wf-palette-head">
    <h3 id="pipelines-palette-label">Phases</h3>
    <button
      class="icon-btn"
      data-testid="pipelines-palette-close"
      aria-label="Hide the Phases palette"
      onclick={onclose}>‹</button
    >
  </div>

  <div class="wf-palette-group" aria-labelledby="pipelines-palette-phases">
    <div class="wf-palette-group-label" id="pipelines-palette-phases">Phases</div>
    {#each phases as phase (phase.sourceKey)}
      <button
        class="wf-palette-item"
        data-testid="pipelines-palette-phase-{phase.id}"
        disabled={readonly}
        title={phase.description ?? phase.name}
        onclick={() => onaddphase(phase.id)}
      >
        <span class="wf-chip wf-chip-pipeline" aria-hidden="true">
          {phase.name.slice(0, 1).toUpperCase() || 'P'}
        </span>
        <span class="wf-palette-label">{phase.name}</span>
        <span class="wf-handle" aria-hidden="true">⠿</span>
      </button>
    {/each}
    <!-- Outside the loop: an empty catalog is not a Phase. 082's FR-034 — a
         Pipeline is an ordered sequence of Phases, so with none effective there
         is nothing to add, and the reason sits with the control it disables. -->
    {#if phases.length === 0}
      <div class="wf-palette-empty" data-testid="pipelines-palette-no-phases">
        No effective Phase to add.
      </div>
    {/if}
  </div>
</div>
