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
  //
  // Since the redesign the surface is a page and a drawer beside it (design
  // rule 7): the list stays in view while a run's detail, or the form that
  // runs it again, is open. Opening the drawer moves focus to its heading and
  // names the run on the status line; closing it, by its own button or by
  // Escape, hands focus back to the run it was opened from (rule 10).

  import { tick } from 'svelte';
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
  import { statusLine } from '../lib/status-line.svelte';
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
  // detail is open — and the drawer closes instead.
  const selectedRow = $derived(
    location.selectedRunId === null
      ? null
      : (allRows.find((row) => row.runId === location.selectedRunId) ?? null)
  );

  // The drawer's two views share one heading id, so the drawer is labelled by
  // whichever of them it shows and focus has one place to land.
  const DRAWER_HEADING_ID = 'history-drawer-heading';
  let root = $state<HTMLElement | null>(null);
  let drawer = $state<HTMLElement | null>(null);
  // What opened the drawer, for focus to go back to. Plain rather than state:
  // nothing renders from it.
  let opener: HTMLElement | null = null;

  function rememberOpener(): void {
    const active = document.activeElement;
    // A control inside the drawer (the detail's Run again…) only changes what
    // the drawer shows, so whatever opened the drawer is still the way back.
    if (drawer?.contains(active) === true) return;
    opener = active instanceof HTMLElement && active !== document.body ? active : null;
  }

  async function focusDrawerHeading(): Promise<void> {
    await tick();
    drawer?.querySelector<HTMLElement>(`#${DRAWER_HEADING_ID}`)?.focus();
  }

  // Focus comes back only when the drawer had it. Escape pressed in the list
  // closes the drawer too, and leaves focus where the operator put it.
  function focusLeftBehind(): boolean {
    const active = document.activeElement;
    return document.hasFocus() && (active === document.body || drawer?.contains(active) === true);
  }

  // Back to the opener while it is still there and reachable. Otherwise to the
  // run's name in the list: the opener may have been an item in the row's menu,
  // which has closed since. Otherwise, when the filters leave the run out of
  // the list, to the page's heading rather than nowhere.
  async function returnFocus(runId: string): Promise<void> {
    const from = opener;
    opener = null;
    await tick();
    if (from?.isConnected === true && from.closest('[hidden]') === null) {
      from.focus();
      return;
    }
    const rowElement = Array.from(
      root?.querySelectorAll<HTMLElement>('[data-history-row]') ?? []
    ).find((element) => element.dataset.historyRow === runId);
    const target =
      rowElement?.querySelector<HTMLElement>('.rowname') ?? root?.querySelector<HTMLElement>('h1');
    target?.focus();
  }

  function openDetail(runId: string): void {
    rememberOpener();
    // A run opened from the list replaces whatever the drawer shows, a rerun
    // form included. The list stays in view beside the drawer now, and a form
    // kept in front of the run just asked for would answer the click with
    // nothing.
    rerunRunId = null;
    location = { ...location, selectedRunId: runId };
    const row = allRows.find((candidate) => candidate.runId === runId);
    if (row) statusLine.announce(`Showing details for ${row.descriptionPreview || row.runId}.`);
    void focusDrawerHeading();
  }

  // The filters are untouched on the way back, which is the whole reason the
  // selection lives in `HistoryLocation` beside them (SC-005).
  function closeDetail(): void {
    const runId = location.selectedRunId;
    const restore = focusLeftBehind();
    location = { ...location, selectedRunId: null };
    if (restore && runId !== null) void returnFocus(runId);
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
  const rerunPipeline = $derived.by(() => {
    if (rerunTarget === null || rerunTarget.state !== 'ready') return undefined;
    const targetId = rerunTarget.launchable.id;
    const fromPipelines = (snapshot.availablePipelines ?? []).find((p) => p.id === targetId);
    if (fromPipelines) return fromPipelines;
    const wf = (snapshot.workflowCatalog?.effective ?? []).find((w) => w.workflowId === targetId);
    if (!wf) return undefined;
    return {
      id: wf.workflowId,
      name: wf.name,
      description: wf.description,
      phases: wf.nodes.flatMap((n) => (n.phaseId ? [n.phaseId] : [])),
      inputs: wf.inputs,
      outputs: wf.outputs
    };
  });

  const showsRerun = $derived(rerunRow !== null && rerunTarget !== null);
  const drawerOpen = $derived(showsRerun || selectedRow !== null);

  function openRerun(runId: string): void {
    rememberOpener();
    rerunRunId = runId;
    void focusDrawerHeading();
  }

  // The detail the form was opened from is still underneath, so focus goes to
  // its heading; with no detail open the drawer closes and focus goes back to
  // the run.
  function closeRerun(): void {
    const runId = rerunRunId;
    const restore = focusLeftBehind();
    rerunRunId = null;
    if (!restore || runId === null) return;
    if (selectedRow === null) void returnFocus(runId);
    else void focusDrawerHeading();
  }

  // Escape closes the drawer, the rerun form first because it sits in front of
  // the detail, unless something nearer already answered it (an open menu, a
  // confirmation dialog) or it was pressed outside this page.
  function closeDrawerOnEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !drawerOpen) return;
    const target = event.target;
    const onPage = target === document.body || (target instanceof Node && root?.contains(target) === true);
    if (!onPage) return;
    if (showsRerun) closeRerun();
    else closeDetail();
  }
