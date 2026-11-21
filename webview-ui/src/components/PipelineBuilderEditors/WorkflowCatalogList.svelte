<script lang="ts">
  // Feature 326 — Workflows list page mirroring `PhaseCatalogList.svelte`:
  // search, status filter (`All | Active | Draft | Invalid`), primary
  // `+ New workflow`, unsaved-edits attention banner (`Resume editing`), table
  // with `Workflow`, `Status`, `Steps`, and per-row `⋯` menu, plus framed empty
  // state wired to the single top-level Builder Import modal.
  import type { Snippet } from 'svelte';
  import type { BuilderLifecycle } from '../../lib/snapshot-types';
  import CatalogEmptyState from '../Builder/CatalogEmptyState.svelte';
  import DefinitionLifecycleRow from '../Builder/DefinitionLifecycleRow.svelte';
  import { workflowExportDisabledReason } from '../ProcessImport/process-exchange-entry';
  import SgMenu from '../sg/SgMenu.svelte';
  import type { MutableWorkflow } from './types';
  import {
    WORKFLOW_STATUS_VIEWS,
    workflowCountLine,
    workflowRowVisible,
    type WorkflowRowFacts,
    type WorkflowStatusView
  } from './workflow-catalog-view';

  interface Props {
    rows: readonly MutableWorkflow[];
    lifecycleByKey: ReadonlyMap<string, BuilderLifecycle | undefined>;
    dirtyKeys: ReadonlySet<string>;
    mutatingDisabled: boolean;
    importDisabledReason?: string | null;
    query?: string;
    view?: WorkflowStatusView;
    takeReturnFocus: () => string | null;
    notices?: Snippet;
    onselect: (sourceKey: string) => void;
    onadd: () => void;
    onduplicate: (sourceKey: string) => void;
    onexport: (row: MutableWorkflow, originatingElement: HTMLElement | null) => void;
    onremove: (row: MutableWorkflow, originatingElement: HTMLElement | null) => void | Promise<void>;
    onopenimport?: (originatingElement: HTMLElement | null) => void;
  }

  let {
    rows,
    lifecycleByKey,
    dirtyKeys,
    mutatingDisabled,
    importDisabledReason = null,
    query = $bindable(''),
    view = $bindable<WorkflowStatusView>('all'),
    takeReturnFocus,
    notices,
    onselect,
    onadd,
    onduplicate,
    onexport,
    onremove,
    onopenimport
  }: Props = $props();

  function rowFacts(row: MutableWorkflow): WorkflowRowFacts {
    return {
      name: row.name,
      workflowId: row.workflowId,
      description: row.description,
      sourceStatus: row.sourceStatus,
      state: lifecycleByKey.get(row.sourceKey)?.state
    };
  }

  const visibleRows = $derived(
    rows.filter((row) => workflowRowVisible(rowFacts(row), view, query))
  );

  const dirtyRows = $derived(rows.filter((row) => dirtyKeys.has(row.sourceKey)));

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

