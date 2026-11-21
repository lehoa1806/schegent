<script lang="ts">
  // The Phases tab's list page: a search and a status filter, the Phases as a table in their
  // authored order, and the import region under it.
  //
  // A row shows what FR-003 lets a list row show, the Phase's name, its id and its state and
  // validity badges, plus the model warning and the order buttons the old list had beside it. The
  // name opens the Phase's editor page, which holds every other action. The filter only hides
  // rows: every write still addresses the whole list by index, which is why a move is refused
  // while the filter hides any row.
  import type { Snippet } from 'svelte';
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import CatalogEmptyState from '../Builder/CatalogEmptyState.svelte';
  import DefinitionLifecycleRow from '../Builder/DefinitionLifecycleRow.svelte';
  import ProcessImportPreflight from '../ProcessImport/ProcessImportPreflight.svelte';
  import type { ImportTargetLayers } from '../ProcessImport/process-import-state';
  import {
    PHASE_STATUS_VIEWS,
    phaseCountLine,
    phaseRowVisible,
    type PhaseRowFacts,
    type PhaseStatusView
  } from './phase-catalog-view';
  import type { MutablePhase } from './types';

  interface Props {
    phases: MutablePhase[];
    /** A row's stored lifecycle, by its source key; absent for a row not saved yet. */
    lifecycleOf: (sourceKey: string) => BuilderLifecycle | undefined;
    importLayers: ImportTargetLayers;
    /** Why an import cannot start right now, or null. */
    importUnavailable: string | null;
    historyIndex: number;
    historyLength: number;
    trusted: boolean;
    savePending: boolean;
    mutationActive: boolean;
    editableSourceKey: string | null;
    /** The search box's text. Bound, so it outlives the list while a Phase is open. */
    query?: string;
    /** The status filter. Bound for the same reason. */
    view?: PhaseStatusView;
    /** The source key of the row whose editor just closed, taken once, or null. */
    takeReturnFocus: () => string | null;
    /** The catalog's banners and warnings, drawn above the toolbar. */
    notices?: Snippet;
    onselect: (index: number) => void;
    onadd: () => void;
    onmoveup: (index: number) => void;
    onmovedown: (index: number) => void;
    onundo: () => void;
    onredo: () => void;
    onsave: () => void;
  }

  let {
    phases,
    lifecycleOf,
    importLayers,
    importUnavailable,
    historyIndex,
    historyLength,
    trusted,
    savePending,
    mutationActive,
    editableSourceKey,
    query = $bindable(''),
    view = $bindable<PhaseStatusView>('all'),
    takeReturnFocus,
    notices,
    onselect,
    onadd,
    onmoveup,
    onmovedown,
    onundo,
    onredo,
    onsave
  }: Props = $props();

  function rowFacts(phase: MutablePhase): PhaseRowFacts {
    return {
      name: phase.name,
      id: phase.id,
      description: phase.description,
      sourceStatus: phase.sourceStatus,
      state: lifecycleOf(phase.sourceKey)?.state
    };
  }

  /** The rows the search and the filter keep, each with its index in the whole list. */
  const rows = $derived(
    phases
      .map((phase, index) => ({ phase, index }))
      .filter(({ phase }) => phaseRowVisible(rowFacts(phase), view, query))
  );
  const filtered = $derived(query.trim() !== '' || view !== 'all');
  /** A move is refused while any edit is pending, as the list's move buttons always were. */
  const moveBlocked = $derived(!trusted || savePending || mutationActive || filtered);

  /**
   * The list comes back when a Phase's editor closes, and the button that closed it left with the
   * editor, so focus would drop to the document. It goes back to that Phase's row instead; focus
   * the operator put somewhere else stays where it is.
   */
  function restoreFocus(node: HTMLElement): void {
    const key = takeReturnFocus();
    if (key === null) return;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body) return;
    [...node.querySelectorAll<HTMLElement>('[data-row-key]')]
      .find((element) => element.dataset.rowKey === key)
      ?.focus();
  }
</script>

