<script lang="ts">
  // Feature 184 (FR-R3-141, T026) — the canvas Builder's header: which Pipeline is
  // open, and what state it is in.
  //
  // The name renders as TEXT (FR-010). `pipelines-title-{id}` was an input bound to
  // the same value as the inspector's Name field, and its own comment said so; two
  // inputs writing one field is the thing this rework removes, not a thing it
  // relocates. The Name field in the inspector is now the only one.
  //
  // The Library list moved into the popover unchanged, so its rows keep their ids
  // and their `DefinitionLifecycleRow`. A bespoke dropdown would have dropped both.
  //
  // The action bar is NOT here — `PipelineToolbar` renders below this row, because
  // two of its controls (the export prerequisite, the no-effective-Phase notice)
  // are block-level explanations that belong beside the control they disable, and a
  // flex header row is the wrong parent for them.
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import { isPipelineDirty } from './pipeline-catalog-state';
  import PipelineLibraryList from './PipelineLibraryList.svelte';
  import type { MutablePipeline } from './types';

  interface Props {
    rows: readonly MutablePipeline[];
    selected: MutablePipeline | null;
    selectedIndex: number | null;
    /**
     * The open row as last stored, or null for a row the host has never accepted.
     * FR-013 asks whether the draft *diverges*, which `persisted` cannot answer:
     * a stored row edited and not yet saved is persisted and unsaved at once.
     */
    baseline: MutablePipeline | null;
    lifecycleByKey: ReadonlyMap<string, BuilderLifecycle | undefined>;
    onselect: (index: number) => void;
  }

  const { rows, selected, selectedIndex, baseline, lifecycleByKey, onselect }: Props = $props();

  /**
   * Null until the operator opens or closes the picker themselves, and a boolean
   * after that.
   *
   * The default it falls back to is "open while nothing is selected": the Library
   * list moved in here, so the picker is now the only way to open a Pipeline, and
   * starting closed with no selection would leave the operator looking at an empty
   * canvas with no visible way in. Held as an override rather than as an
   * initialised flag so the default is *derived* — a `$state` seeded from
   * `selected` would capture only its value at mount.
   */
  let overridden = $state<boolean | null>(null);
  const open = $derived(overridden ?? selected === null);

  const unsaved = $derived(selected !== null && isPipelineDirty(selected, baseline));

  function choose(index: number): void {
    onselect(index);
    overridden = false;
  }
</script>

<!-- Escape closes the popover from anywhere inside it, including from a row. A
     dropdown that only closes by clicking its trigger again is a keyboard trap. -->
<div
  class="wf-topbar"
  data-testid="pipelines-topbar"
  onkeydown={(event) => {
    if (event.key === 'Escape') overridden = false;
  }}
  role="presentation"
>
  <div class="wf-picker">
    <button
      class="wf-topbar-name"
      data-testid="pipelines-picker-toggle"
      aria-expanded={open}
      aria-haspopup="true"
      aria-label="Choose a Pipeline"
      onclick={() => (overridden = !open)}
    >
      <span class="wf-topbar-name-text" data-testid="pipelines-topbar-name">
        {selected?.name ?? 'No Pipeline selected'}
      </span>
      <span aria-hidden="true">⌄</span>
    </button>

    {#if open}
      <div class="wf-picker-pop" data-testid="pipelines-picker-list">
        <PipelineLibraryList {rows} {selectedIndex} {lifecycleByKey} onselect={choose} />
      </div>
    {/if}
  </div>

  {#if selected}
    <div class="phase-badges">
      <span class="status-badge status-{selected.sourceStatus}" data-testid="pipelines-topbar-status">
        {selected.sourceStatus}
      </span>
      <!-- An unsaved draft is the one state the canvas cannot show: an edited row
           looks identical to a stored one until a save is attempted. -->
      {#if unsaved}
        <span class="wf-badge" data-testid="pipelines-topbar-unsaved">unsaved draft</span>
      {/if}
    </div>
  {/if}
</div>
