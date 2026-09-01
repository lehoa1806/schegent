<script lang="ts">
  // Feature 184 (FR-R3-141, T030) — the Pipeline canvas Builder: the top bar, the
  // action bar, and the three panes under `.wf-shell`.
  //
  // This file owns the view state no host projection can supply — what is
  // selected, and whether the palette is showing — and the derivations that read
  // the whole catalog rather than one row: the draft errors that gate the save,
  // the read-only rule, and the stored baseline the top bar compares against.
  // Everything else it forwards.
  //
  // Selection is by **position** and resets when the open row changes (D-5).
  // Indices address the authored sequence, so a selection carried across rows
  // would point at a different Phase — or at nothing — in the new one. It also
  // *clamps* when a removal shortens the sequence below the selected position,
  // which the Workflow builder has no equivalent of because its selection is by
  // node id.
  //
  // No rule is expressible in this markup. Every edit leaves through the same
  // callbacks the split pane used, so the rules stay in `pipeline-catalog-state.ts`
  // and in the store.
  import type { BuilderLifecycle, WorkflowSnapshot } from '../../lib/snapshot-types';
  import {
    pipelineAnchoredErrors,
    pipelineConsumingWorkflows,
    pipelineErrorsAt,
    pipelinePortAppended,
    pipelinePortPatched,
    pipelinePortRemoved,
    sourceRecordToMutablePipeline,
    validatePipelineDraft,
    type PipelineDraftError
  } from './pipeline-catalog-state';
  import PipelineFlowCanvas from './PipelineFlowCanvas.svelte';
  import PipelineFlowTopBar from './PipelineFlowTopBar.svelte';
  import PipelineInspector from './PipelineInspector.svelte';
  import PipelinePhasePalette from './PipelinePhasePalette.svelte';
  import PipelineToolbar from './PipelineToolbar.svelte';
  import type { PipelineFlowSelection, PipelineFlowView } from './pipeline-flow-view';
  import type { MutablePhase, MutablePipeline, PipelinePortPatch } from './types';

  interface Props {
    snapshot: WorkflowSnapshot;
    pipelines: readonly MutablePipeline[];
    phases: readonly MutablePhase[];
    selectedIndex: number | null;
    historyIndex: number;
    historyLength: number;
    trusted: boolean;
    savePending: boolean;
    mutationActive: boolean;
    editableSourceKey: string | null;
    getPhaseTooltip: (phaseId: string) => string;
    onselect: (index: number | null) => void;
    onadd: () => void;
    onremove: (index: number, originatingElement?: HTMLElement | null) => void | Promise<void>;
    onreset: (index: number) => void;
    onduplicate: (index: number) => void;
    onpipelinechange: (index: number, patch: Partial<MutablePipeline>) => void;
    onphasechange: (pipelineIndex: number, phaseIndex: number, phaseId: string) => void;
    onundo: () => void;
    onredo: () => void;
    onsave: () => void;
    onaddphase: (phaseId: string) => void;
    onremovephase: (index: number) => void;
    onmovephaseup: (index: number) => void;
    onmovephasedown: (index: number) => void;
  }

  const p: Props = $props();

  let selection = $state<PipelineFlowSelection>({ kind: 'pipeline' });
  let paletteOpen = $state(true);
  let openedKey = $state<string | null>(null);

  const selectedPipeline = $derived(
    p.selectedIndex !== null ? (p.pipelines[p.selectedIndex] ?? null) : null
  );

  /**
   * FR-034 — a Pipeline is an ordered sequence of Phases, so with no effective
   * Phase there is nothing a Pipeline could be composed of.
   */
  const noEffectivePhase = $derived(p.phases.length === 0);

  const selectedReadOnly = $derived(
    !p.trusted ||
      p.savePending ||
      (p.editableSourceKey !== null && selectedPipeline?.sourceKey !== p.editableSourceKey)
  );

  // Advisory pre-flight validation over the authorable rows. The host still
  // re-validates every save; this only keeps an obviously invalid draft from
  // consuming a round trip, and blocks the save button while it stands.
  const draftErrors = $derived(
    p.pipelines.flatMap((pipeline) =>
      validatePipelineDraft(pipeline, p.pipelines).map((error) => ({
        ...error,
        sourceKey: pipeline.sourceKey
      }))
    )
  );

  // Only draft errors gate the save. `sourceErrors` describe the record as last
  // persisted and do not clear until the host reprojects, so blocking on them
  // would trap the operator inside the very row they opened to repair.
  const saveDisabled = $derived(
    !p.trusted || p.savePending || noEffectivePhase || draftErrors.length > 0
  );

  const anchoredErrors = $derived(pipelineAnchoredErrors(selectedPipeline, draftErrors));
  const sequenceErrors = $derived(
    pipelineErrorsAt(anchoredErrors, (anchor) => anchor.kind === 'sequence')
  );

  const lifecycleByKey = $derived(
    new Map<string, BuilderLifecycle | undefined>(
      (p.snapshot.pipelineCatalog?.records ?? []).map((record) => [record.key, record.lifecycle])
    )
  );

  /**
   * The open row as the catalog last stored it, for FR-013's unsaved-draft
   * status. Projected from the record rather than tracked as a flag: `persisted`
   * says the host has *seen* this id, which stays true through every unsaved
   * edit that follows.
   */
  const baseline = $derived.by(() => {
    const key = selectedPipeline?.sourceKey;
    if (key === undefined) return null;
    const record = (p.snapshot.pipelineCatalog?.records ?? []).find((entry) => entry.key === key);
    return record ? sourceRecordToMutablePipeline(record) : null;
  });

  /**
   * D-5. Two corrections in one pass, in order: the open row changing resets the
   * selection outright, and a sequence that no longer reaches the selected
   * position clamps to its last card. The clamp exists because removing a card
   * is the ordinary way to shorten a sequence, and leaving the selection past the
   * end would render an inspector `<select>` for a position that is not there.
   */
  $effect(() => {
    const key = selectedPipeline?.sourceKey ?? null;
    if (openedKey !== key) {
      openedKey = key;
      selection = { kind: 'pipeline' };
      return;
    }
    if (selection.kind !== 'phase') return;
    const length = selectedPipeline?.phases.length ?? 0;
    if (selection.position < length) return;
    selection = length === 0 ? { kind: 'pipeline' } : { kind: 'phase', position: length - 1 };
  });

  const view = $derived<PipelineFlowView>({
    phases: selectedPipeline?.phases ?? [],
    catalog: p.phases,
    phaseDefects: (selectedPipeline?.phases ?? []).map((_phaseId, position) =>
      pipelineErrorsAt(
        anchoredErrors,
        (anchor) => anchor.kind === 'phase' && anchor.position === position
      )
    ) as readonly (readonly PipelineDraftError[])[],
    getPhaseTooltip: p.getPhaseTooltip,
    readonly: selectedReadOnly,
    selection,
    onselect: (next) => (selection = next),
    onmoveup: p.onmovephaseup,
    onmovedown: p.onmovephasedown,
    onremove: p.onremovephase
  });

  const consumingWorkflows = $derived(
    selectedPipeline === null ? [] : pipelineConsumingWorkflows(p.snapshot, selectedPipeline)
  );

  function patchSelected(patch: Partial<MutablePipeline>): void {
    if (p.selectedIndex === null) return;
    p.onpipelinechange(p.selectedIndex, patch);
  }

  function addPort(kind: 'inputs' | 'outputs'): void {
    if (selectedPipeline === null) return;
    patchSelected(pipelinePortAppended(selectedPipeline, kind));
  }

  function removePort(kind: 'inputs' | 'outputs', index: number): void {
    if (selectedPipeline === null) return;
    patchSelected(pipelinePortRemoved(selectedPipeline, kind, index));
  }

  function changePort(kind: 'inputs' | 'outputs', index: number, patch: PipelinePortPatch): void {
    if (selectedPipeline === null) return;
    patchSelected(pipelinePortPatched(selectedPipeline, kind, index, patch));
  }
