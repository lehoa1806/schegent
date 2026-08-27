<script lang="ts">
  // Feature 103 (T017, T018, T019) — History as one cross-queue list.
  //
  // The surface used to render `snapshot.history` directly, which is only half
  // of what a run history is: it held every queue's finished runs and none of
  // the runs currently going. Composition now happens here, from two parts of
  // the snapshot this component already receives, and writes nothing (FR-004).
  //
  // It takes the whole snapshot rather than two hand-picked fields because it
  // needs three and User Story 2 adds more, and because `builder`, `settings`
  // and `runs` already take the snapshot for the same reason.

  import type { WorkflowSnapshot } from '../lib/snapshot-types';
  import {
    applyRenderBound,
    catalogNamesFrom,
    composeHistoryRows,
    HISTORY_RENDER_BOUND
  } from '../lib/history-rows';
  import {
    applyFilters,
    buildFilterOptions,
    EMPTY_HISTORY_FILTERS,
    HISTORY_HOME,
    isFiltered,
    type HistoryLocation
  } from '../lib/history-filters';
  import { resolveRerunTarget } from '../lib/history-rerun';
  import HistoryFilterBar from './HistoryFilterBar.svelte';
  import HistorySection from './HistorySection.svelte';
  import HistoryRunDetail from './HistoryRunDetail.svelte';
  import HistoryRerunPanel from './HistoryRerunPanel.svelte';

  interface Props {
    snapshot: WorkflowSnapshot;
  }

  const { snapshot }: Props = $props();

  const isPrimary = $derived(snapshot.isPrimary);
  const allRows = $derived(composeHistoryRows(snapshot.history, snapshot.queues));

  // FR-021 (T033) — display names, resolved here because this is where the whole
  // snapshot is. Both catalogs are optional and absent while they load, which is
  // the case the id fallback exists for; a row is nameable before either arrives.
  const catalogNames = $derived(catalogNamesFrom(snapshot));

  let query = $state('');

  // FR-020, FR-057 (T042) — the surface's location: what it is narrowed to, and
  // which run is open. Component state, so it survives a drill-down and back
  // within this mount and nothing more; a reload opens on `HISTORY_HOME`, which
  // is the whole list.
  let location = $state<HistoryLocation>(HISTORY_HOME);

  const filters = $derived(location.filters);
  const filtered = $derived(applyFilters(allRows, filters, Date.now()));

  // Built from every row rather than the filtered ones: options derived from the
  // narrowed list would remove every queue but the selected one the moment a
  // queue was picked, leaving no way back other than clearing.
  const filterOptions = $derived(buildFilterOptions(allRows, filters, catalogNames));

  const matchingRows = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle.length === 0) return filtered;
    return filtered.filter((row) =>
      [row.descriptionPreview, row.runId, row.queueName]
        .some((value) => value.toLocaleLowerCase().includes(needle))
    );
  });

  const narrowed = $derived(isFiltered(filters) || query.trim().length > 0);

  function clearFilters(): void {
    location = { ...location, filters: EMPTY_HISTORY_FILTERS };
    query = '';
  }

  // FR-052 — bound the render and say so. `matched` is the honest total, and it
  // is stated even when nothing was cut: a count that only appears once the
  // list is truncated makes truncation look like a rendering glitch.
  const bounded = $derived(applyRenderBound(matchingRows));
  const truncated = $derived(bounded.shown < bounded.matched);

  // FR-020, FR-024 (T052) — the open run, resolved against the full set rather
  // than the filtered one. A detail that vanished because the operator's own
  // filters exclude the run they just opened would be the surface arguing with
  // itself. `null` when the row is gone — retention can remove it while the
  // detail is open — and the list is what shows instead.
  const selectedRow = $derived(
    location.selectedRunId === null
      ? null
      : (allRows.find((row) => row.runId === location.selectedRunId) ?? null)
  );

  function openDetail(runId: string): void {
    location = { ...location, selectedRunId: runId };
  }

  // The filters are untouched on the way back, which is the whole reason the
  // selection lives in `HistoryLocation` beside them (SC-005).
  function closeDetail(): void {
    location = { ...location, selectedRunId: null };
  }

  // FR-033 (T065) — which run the trigger form is open for, held apart from
  // `location` rather than added to it. `HistoryLocation` is what a reopened
  // surface should be restored to; a half-composed run form is not, and folding
  // it in would put an unsubmitted composition on the same footing as a filter.
  // Closing the panel therefore lands back on whatever the location already
  // says — the detail it was opened from, or the list with its filters intact.
  let rerunRunId = $state<string | null>(null);

  // Resolved against the full set for the same reason `selectedRow` is, and
  // `null` when the row is gone: retention can evict a run while its form is
  // open, and a form for a run that no longer exists should close, not submit.
  const rerunRow = $derived(
    rerunRunId === null ? null : (allRows.find((row) => row.runId === rerunRunId) ?? null)
  );

  // FR-034 — recomputed on every snapshot rather than captured when the panel
  // opened. Publishing or retiring a version while the form sits open changes
  // the answer, and a remembered target would offer a version that is no longer
  // Active. Deriving it costs one `find` per push and cannot go stale.
  const rerunTarget = $derived(
    rerunRow === null ? null : resolveRerunTarget(rerunRow, snapshot.launchables, snapshot.queues)
  );

  // The projection names what is published; the effective catalog carries the
  // definition the form composes against. Both come from the same snapshot but
  // are separate fields, so the panel takes `undefined` as a state rather than
  // as an error — see its `pipeline` prop.
  const rerunPipeline = $derived(
    rerunTarget === null || rerunTarget.state !== 'ready'
      ? undefined
      : (snapshot.availablePipelines ?? []).find((p) => p.id === rerunTarget.launchable.id)
  );

  function openRerun(runId: string): void {
    rerunRunId = runId;
  }

  function closeRerun(): void {
    rerunRunId = null;
  }