</script>

<svelte:document onkeydown={closeDrawerOnEscape} />

<main
  class="history-dashboard"
  class:page-split={drawerOpen}
  data-testid="history-dashboard"
  bind:this={root}
>
  <div class="page">
    <div class="phead">
      <div>
        <!-- Focusable from script only: the way back when a closed drawer's run
             is not in the list. -->
        <h1 tabindex="-1">History</h1>
        <div class="purpose">Every run, finished or not. Select a run to see what happened.</div>
      </div>
    </div>

    <div class="toolbar">
      <div class="search">
        <svg class="i" aria-hidden="true"><use href="#i-search"></use></svg>
        <input
          class="input"
          type="search"
          placeholder="Search by run ID, queue, or description"
          aria-label="Search run history"
          bind:value={query}
        />
      </div>
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
      <div class="empty" data-testid="history-filtered-empty" role="status">
        <strong>No matching runs</strong>
        <span>
          {narrowed
            ? 'No run matches every active filter.'
            : 'Adjust the search or the filters.'}
        </span>
        {#if narrowed}
          <button
            type="button"
            class="btn btn-secondary"
            data-testid="history-filtered-empty-clear"
            onclick={clearFilters}
          >
            Clear filters
          </button>
        {/if}
      </div>
    {:else}
      <HistorySection
        rows={bounded.rows}
        {isPrimary}
        {catalogNames}
        selectedTaskId={location.selectedRunId}
        variant="ledger"
        onOpenDetail={openDetail}
        onRerunRow={openRerun}
      />
    {/if}

    <!-- FR-052 — under the list, where the design keeps its count. The words are
         exactly the count: the render-cost check reads them back. -->
    <p class="countline" data-testid="history-render-count">
      {bounded.shown} of {bounded.matched} {bounded.matched === 1 ? 'run' : 'runs'}
    </p>
  </div>

  {#if drawerOpen}
    <aside
      class="drawer"
      aria-labelledby={DRAWER_HEADING_ID}
      data-testid="history-drawer"
      bind:this={drawer}
    >
      {#if rerunRow && rerunTarget}
        <!-- FR-033 — ahead of the detail, because it was opened from it. Closing
             the panel does not clear `location`, so the detail is still underneath
             and comes back. -->
        <HistoryRerunPanel
          row={rerunRow}
          target={rerunTarget}
          pipeline={rerunPipeline}
          onClose={closeRerun}
          headingId={DRAWER_HEADING_ID}
        />
      {:else if selectedRow}
        <!-- FR-024 — the detail opens beside the list rather than in its place
             (design rule 7), and takes the whole width in a narrow window, where
             there is no room for both. -->
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
          headingId={DRAWER_HEADING_ID}
        />
      {/if}
    </aside>
  {/if}
</main>

<style>
  /* The page and the drawer side by side. The page scrolls on its own, so the
     drawer stays put while the list moves under the operator's hand. */
  .history-dashboard {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  /* The query container for the filter bar's narrow layout, in HistoryFilterBar.svelte. */
  .toolbar {
    container: history-toolbar / inline-size;
  }
  /* Wide enough for the whole placeholder, which the redesign's 260px cuts short. 19em of
     text room, plus 40px for the icon's inset and the end padding, holds it at the 13px and
     14px editor fonts. The sheet's `max-width: 100%` still caps it. The page's class leads
     so the rule outranks the sheet's `.sg .toolbar .search` whatever order the two load in. */
  .history-dashboard .toolbar .search {
    width: calc(19em + 40px);
  }
  /* FR-052 — above the rows it qualifies, in the count line's voice. */
  .truncation-note {
    margin: 0 0 var(--schegent-space-2);
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-secondary);
    line-height: 1.45;
    text-wrap: pretty;
  }
  /* The filtered-empty state sits where the table would, in the table's frame,
     the same frame HistorySection gives the empty history. */
  .empty {
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
  }
  .empty span {
    display: block;
    max-width: 38ch;
    margin-inline: auto;
  }

  /* Design rule 7 — a narrow window has no room for both, so the drawer takes
     the whole width until it closes. */
  @media (max-width: 860px) {
    .page-split > .page {
      display: none;
    }
    .page-split > .drawer {
      flex: 1;
      width: auto;
      border-left: 0;
    }
  }
</style>