</script>

<PipelineFlowTopBar
  rows={p.pipelines}
  selected={selectedPipeline}
  selectedIndex={p.selectedIndex}
  {baseline}
  {lifecycleByKey}
  onselect={p.onselect}
/>

<PipelineToolbar
  pipeline={selectedPipeline}
  selectedIndex={p.selectedIndex}
  trusted={p.trusted}
  savePending={p.savePending}
  mutationActive={p.mutationActive}
  {noEffectivePhase}
  readonly={selectedReadOnly}
  {saveDisabled}
  historyIndex={p.historyIndex}
  historyLength={p.historyLength}
  onadd={p.onadd}
  onundo={p.onundo}
  onredo={p.onredo}
  onsave={p.onsave}
  ondiscard={p.onreset}
  onduplicate={p.onduplicate}
  onremove={p.onremove}
/>

<div class="wf-shell" data-testid="pipelines-flow-builder">
  {#if paletteOpen}
    <PipelinePhasePalette
      phases={p.phases}
      readonly={selectedReadOnly || p.selectedIndex === null}
      onaddphase={p.onaddphase}
      onclose={() => (paletteOpen = false)}
    />
  {:else}
    <div class="wf-palette-rail" data-testid="pipelines-palette-rail">
      <button
        class="icon-btn"
        data-testid="pipelines-palette-open"
        aria-label="Show the Phases palette"
        onclick={() => (paletteOpen = true)}>›</button
      >
    </div>
  {/if}

  <PipelineFlowCanvas pipeline={selectedPipeline} {view} {sequenceErrors} />

  {#if selectedPipeline !== null}
    <PipelineInspector
      pipeline={selectedPipeline}
      phases={p.phases}
      {selection}
      readonly={selectedReadOnly}
      {anchoredErrors}
      {consumingWorkflows}
      lifecycle={lifecycleByKey.get(selectedPipeline.sourceKey)}
      onpipelinechange={patchSelected}
      onphasechange={(position, phaseId) =>
        p.selectedIndex !== null && p.onphasechange(p.selectedIndex, position, phaseId)}
      onaddport={addPort}
      onremoveport={removePort}
      onportchange={changePort}
    />
  {/if}
</div>
