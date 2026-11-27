<script lang="ts">
  // The Phases tab's list page: search, status filter, primary `+ New phase`,
  // optional unsaved-edits attention banner, table with per-row `⋯` menus, and
  // framed empty state delegating import to the single top-level Builder modal.
  import type { Snippet } from 'svelte';
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import CatalogEmptyState from '../Builder/CatalogEmptyState.svelte';
  import DefinitionLifecycleRow from '../Builder/DefinitionLifecycleRow.svelte';
  import ProcessExportButton from '../ProcessImport/ProcessExportButton.svelte';
  import { phaseExportAvailability } from '../ProcessImport/process-exchange-entry';
  import SgMenu from '../sg/SgMenu.svelte';
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
    /** Why top-level import cannot start (e.g. secondary window), or null. */
    importDisabledReason?: string | null;
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
    onduplicate: (index: number) => void;
    onremove: (index: number, originatingElement?: HTMLElement | null) => void | Promise<void>;
    onopenimport?: (originatingElement: HTMLElement | null) => void;
  }

  let {
    phases,
    lifecycleOf,
    importDisabledReason = null,
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
    onduplicate,
    onremove,
    onopenimport
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

  /** When the operator returned to the list with an unsaved Phase edit, name it for quick resume. */
  const editedEntry = $derived(
    mutationActive && editableSourceKey !== null
      ? (phases
          .map((phase, index) => ({ phase, index }))
          .find(({ phase }) => phase.sourceKey === editableSourceKey) ?? null)
      : null
  );

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

  {#if editedEntry}
    <div class="attn warn" role="status" aria-live="polite" data-testid="phases-unsaved-banner">
      <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
      <div class="body">
        <strong>{editedEntry.phase.name || editedEntry.phase.id || 'Untitled Phase'}</strong> has unsaved changes.
      </div>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        data-testid="phases-resume-editing"
        onclick={() => onselect(editedEntry.index)}
      >Resume editing</button>
    </div>
  {/if}

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
      <button type="button" class="btn btn-primary" data-testid="phases-add" disabled={!trusted || savePending || mutationActive} onclick={onadd}><svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>New phase</button>
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
              <th scope="col" class="row-actions-col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each rows as { phase, index } (phase.sourceKey)}
              {@const name = phase.name || 'Untitled Phase'}
              {@const exportable = phaseExportAvailability(phase)}
              <tr>
                <td>
                  <button type="button" class="rowname" data-testid="phases-list-item-{phase.id}" data-row-key={phase.sourceKey} onclick={() => onselect(index)}>{name}</button>
                  <span class="mono muted small">{phase.id}</span>
                </td>
                <td>
                  <div class="status-cell">
                    <DefinitionLifecycleRow definitionId={phase.id} lifecycle={lifecycleOf(phase.sourceKey)} validity={phase.sourceStatus} />
                    {#if phase.modelAvailable === false}
                      <span class="chip s-err"><svg class="i" aria-hidden="true"><use href="#i-warn"></use></svg>model unavailable</span>
                    {/if}
                    {#if mutationActive && editableSourceKey === phase.sourceKey}
                      <span class="chip s-warn" data-testid="phases-row-unsaved-{phase.id}">Unsaved changes</span>
                    {/if}
                  </div>
                </td>
                <td class="row-actions-col">
                  <SgMenu label="Actions for {name}" testid="phases-row-menu-{phase.id}">
                    <button type="button" role="menuitem" data-testid="phases-row-open-{phase.id}" onclick={() => onselect(index)}><svg class="i" aria-hidden="true"><use href="#i-open"></use></svg>Open</button>
                    <button type="button" role="menuitem" data-testid="phases-row-duplicate-{phase.id}" aria-disabled={!trusted || savePending || mutationActive} onclick={() => { if (trusted && !savePending && !mutationActive) onduplicate(index); }}><svg class="i" aria-hidden="true"><use href="#i-copy"></use></svg>Duplicate</button>
                    <ProcessExportButton
                      phaseId={phase.id}
                      rowKey={phase.sourceKey}
                      resolves={exportable.resolves}
                      disabledReason={exportable.disabledReason}
                    />
                    <hr />
                    <button type="button" role="menuitem" class="danger" data-testid="phases-row-remove-{phase.id}" aria-disabled={!trusted || savePending || !phase.persisted || mutationActive} onclick={(event) => { if (trusted && !savePending && phase.persisted && !mutationActive) void onremove(index, event.currentTarget); }}><svg class="i" aria-hidden="true"><use href="#i-trash"></use></svg>Deactivate…</button>
                  </SgMenu>
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

  <CatalogEmptyState
    kind="phase"
    count={phases.length}
    disabledReason={importDisabledReason}
    onimport={onopenimport}
  />
</div>

<style>
  .status-cell {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--schegent-space-1);
  }

  .row-actions-col {
    width: 1%;
    white-space: nowrap;
    text-align: right;
  }
</style>