</script>

<main class="history-dashboard" data-testid="history-dashboard">
  <header class="history-header">
    <div>
      <h1>Run History</h1>
      <p>Every queue's runs in one place — the ones still going and the ones already finished.</p>
    </div>
    <span
      class="history-count"
      data-testid="history-render-count"
      aria-label={`Showing ${bounded.shown} of ${bounded.matched} matching runs`}
    >
      {bounded.shown} of {bounded.matched} {bounded.matched === 1 ? 'run' : 'runs'}
    </span>
  </header>

  {#if rerunRow && rerunTarget}
    <!-- FR-033 — ahead of the detail, because it was opened from it. Closing
         the panel does not clear `location`, so the detail is still underneath
         and comes back. -->
    <section class="history-ledger" aria-label="Repeat a run">
      <HistoryRerunPanel
        row={rerunRow}
        target={rerunTarget}
        pipeline={rerunPipeline}
        onClose={closeRerun}
      />
    </section>
  {:else if selectedRow}
    <!-- FR-024 — the detail replaces the list rather than sitting beside it.
         The surface is one column wide in the sidebar, and a run understood in
         full is the whole answer to the question the operator just asked. -->
    <section class="history-ledger" aria-label="Run detail">
      <!-- FR-R3-127 (FR-004) — the retention consequence belongs on the Run, not
           only on a settings page. Threaded from here because the panel is two
           levels down and the facts live on the snapshot. -->
      <HistoryRunDetail
        row={selectedRow}
        {catalogNames}
        rawTranscriptMode={snapshot.generalSettings?.rawTranscriptMode ?? 'errors-only'}
        retentionMaxAgeDays={snapshot.generalSettings?.sessionRetentionMaxAgeDays ?? 30}
        onBack={closeDetail}
        onRerun={isPrimary ? () => openRerun(selectedRow.runId) : undefined}
      />
    </section>
  {:else}
  <section class="history-ledger" aria-label="History filters and results">
    <div class="history-filters">
      <label class="search-field">
        <span class="visually-hidden">Search run history</span>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="11" cy="11" r="7"></circle>
          <path d="m20 20-3.5-3.5"></path>
        </svg>
        <input bind:value={query} type="search" placeholder="Search by run ID, queue, or description" />
      </label>
      <!-- FR-016 — the six filters, in the one component that owns them. The
           search box above is not one of them: it is a free-text sweep over what
           is already listed, and it composes with the six the same way. -->
      <HistoryFilterBar
        {filters}
        options={filterOptions}
        onChange={(next) => (location = { ...location, filters: next })}
      />
    </div>

    {#if truncated}
      <p class="truncation-note" data-testid="history-truncation-note" role="status">
        Showing the {HISTORY_RENDER_BOUND} newest of {bounded.matched} matching runs. Narrow the
        filters to reach the rest.
      </p>
    {/if}

    {#if bounded.matched === 0 && allRows.length > 0}
      <!-- FR-007, FR-022 — distinct from the "nothing recorded" state inside
           HistorySection. Same blank list, two different causes, and telling an
           operator with a filter applied that their workspace has no runs sends
           them looking for a data-loss bug. The way out is offered here as well
           as on the bar, because this is where an operator lands on it. -->
      <div class="filtered-empty" data-testid="history-filtered-empty" role="status">
        <strong>No matching runs</strong>
        <span>
          {narrowed
            ? 'No run matches every active filter.'
            : 'Adjust the search or the filters.'}
        </span>
        {#if narrowed}
          <button type="button" data-testid="history-filtered-empty-clear" onclick={clearFilters}>
            Clear filters
          </button>
        {/if}
      </div>
    {:else}
      <HistorySection
        rows={bounded.rows}
        {isPrimary}
        {catalogNames}
        variant="ledger"
        onOpenDetail={openDetail}
        onRerunRow={openRerun}
      />
    {/if}
  </section>
  {/if}
</main>

<style>
  .history-dashboard {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: var(--schegent-space-3);
    overflow-y: auto;
    padding: var(--schegent-space-4) var(--schegent-space-5) var(--schegent-space-5);
  }
  .history-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 20px;
  }
  .history-header h1 {
    margin: 0;
    font-size: var(--schegent-text-heading);
    font-weight: 650;
    letter-spacing: -0.025em;
  }
  .history-header p {
    max-width: 65ch;
    margin: 5px 0 0;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-secondary);
    line-height: 1.45;
    text-wrap: pretty;
  }
  .history-count {
    flex: 0 0 auto;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    font-variant-numeric: tabular-nums;
  }
  .history-ledger {
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--schegent-surface);
  }
  .history-filters {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: var(--schegent-space-3);
    border-bottom: 1px solid var(--schegent-divider);
  }
  .search-field {
    position: relative;
    display: flex;
    width: min(460px, 100%);
    align-items: center;
    color: var(--schegent-muted-fg);
  }
  .search-field svg {
    position: absolute;
    left: 10px;
    pointer-events: none;
  }
  .search-field input {
    width: 100%;
    min-height: var(--schegent-control-height);
    padding: 6px 10px 6px 34px;
    border: 1px solid var(--schegent-input-border);
    border-radius: var(--schegent-radius-sm);
    background: var(--schegent-input-bg);
  }
  .filtered-empty {
    display: flex;
    min-height: 190px;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 5px;
    color: var(--schegent-muted-fg);
  }
  .filtered-empty strong {
    color: var(--schegent-fg);
  }
  .filtered-empty button {
    margin-top: 6px;
    min-height: var(--schegent-control-height);
    padding: 5px 12px;
    border: 1px solid var(--schegent-input-border);
    border-radius: var(--schegent-radius-sm);
    background: transparent;
    color: var(--schegent-fg);
    cursor: pointer;
  }
  .truncation-note {
    margin: 0;
    padding: 8px var(--schegent-space-3);
    border-bottom: 1px solid var(--schegent-divider);
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    line-height: 1.45;
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 720px) {
    .history-dashboard {
      padding: 16px;
    }
    .history-header,
    .history-filters {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
