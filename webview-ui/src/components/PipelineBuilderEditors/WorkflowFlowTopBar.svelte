<script lang="ts">
  // The canvas Builder's header: which Workflow is open, and what state it is in.
  //
  // The reference design puts the name and a chevron where a sidebar list used to
  // be, and that is the whole of this component: the Library list is unchanged and
  // simply moved inside the popover. Keeping `WorkflowLibraryList` rather than
  // reimplementing a picker keeps its row summary — purpose, Pipeline sequence,
  // derived ports, validation state — and keeps the lifecycle controls
  // (`DefinitionLifecycleRow`) exactly where they already were. A bespoke dropdown
  // would have dropped all of it.
  //
  // The action bar is NOT here. `WorkflowToolbar` renders below this row because
  // two of its controls (the export prerequisite, the no-effective-Pipeline notice)
  // are block-level explanations that sit with the control they disable, and a flex
  // header row is the wrong parent for them.
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import type { MutableWorkflow } from './types';
  import WorkflowLibraryList from './WorkflowLibraryList.svelte';

  interface Props {
    rows: readonly MutableWorkflow[];
    selected: MutableWorkflow | null;
    selectedKey: string | null;
    lifecycleByKey: ReadonlyMap<string, BuilderLifecycle | undefined>;
    onselect: (sourceKey: string) => void;
  }

  const { rows, selected, selectedKey, lifecycleByKey, onselect }: Props = $props();

  /**
   * Null until the operator opens or closes the picker themselves, and a boolean
   * after that.
   *
   * The default it falls back to is "open while nothing is selected": the Library
   * list moved in here, so the picker is now the only way to select a Workflow, and
   * starting closed with no selection would leave the operator looking at an empty
   * canvas with no visible way in. Held as an override rather than as an
   * initialised flag so the default is *derived* — a `$state` seeded from
   * `selected` would capture only its value at mount.
   */
  let overridden = $state<boolean | null>(null);
  const open = $derived(overridden ?? selected === null);

  function choose(sourceKey: string): void {
    onselect(sourceKey);
    overridden = false;
  }
</script>

<!-- Escape closes the popover from anywhere inside it, including from a row. A
     dropdown that only closes by clicking its trigger again is a keyboard trap. -->
<div
  class="wf-topbar"
  data-testid="workflow-topbar"
  onkeydown={(event) => {
    if (event.key === 'Escape') overridden = false;
  }}
  role="presentation"
>
  <div class="wf-picker">
    <button
      class="wf-topbar-name"
      data-testid="workflow-picker-toggle"
      aria-expanded={open}
      aria-haspopup="true"
      aria-label="Choose a Workflow"
      onclick={() => (overridden = !open)}
    >
      <span class="wf-topbar-name-text">{selected?.name ?? 'No Workflow selected'}</span>
      <span aria-hidden="true">⌄</span>
    </button>

    {#if open}
      <div class="wf-picker-pop" data-testid="workflow-picker-list">
        <WorkflowLibraryList {rows} {selectedKey} {lifecycleByKey} onselect={choose} />
        <!-- Outside the list: an empty catalog is not a row. `CatalogEmptyState`
             below the header owns the guidance; this only explains the blank. -->
        {#if rows.length === 0}
          <div class="wf-palette-empty" data-testid="workflow-picker-empty">
            No Workflow yet.
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if selected}
    <div class="phase-badges">
      <span class="status-badge status-{selected.sourceStatus}" data-testid="workflow-topbar-status">
        {selected.sourceStatus}
      </span>
      <!-- An unsaved draft is the one state the canvas cannot infer from the
           canvas: it looks identical to a stored row until a save is attempted. -->
      {#if !selected.persisted}
        <span class="wf-badge" data-testid="workflow-topbar-unsaved">unsaved draft</span>
      {/if}
    </div>
  {/if}
</div>
