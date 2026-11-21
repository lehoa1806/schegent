<script lang="ts">
  import { untrack } from 'svelte';
  import { availabilityPhrase } from '../../../../src/contracts/change-review';
  import { CSV_STATEMENT, type SavedReportView } from '../../../../src/contracts/reporting/report-manifest';
  import {
    DAY_MS,
    REPORT_VIEWS,
    VIEW_SHAPES,
    type ReportQueryInput,
    type ReportSort,
    type ReportView
  } from '../../../../src/contracts/reporting/report-query';
  import type { ReportFailure } from '../../../../src/contracts/reporting/report-outcomes';
  import type { ReportPage, ReportRow, RootDrillDown } from '../../../../src/contracts/reporting/report-rows';
  import { requestMutateReport, requestReadReport } from '../../lib/reporting-ipc';
  import SgMenu from '../sg/SgMenu.svelte';
  import ReportDrillDownPanel from './ReportDrillDownPanel.svelte';
  import ReportRowsTable from './ReportRowsTable.svelte';
  import SavedReportsSection from './SavedReportsSection.svelte';

  function failureCode(f: ReportFailure): string {
    if (f.outcome === 'refused' || f.outcome === 'failed') return f.reason;
    if (f.outcome === 'limited') return f.limit;
    return f.outcome;
  }

  // The mockup's names for the views.
  const VIEW_LABELS: Readonly<Record<ReportView, string>> = {
    'execution-summary': 'Run summary',
    'attempt-detail': 'Attempts',
    'failure-cause': 'Failure causes',
    'workflow-revision': 'Workflow versions',
    'time-series': 'Daily totals',
    usage: 'Usage and cost'
  };

  const SORT_LABELS: Readonly<Record<ReportSort, string>> = {
    'root-created-desc': 'Newest first',
    'root-created-asc': 'Oldest first',
    'duration-desc': 'Longest first',
    'outcome-asc': 'By outcome',
    'key-asc': 'By group, A to Z',
    'roots-desc': 'Most runs first'
  };

  let view = $state<ReportView>('execution-summary');
  let rangeDays = $state<number>(30);
  let workflowFilter = $state('');
  let outcomeFilter = $state('');
  let backendFilter = $state('');
  let sort = $state<ReportSort>('root-created-desc');

  let loading = $state(false);
  let mutating = $state(false);
  let statusNotice = $state<string>('');
  let page = $state<ReportPage | null>(null);
  let rows = $state<readonly ReportRow[]>([]);
  let nextCursor = $state<string | null>(null);
  let drillDown = $state<RootDrillDown | null>(null);
  let savedReports = $state<readonly SavedReportView[]>([]);
  let confirmDeleteId = $state<string | null>(null);
  let lastTriggerId = $state<string | null>(null);

  const availableSorts = $derived.by((): readonly ReportSort[] => {
    const shape = VIEW_SHAPES[view];
    return shape.rowSorts.length > 0 ? shape.rowSorts : shape.groupSorts;
  });

  // The saved list as its table shows it: the view's name and a short cutoff.
  const savedRows = $derived(
    savedReports.map((item) => ({
      reportId: item.reportId,
      report: VIEW_LABELS[item.view],
      cutoff: cutoffLabel(item.manifest.sourceCutoffUtc)
    }))
  );

  $effect(() => {
    const first = availableSorts.at(0);
    if (!availableSorts.includes(sort) && first !== undefined) sort = first;
  });

  $effect(() => {
    untrack(() => {
      void loadSavedList();
      void executeQuery();
    });
    return () => untrack(() => {
      if (page !== null) void requestReadReport({ op: 'close', reportId: page.reportId });
    });
  });

  function buildQuery(): ReportQueryInput {
    const endMs = Date.now();
    const startMs = endMs - rangeDays * DAY_MS;
    const filters: Record<string, readonly string[]> = {};
    if (view === 'usage') {
      if (backendFilter.trim()) filters.backend = [backendFilter.trim()];
    } else {
      if (workflowFilter.trim()) filters.workflowId = [workflowFilter.trim()];
      if (outcomeFilter.trim()) filters.outcome = [outcomeFilter.trim()];
    }
    return {
      view,
      range: { startMs, endMs },
      sort,
      ...(Object.keys(filters).length > 0 ? { filters } : {})
    };
  }

  async function loadSavedList(): Promise<void> {
    const env = await requestReadReport({ op: 'listSaved', request: { limit: 25 } });
    if (env.response.op === 'listSaved' && env.response.result.ok) {
      savedReports = env.response.result.value.items;
    }
  }

  async function executeQuery(): Promise<void> {
    loading = true;
    drillDown = null;
    statusNotice = 'Running pinned historical report…';
    if (page !== null) {
      void requestReadReport({ op: 'close', reportId: page.reportId });
    }
    const env = await requestReadReport({ op: 'run', query: buildQuery() });
    loading = false;
    if (env.boundaryRefusal !== null) {
      statusNotice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'run') {
      if (env.response.result.ok) {
        page = env.response.result.value;
        rows = env.response.result.value.rows;
        nextCursor = env.response.result.value.cursor;
        statusNotice = `Loaded ${env.response.result.value.rowCount} row(s) at cutoff ${env.response.result.value.sourceCutoffUtc}.`;
      } else {
        statusNotice = `Report unavailable: ${failureCode(env.response.result)}.`;
      }
    }
  }

  async function cancelActive(): Promise<void> {
    const env = await requestReadReport({ op: 'cancelActive' });
    loading = false;
    statusNotice =
      env.response.op === 'cancelActive' && env.response.canceled
        ? 'Canceled active report query.'
        : 'No active report query to cancel.';
  }

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    loading = true;
    const env = await requestReadReport({ op: 'page', cursor: nextCursor });
    loading = false;
    if (env.response.op === 'page' && env.response.result.ok) {
      rows = [...rows, ...env.response.result.value.rows];
      nextCursor = env.response.result.value.cursor;
      statusNotice = `Showing ${rows.length} of ${page?.rowCount ?? rows.length} row(s).`;
    }
  }

  async function openDrillDown(rootId: string, triggerDomId: string): Promise<void> {
    if (page === null) return;
    lastTriggerId = triggerDomId;
    const env = await requestReadReport({ op: 'drillDown', reportId: page.reportId, rootId });
    if (env.response.op === 'drillDown') {
      if (env.response.result.ok) {
        drillDown = env.response.result.value;
        statusNotice = `Opened drill-down for ${rootId}.`;
      } else {
        statusNotice = `Drill-down unavailable: ${failureCode(env.response.result)}.`;
      }
    }
  }

  function closeDrillDown(): void {
    drillDown = null;
    const targetId = lastTriggerId;
    if (targetId !== null) {
      queueMicrotask(() => document.getElementById(targetId)?.focus());
    }
  }

  async function exportActive(format: 'json' | 'csv'): Promise<void> {
    if (page === null) return;
    mutating = true;
    const env = await requestMutateReport({ op: 'export', reportId: page.reportId, format });
    mutating = false;
    if (env.boundaryRefusal !== null) {
      statusNotice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'export') {
      if (env.response.exportOutcome.outcome === 'dialog-canceled') {
        statusNotice = 'Export canceled before writing any file.';
      } else if (env.response.exportOutcome.result.ok) {
        const rec = env.response.exportOutcome.result.value;
        statusNotice = `Exported ${rec.fileName} (${rec.rowCount} rows, sha256 ${rec.sha256.slice(0, 12)}…) plus ${rec.manifestFileName}.`;
      } else {
        statusNotice = `Export failed: ${failureCode(env.response.exportOutcome.result)}.`;
      }
    }
  }

  async function saveActive(): Promise<void> {
    if (page === null) return;
    mutating = true;
    const env = await requestMutateReport({ op: 'save', reportId: page.reportId });
    mutating = false;
    if (env.boundaryRefusal !== null) {
      statusNotice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'save' && env.response.result.ok) {
      statusNotice = `Saved report ${env.response.result.value.reportId}.`;
      await loadSavedList();
    } else if (env.response.op === 'save' && !env.response.result.ok) {
      statusNotice = `Could not save report: ${failureCode(env.response.result)}.`;
    }
  }

  async function rerunSaved(reportId: string): Promise<void> {
    loading = true;
    const env = await requestReadReport({ op: 'rerunSaved', reportId });
    loading = false;
    if (env.response.op === 'rerunSaved' && env.response.result.ok) {
      page = env.response.result.value;
      rows = env.response.result.value.rows;
      nextCursor = env.response.result.value.cursor;
      statusNotice = `Re-ran saved report ${reportId} against current cutoff ${page.sourceCutoffUtc}.`;
    } else if (env.response.op === 'rerunSaved' && !env.response.result.ok) {
      statusNotice = `Re-run refused: ${failureCode(env.response.result)}.`;
    }
  }

  async function reproduceSaved(reportId: string): Promise<void> {
    loading = true;
    const env = await requestReadReport({ op: 'reproduceSaved', reportId });
    loading = false;
    if (env.response.op === 'reproduceSaved' && env.response.result.ok) {
      const verdict = env.response.result.value;
      statusNotice =
        verdict.verdict === 'reproduced'
          ? `Saved report ${reportId}: exact population and digest reproduced.`
          : `Saved report ${reportId}: source no longer reproducible (${verdict.reason}).`;
    } else if (env.response.op === 'reproduceSaved' && !env.response.result.ok) {
      statusNotice = `Reproduce check unavailable: ${failureCode(env.response.result)}.`;
    }
  }

  async function confirmDeleteSaved(reportId: string): Promise<void> {
    mutating = true;
    const env = await requestMutateReport({ op: 'deleteSaved', reportId, confirmed: true });
    mutating = false;
    confirmDeleteId = null;
    if (env.boundaryRefusal !== null) {
      statusNotice = env.boundaryRefusal;
      return;
    }
    if (env.response.op === 'deleteSaved' && env.response.result.ok) {
      statusNotice = `Deleted saved report ${reportId}.`;
      await loadSavedList();
    }
  }

  // "2026-11-11T01:00:00.000Z" reads "2026-11-11 01:00 UTC". The disclosure keeps the exact value.
  function cutoffLabel(iso: string): string {
    return iso.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?Z$/, '$1 $2 UTC');
  }