<div class="workflow-catalog-page" data-testid="workflow-catalog-list" use:restoreFocus>
  {@render notices?.()}

  {#if dirtyRows.length > 0}
    {@const firstDirty = dirtyRows[0]}
    <div class="attn warn" role="status" aria-live="polite" data-testid="workflows-unsaved-banner">
      <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
      <div class="body">
        {#if dirtyRows.length === 1}
          <strong>{firstDirty.name || firstDirty.workflowId || 'Untitled Workflow'}</strong> has unsaved changes.
        {:else}
          <strong>{dirtyRows.length} Workflows</strong> have unsaved changes (including {firstDirty.name || firstDirty.workflowId}).
        {/if}
      </div>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        data-testid="workflows-resume-editing"
        onclick={() => onselect(firstDirty.sourceKey)}
      >Resume editing</button>
    </div>
  {/if}

  <div class="toolbar">
    {#if rows.length > 0}
      <div class="search">
        <svg class="i" aria-hidden="true"><use href="#i-search"></use></svg>
        <input
          class="input"
          type="search"
          placeholder="Search workflows"
          aria-label="Search workflows"
          data-testid="workflows-search"
          bind:value={query}
        />
      </div>
      <div class="seg" role="group" aria-label="Status">
        {#each WORKFLOW_STATUS_VIEWS as option (option.id)}
          <button
            type="button"
            aria-pressed={view === option.id}
            data-testid="workflows-show-{option.id}"
            onclick={() => (view = option.id)}>{option.label}</button
          >
        {/each}
      </div>
    {/if}
    <div class="push">
      <button
        type="button"
        class="btn btn-primary"
        data-testid="workflows-add"
        disabled={mutatingDisabled}
        onclick={onadd}
        ><svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>New workflow</button
      >
    </div>
  </div>

  {#if rows.length > 0}
    {#if visibleRows.length > 0}
      <div class="table-wrap">
        <table class="t fit">
          <caption class="sr-only">Workflows</caption>
          <thead>
            <tr>
              <th scope="col">Workflow</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Steps</th>
              <th scope="col" class="row-actions-col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each visibleRows as row, rowIndex (row.sourceKey)}
              {@const name = row.name || 'Untitled Workflow'}
              {@const exportReason = workflowExportDisabledReason(row)}
              {@const exportReasonId = `workflows-row-export-reason-${rowIndex}`}
              <tr>
                <td>
                  <button
                    type="button"
                    class="rowname"
                    data-testid="workflows-list-item-{row.workflowId}"
                    data-row-key={row.sourceKey}
                    onclick={() => onselect(row.sourceKey)}>{name}</button
                  >
                  <span class="mono muted small">{row.workflowId}</span>
                </td>
                <td>
                  <div class="status-cell">
                    <DefinitionLifecycleRow
                      definitionId={row.workflowId}
                      lifecycle={lifecycleByKey.get(row.sourceKey)}
                      validity={row.sourceStatus}
                    />
                    {#if dirtyKeys.has(row.sourceKey)}
                      <span class="chip s-warn" data-testid="workflows-row-unsaved-{row.workflowId}"
                        >Unsaved changes</span
                      >
                    {/if}
                  </div>
                </td>
                <td class="num" data-testid="workflows-row-steps-{row.workflowId}"
                  >{row.nodes.length}</td
                >
                <td class="row-actions-col">
                  <SgMenu label="Actions for {name}" testid="workflows-row-menu-{row.workflowId}">
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="workflows-row-open-{row.workflowId}"
                      onclick={() => onselect(row.sourceKey)}
                      ><svg class="i" aria-hidden="true"><use href="#i-open"></use></svg>Open</button
                    >
                    <button
                      type="button"
                      role="menuitem"
                      data-testid="workflows-row-duplicate-{row.workflowId}"
                      aria-disabled={mutatingDisabled}
                      onclick={() => { if (!mutatingDisabled) onduplicate(row.sourceKey); }}
                      ><svg class="i" aria-hidden="true"><use href="#i-copy"></use></svg>Duplicate</button
                    >
                    <button
                      type="button"
                      role="menuitem"
                      class="export-item"
                      data-testid="workflows-row-export-{row.workflowId}"
                      aria-disabled={exportReason !== null}
                      aria-label={`Export YAML for ${row.workflowId}`}
                      aria-describedby={exportReason !== null ? exportReasonId : undefined}
                      onclick={(event) => {
                        if (exportReason === null) onexport(row, event.currentTarget);
                      }}
                      ><svg class="i" aria-hidden="true"><use href="#i-export"></use></svg><span
                        class="export-word">Export YAML…</span
                      >{#if exportReason !== null}<span
                          class="export-why"
                          id={exportReasonId}
                          data-testid="workflows-export-disabled-reason">{exportReason}</span
                        >{/if}</button
                    >
                    <hr />
                    <button
                      type="button"
                      role="menuitem"
                      class="danger"
                      data-testid="workflows-row-remove-{row.workflowId}"
                      aria-disabled={mutatingDisabled || !row.persisted}
                      onclick={(event) => {
                        if (!mutatingDisabled && row.persisted) void onremove(row, event.currentTarget);
                      }}
                      ><svg class="i" aria-hidden="true"><use href="#i-trash"></use></svg>Deactivate…</button
                    >
                  </SgMenu>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p class="empty" data-testid="workflows-no-match">
        No Workflows match the search or the status filter.
      </p>
    {/if}
    <p class="countline" data-testid="workflows-countline">
      {workflowCountLine(visibleRows.length, rows.length)}
    </p>
  {/if}

  <CatalogEmptyState
    kind="workflow"
    count={rows.length}
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

  :global(.menu) .export-item {
    display: grid;
    grid-template-columns: auto 1fr;
    row-gap: var(--schegent-space-0-5);
  }

  .export-why {
    grid-column: 2;
    max-width: 32ch;
    white-space: normal;
    font-size: var(--schegent-text-caption);
    color: var(--schegent-muted-fg);
  }
</style>
