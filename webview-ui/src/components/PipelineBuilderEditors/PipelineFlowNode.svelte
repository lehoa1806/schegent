<script lang="ts">
  // Feature 184 (FR-R3-141, T007) — one Phase card on the Pipeline canvas.
  //
  // The card is a button and selecting it is its only job: every edit to the
  // position happens in the inspector, so this file holds no field, no rule and
  // no write. The `<select>` that used to sit on the row moved there (FR-046).
  //
  // Reorder and remove stay BUTTONS beside the card, not a drag handle on it
  // (083's FR-042 — a drag is the one gesture a keyboard cannot make).
  //
  // Two deliberate departures from `WorkflowFlowNode.svelte`, both stated because
  // a reader who knows that file will otherwise read them as omissions:
  //
  //   * The three action buttons render ALWAYS and are disabled in place under
  //     `readonly` (C7-2). Workflow wraps them in `{#if !view.readonly}`, which
  //     is defensible there because its readonly is permanent — a stored row is
  //     never editable. Here readonly is transient (an in-flight save, another
  //     row's mutation, untrusted), so the controls have to keep their position
  //     rather than making the card reflow every time a save settles.
  //
  //   * The card is addressed by position, never by Phase id. The same Phase may
  //     appear twice in one sequence; see `pipeline-flow-view.ts`.
  //
  // The defect cue is a border AND a badge AND a described-by list: colour alone
  // reaches neither a screen reader nor a monochrome display.
  import PipelineFieldErrors from './PipelineFieldErrors.svelte';
  import { phaseOf, phaseTitle, phaseTooltip, type PipelineFlowView } from './pipeline-flow-view';

  interface Props {
    view: PipelineFlowView;
    position: number;
    /** `pipelineErrorRegionId(pipeline, 'phase-{position}')`, owned by the canvas. */
    errorRegionId: string;
  }

  const { view, position, errorRegionId }: Props = $props();

  const phaseId = $derived(view.phases[position] ?? '');
  const phase = $derived(phaseOf(view, position));
  const defects = $derived(view.phaseDefects[position] ?? []);
  const selected = $derived(
    view.selection?.kind === 'phase' && view.selection.position === position
  );
  const title = $derived(phaseTitle(view, position));
  /** First letter of what the card is titled by; see `.wf-chip` on why a letter. */
  const initial = $derived(title.slice(0, 1).toUpperCase() || '?');
</script>

<div class="wf-node-row">
  <div class="wf-node-col">
    <button
      class="wf-node"
      class:is-selected={selected}
      data-testid="pipelines-phase-card-{position}"
      data-invalid={defects.length > 0 ? 'true' : undefined}
      aria-pressed={selected}
      title={phaseTooltip(view, position)}
      aria-describedby={defects.length > 0 ? errorRegionId : undefined}
      onclick={() => view.onselect({ kind: 'phase', position })}
    >
      <span class="wf-node-head">
        <span class="wf-chip wf-chip-pipeline" aria-hidden="true">{initial}</span>
        <span class="wf-node-title" data-testid="pipelines-phase-title-{position}">{title}</span>
        <span class="wf-badge" data-testid="pipelines-phase-position-{position}">{position + 1}</span>
      </span>
      <!-- The id is shown even when the name resolved: a sequence naming the same
           Phase twice is legitimate, and the id is what tells the operator which
           definition each card runs. A position naming a Phase the effective
           catalog does not hold still shows its identifier, because that is the
           defect they have to act on. -->
      <span class="wf-node-body" data-testid="pipelines-phase-id-{position}">{phaseId}</span>
      <span class="wf-node-foot">
        {#if phase === null}
          <span class="wf-badge is-defect" data-testid="pipelines-phase-unknown-{position}">
            Unknown Phase
          </span>
        {/if}
        {#if defects.length > 0}
          <span class="wf-badge is-defect" data-testid="pipelines-phase-error-{position}">Error</span>
        {/if}
      </span>
    </button>
    <PipelineFieldErrors id={errorRegionId} errors={defects} />
  </div>

  <div class="wf-node-actions">
    <button
      class="icon-btn"
      data-testid="pipelines-move-phase-up-{position}"
      aria-label="Move Phase {position + 1} up"
      disabled={view.readonly || position === 0}
      onclick={() => view.onmoveup(position)}>↑</button
    >
    <button
      class="icon-btn"
      data-testid="pipelines-move-phase-down-{position}"
      aria-label="Move Phase {position + 1} down"
      disabled={view.readonly || position === view.phases.length - 1}
      onclick={() => view.onmovedown(position)}>↓</button
    >
    <button
      class="icon-btn destructive-icon"
      data-testid="pipelines-remove-phase-{position}"
      aria-label="Remove Phase {position + 1}"
      disabled={view.readonly}
      onclick={() => view.onremove(position)}>✕</button
    >
  </div>
</div>