</script>

<section class="reports" aria-label="Historical reports" data-testid="historical-reports-panel">
  <form
    class="card query"
    aria-labelledby="report-query-heading"
    onsubmit={(e) => {
      e.preventDefault();
      void executeQuery();
    }}
  >
    <h2 id="report-query-heading">New report</h2>
    <div class="toolbar">
      <label class="field w-report">
        <span>Report</span>
        <select class="input" bind:value={view} data-testid="report-view-select">
          {#each REPORT_VIEWS as v (v)}
            <option value={v}>{VIEW_LABELS[v]}</option>
          {/each}
        </select>
      </label>
      <label class="field w-window">
        <span>Window</span>
        <select class="input" bind:value={rangeDays} data-testid="report-range-select">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </label>
      {#if view === 'usage'}
        <label class="field w-text">
          <span>Backend</span>
          <input class="input" type="text" bind:value={backendFilter} placeholder="claude / codex / agy" data-testid="report-filter-backend" />
        </label>
      {:else}
        <label class="field w-text">
          <span>Workflow ID</span>
          <input class="input" type="text" bind:value={workflowFilter} placeholder="All workflows" data-testid="report-filter-workflow" />
        </label>
        <label class="field w-outcome">
          <span>Outcome</span>
          <input class="input" type="text" bind:value={outcomeFilter} placeholder="All outcomes" data-testid="report-filter-outcome" />
        </label>
      {/if}
      <label class="field w-sort">
        <span>Sort by</span>
        <select class="input" bind:value={sort} data-testid="report-sort-select">
          {#each availableSorts as s (s)}
            <option value={s}>{SORT_LABELS[s]}</option>
          {/each}
        </select>
      </label>
      <div class="query-actions">
        <button type="submit" class="btn btn-primary" disabled={loading} data-testid="report-run-button">
          {loading ? 'Running…' : 'Run report'}
        </button>
        {#if loading}
          <button type="button" class="btn btn-secondary" onclick={() => void cancelActive()} data-testid="report-cancel-button">
            Cancel
          </button>
        {/if}
      </div>
    </div>
    <p class="notice" role="status" aria-live="polite" data-testid="report-status-notice">{statusNotice}</p>
  </form>

  {#if page !== null}
    <section class="section results" aria-labelledby="report-results-heading">
      <div class="titlerow">
        <h2 id="report-results-heading">{VIEW_LABELS[page.view]}</h2>
        <span class="small muted">{page.rowCount} row(s) · as of {cutoffLabel(page.sourceCutoffUtc)}</span>
        <span class="push">
          <button type="button" class="btn btn-secondary btn-sm" disabled={mutating} onclick={() => void saveActive()} data-testid="report-save-button">
            Save report
          </button>
          <!-- The items, not the button, wait out an export: a button disabled under focus drops it.
               They wait with `aria-disabled`, which keeps them in reach, and the menu refuses a click. -->
          <SgMenu label="Export report">
            <button type="button" role="menuitem" aria-disabled={mutating} onclick={() => void exportActive('csv')} data-testid="report-export-csv">
              <svg class="i" aria-hidden="true"><use href="#i-export"></use></svg>Export CSV…
            </button>
            <button type="button" role="menuitem" aria-disabled={mutating} onclick={() => void exportActive('json')} data-testid="report-export-json">
              <svg class="i" aria-hidden="true"><use href="#i-export"></use></svg>Export JSON…
            </button>
          </SgMenu>
        </span>
      </div>

      {#if rows.length === 0}
        <p class="empty" data-testid="report-empty-rows">No rows matched this pinned query window.</p>
      {:else}
        <ReportRowsTable {rows} {sort} onOpenRoot={(rootId, triggerDomId) => void openDrillDown(rootId, triggerDomId)} />
        {#if nextCursor !== null}
          <div class="more">
            <button type="button" class="btn btn-secondary btn-sm" disabled={loading} onclick={() => void loadMore()} data-testid="report-next-page">
              Load next page
            </button>
          </div>
        {/if}
      {/if}

      <details class="diag">
        <summary>What this report covers</summary>
        <dl class="coverage" data-testid="report-coverage-strip">
          <div><dt>Cutoff ({page.timeBasis})</dt><dd>{page.sourceCutoffUtc}</dd></div>
          <div><dt>Runs</dt><dd>{page.coverage.roots}</dd></div>
          <div><dt>Attempts</dt><dd>{page.coverage.attempts}</dd></div>
          <div><dt>Unknown durations</dt><dd>{page.coverage.unknownDurations}</dd></div>
          <div><dt>Accounting revision</dt><dd>{page.accountingRevision ?? availabilityPhrase('unavailable')}</dd></div>
          {#if page.legacy !== undefined}
            <div data-testid="report-legacy-summary">
              <dt>Legacy pre-cutover summary (separate)</dt>
              <dd>{page.legacy.runCount} runs, {page.legacy.costMicros} micros</dd>
            </div>
          {/if}
        </dl>
        {#if page.omissions.length > 0}
          <ul class="omissions" data-testid="report-omissions-list">
            {#each page.omissions as om, idx (idx)}
              <li>Omission: {om.what} ({om.reason})</li>
            {/each}
          </ul>
        {/if}
        <p class="small muted csv-note" data-testid="report-csv-disclosure">{CSV_STATEMENT}</p>
      </details>
    </section>
  {/if}

  {#if drillDown !== null}
    <ReportDrillDownPanel {drillDown} onClose={closeDrillDown} />
  {/if}

  <SavedReportsSection
    reports={savedRows}
    {confirmDeleteId}
    onRerun={(reportId) => void rerunSaved(reportId)}
    onReproduce={(reportId) => void reproduceSaved(reportId)}
    onAskDelete={(reportId) => {
      confirmDeleteId = reportId;
    }}
    onConfirmDelete={(reportId) => void confirmDeleteSaved(reportId)}
    onKeep={() => {
      confirmDeleteId = null;
    }}
  />
</section>

<style>
  .query h2 {
    margin-bottom: var(--schegent-space-2-5);
    font-size: var(--schegent-text-body);
  }
  .query .toolbar {
    align-items: flex-end;
    margin-bottom: 0;
  }
  /* The mockup's field widths. A narrow panel wraps the fields, and one wider than the line
     takes the line. */
  .query .field {
    max-width: 100%;
  }
  .w-report {
    width: 200px;
  }
  .w-window {
    width: 140px;
  }
  .w-text {
    width: 180px;
  }
  .w-outcome {
    width: 150px;
  }
  .w-sort {
    width: 160px;
  }
  .query-actions {
    display: flex;
    gap: var(--schegent-space-2);
  }
  /* Always in the document, so a screen reader hears every change; spaced only when it speaks. */
  .notice {
    margin: 0;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-secondary);
  }
  .notice:not(:empty) {
    margin-top: var(--schegent-space-2-5);
  }
  .results .titlerow {
    margin-bottom: var(--schegent-space-2);
  }
  .results .titlerow h2 {
    font-size: var(--schegent-text-subheading);
  }
  .more {
    margin-top: var(--schegent-space-2);
  }
  .coverage {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: var(--schegent-space-2) var(--schegent-space-4);
    margin: var(--schegent-space-2) 0 0;
    font-size: var(--schegent-text-secondary);
  }
  .coverage dt {
    color: var(--schegent-muted-fg);
  }
  .coverage dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .omissions {
    margin: var(--schegent-space-2) 0 0;
    padding-left: var(--schegent-space-4-5);
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-secondary);
  }
  .csv-note {
    margin: var(--schegent-space-2) 0 0;
  }
</style>