<div class="phase-catalog-page" use:restoreFocus>
  {@render notices?.()}

  <div class="toolbar">
    {#if phases.length > 0}
      <div class="search">
        <svg class="i" aria-hidden="true"><use href="#i-search"></use></svg>
        <input class="input" type="search" placeholder="Search phases" aria-label="Search phases" data-testid="phases-search" bind:value={query} />
      </div>
      <div class="seg" role="group" aria-label="Status">
        {#each PHASE_STATUS_VIEWS as option (option.id)}
          <button type="button" aria-pressed={view === option.id} data-testid="phases-show-{option.id}" onclick={() => (view = option.id)}>{option.label}</button>
        {/each}
      </div>
    {/if}
    <div class="push">
      <!-- The list's own edits are its moves; a Phase's other edits are made, undone and saved on
           its editor page. So the list offers these only while an edit is pending. -->
      {#if mutationActive}
        <span class="chip s-warn" data-testid="phases-unsaved">Unsaved changes</span>
        <button type="button" class="icon-btn" aria-label="Undo" title="Undo" disabled={!trusted || savePending || historyIndex <= 0} onclick={onundo}><svg class="i" aria-hidden="true"><use href="#i-undo"></use></svg></button>
        <button type="button" class="icon-btn" aria-label="Redo" title="Redo" disabled={!trusted || savePending || historyIndex >= historyLength - 1} onclick={onredo}><svg class="i" aria-hidden="true"><use href="#i-redo"></use></svg></button>
        <button type="button" class="btn btn-primary" data-testid="phases-save-all" disabled={!trusted || savePending} onclick={onsave}>{savePending ? 'Saving…' : 'Save'}</button>
      {/if}
      <button type="button" class="btn {mutationActive ? 'btn-secondary' : 'btn-primary'}" data-testid="phases-add" disabled={!trusted || savePending || mutationActive} onclick={onadd}><svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>New phase</button>
    </div>
  </div>

  {#if phases.length > 0}
    {#if rows.length > 0}
      <div class="table-wrap">
        <table class="t fit">
          <caption class="sr-only">Phases</caption>
          <thead>
            <tr>
              <th scope="col">Phase</th>
              <th scope="col">Status</th>
              <th scope="col" class="order"><span class="sr-only">Order</span></th>
            </tr>
          </thead>
          <tbody>
            {#each rows as { phase, index } (phase.sourceKey)}
              {@const name = phase.name || 'Untitled Phase'}
              <tr>
                <td>
                  <!-- Feature 099 (T494a, FR-043) — no scope badge. A badge that can
                       only ever read one value is not a badge. -->
                  <button type="button" class="rowname" data-testid="phases-list-item-{phase.id}" data-row-key={phase.sourceKey} onclick={() => onselect(index)}>{name}</button>
                  <span class="mono muted small">{phase.id}</span>
                </td>
                <td>
                  <!-- In its own cell, not inside the name's button: T042 hung the
                       lifecycle chrome off the row, and a control nested in a button is
                       invalid markup and unreachable by keyboard. -->
                  <div class="status-cell">
                    <DefinitionLifecycleRow definitionId={phase.id} lifecycle={lifecycleOf(phase.sourceKey)} validity={phase.sourceStatus} />
                    <!-- Feature 101 (T037) — the validity badge left with the lifecycle
                         chrome. Model availability is a runtime fact about the backend, not
                         a lifecycle state, so it stayed on the row. -->
                    {#if phase.modelAvailable === false}
                      <span class="chip s-err"><svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg>model unavailable</span>
                    {/if}
                    {#if mutationActive && editableSourceKey === phase.sourceKey}
                      <span class="chip s-warn" data-testid="phases-row-unsaved-{phase.id}">Unsaved changes</span>
                    {/if}
                  </div>
                </td>
                <td class="order">
                  <!-- Feature 099 (T494a, FR-043) — the two guards these lost asked
                       whether the row or its neighbour sat in a different layer. One
                       layer, so every row is reorderable against every other. -->
                  <button type="button" class="icon-btn" aria-label="Move {name} up" title="Move up" data-testid="phases-move-up-{phase.id}" disabled={moveBlocked || index === 0} onclick={() => onmoveup(index)}><svg class="i" aria-hidden="true"><use href="#i-up"></use></svg></button>
                  <button type="button" class="icon-btn" aria-label="Move {name} down" title="Move down" data-testid="phases-move-down-{phase.id}" disabled={moveBlocked || index === phases.length - 1} onclick={() => onmovedown(index)}><svg class="i" aria-hidden="true"><use href="#i-down"></use></svg></button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p class="empty" data-testid="phases-no-match">No Phases match the search or the status filter.</p>
    {/if}
    <p class="countline" data-testid="phases-countline">{phaseCountLine(rows.length, phases.length)}</p>
  {/if}

  <!-- Feature 101 (US6, T065, FR-032/FR-033) — the front door, and it brings its
       own import region. Ordered after the trust check by construction: an
       untrusted workspace never renders this editor at all (PipelineBuilder gates
       the three definition tabs), so guidance can never point at an action that
       cannot succeed. It self-guards on the count, so the condition for showing it
       is stated once, in the component that owns it. -->
  <CatalogEmptyState kind="phase" count={phases.length} disabledReason={importUnavailable} />
  {#if phases.length > 0}
    <!-- FR-053 — the import entry point. Its own region rather than a toolbar button,
         because the preflight it opens renders in place: the plan, the scope choice,
         and the per-row result all belong to this landmark. Withheld while the
         catalog is empty because the empty state above already offers one, and two
         import regions on one screen is two answers to one question. -->
    <ProcessImportPreflight layers={importLayers} disabledReason={importUnavailable} />
  {/if}
</div>

<style>
  /* sg-pages' `.toolbar`, `.table-wrap`, `table.t`, `.rowname` and `.countline` draw the list;
     these place what the redesign sets inline. */
  .status-cell {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--schegent-space-1);
  }

  /* The two order buttons keep to one line at the row's end, and the column takes only their
     width, so the name and the status share the rest. */
  .order {
    width: 1%;
    white-space: nowrap;
    text-align: right;
  }
</style>
