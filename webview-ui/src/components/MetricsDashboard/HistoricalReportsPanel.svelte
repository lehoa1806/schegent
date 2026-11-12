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
  import type {
    Distribution,
    ReportPage,
    ReportRow,
    RootDrillDown
  } from '../../../../src/contracts/reporting/report-rows';
  import { formatDuration } from '../../lib/format-duration';
  import { requestMutateReport, requestReadReport } from '../../lib/reporting-ipc';
  import ReportDrillDownPanel from './ReportDrillDownPanel.svelte';

  function failureCode(f: ReportFailure): string {
    if (f.outcome === 'refused' || f.outcome === 'failed') return f.reason;
    if (f.outcome === 'limited') return f.limit;
    return f.outcome;
  }

  const VIEW_LABELS: Readonly<Record<ReportView, string>> = {
    'execution-summary': 'Execution summary',
    'attempt-detail': 'Attempt detail',
    'failure-cause': 'Failure causes',
    'workflow-revision': 'Workflow revisions',
    'time-series': 'Daily time series',
    usage: 'Usage accounting'
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

  function fmtDist(d: Distribution): string {
    const p50 = d.p50 === 'unavailable' ? 'n/a' : `${d.p50}ms`;
    const p90 = d.p90 === 'unavailable' ? 'n/a' : `${d.p90}ms`;
    return `p50 ${p50}, p90 ${p90} (${d.known}/${d.samples} known)`;
  }
</script>

<section class="reports-shell" aria-label="Historical reports" data-testid="historical-reports-panel">
  <form
    class="query-bar"
    onsubmit={(e) => {
      e.preventDefault();
      void executeQuery();
    }}
  >
    <label>
      <span>View</span>
      <select bind:value={view} data-testid="report-view-select">
        {#each REPORT_VIEWS as v (v)}
          <option value={v}>{VIEW_LABELS[v]}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>Window</span>
      <select bind:value={rangeDays} data-testid="report-range-select">
        <option value={7}>Last 7 days</option>
        <option value={30}>Last 30 days</option>
        <option value={90}>Last 90 days</option>
      </select>
    </label>
    {#if view === 'usage'}
      <label>
        <span>Backend</span>
        <input type="text" bind:value={backendFilter} placeholder="claude / codex / agy" data-testid="report-filter-backend" />
      </label>
    {:else}
      <label>
        <span>Workflow ID</span>
        <input type="text" bind:value={workflowFilter} placeholder="All workflows" data-testid="report-filter-workflow" />
      </label>
      <label>
        <span>Outcome</span>
        <input type="text" bind:value={outcomeFilter} placeholder="All outcomes" data-testid="report-filter-outcome" />
      </label>
    {/if}
    <label>
      <span>Sort</span>
      <select bind:value={sort} data-testid="report-sort-select">
        {#each availableSorts as s (s)}
          <option value={s}>{s}</option>
        {/each}
      </select>
    </label>
    <div class="query-actions">
      <button type="submit" class="btn" disabled={loading} data-testid="report-run-button">
        {loading ? 'Running…' : 'Run report'}
      </button>
      {#if loading}
        <button type="button" class="btn" onclick={() => void cancelActive()} data-testid="report-cancel-button">
          Cancel
        </button>
      {/if}
    </div>
  </form>

  <p class="status-banner" role="status" aria-live="polite" data-testid="report-status-notice">
    {statusNotice}
  </p>

  {#if page !== null}
    <div class="coverage-strip" data-testid="report-coverage-strip">
      <span>Cutoff: <strong>{page.sourceCutoffUtc}</strong> ({page.timeBasis})</span>
      <span>Roots: <strong>{page.coverage.roots}</strong> &middot; Attempts: <strong>{page.coverage.attempts}</strong></span>
      <span>Unknown durations: <strong>{page.coverage.unknownDurations}</strong></span>
      <span>
        Accounting rev:
        <strong>{page.accountingRevision ?? availabilityPhrase('unavailable')}</strong>
      </span>
      {#if page.legacy !== undefined}
        <span data-testid="report-legacy-summary">
          Legacy pre-cutover summary (separate): {page.legacy.runCount} runs, {page.legacy.costMicros} micros
        </span>
      {/if}
    </div>

    {#if page.omissions.length > 0}
      <ul class="omission-strip" data-testid="report-omissions-list">
        {#each page.omissions as om, idx (idx)}
          <li>Omission: {om.what} ({om.reason})</li>
        {/each}
      </ul>
    {/if}

    <div class="export-bar">
      <button type="button" class="btn" disabled={mutating} onclick={() => void exportActive('json')} data-testid="report-export-json">
        Export JSON
      </button>
      <button type="button" class="btn" disabled={mutating} onclick={() => void exportActive('csv')} data-testid="report-export-csv">
        Export CSV
      </button>
      <button type="button" class="btn" disabled={mutating} onclick={() => void saveActive()} data-testid="report-save-button">
        Save report
      </button>
      <span class="csv-note" data-testid="report-csv-disclosure">{CSV_STATEMENT}</span>
    </div>

    {#if rows.length === 0}
      <p class="empty-note" data-testid="report-empty-rows">No rows matched this pinned query window.</p>
    {:else}
      <table class="report-table" data-testid="report-rows-table">
        <thead>
          <tr>
            <th scope="col" aria-sort={sort.includes('asc') ? 'ascending' : 'descending'}>Subject / Key</th>
            <th scope="col">Counts / Status</th>
            <th scope="col">Duration / Measures</th>
            <th scope="col">Inspect</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row, idx (idx)}
            <tr>
              {#if row.kind === 'root'}
                <td>{row.rootId} ({row.workflowId})</td>
                <td><span class="badge">{row.outcome}</span> &middot; {row.attempts} attempt(s)</td>
                <td>{row.durationMs === null ? availabilityPhrase('unknown') : formatDuration(row.durationMs)}</td>
                <td>
                  <button
                    id={`drill-trigger-${idx}`}
                    type="button"
                    class="btn"
                    data-testid={`report-drilldown-open-${row.rootId}`}
                    onclick={() => void openDrillDown(row.rootId, `drill-trigger-${idx}`)}
                  >
                    Drill down
                  </button>
                </td>
              {:else if row.kind === 'attempt'}
                <td>{row.attemptId} (step {row.stepIndex}: {row.phaseId ?? 'Not recorded'})</td>
                <td><span class="badge">{row.status}</span> &middot; #{row.attemptNumber}</td>
                <td>{row.durationMs === null ? availabilityPhrase('unknown') : formatDuration(row.durationMs)}</td>
                <td>
                  <button
                    id={`drill-trigger-${idx}`}
                    type="button"
                    class="btn"
                    onclick={() => void openDrillDown(row.rootId, `drill-trigger-${idx}`)}
                  >
                    Root {row.rootId}
                  </button>
                </td>
              {:else if row.kind === 'group'}
                <td>{row.key === null ? 'All roots' : Object.entries(row.key).map(([k, v]) => `${k}=${v ?? 'none'}`).join(', ')}</td>
                <td>{row.roots} root(s), {row.attempts} attempt(s)</td>
                <td>{fmtDist(row.rootDuration)}</td>
                <td>Group row</td>
              {:else}
                <td>{Object.entries(row.key).map(([k, v]) => `${k}=${v ?? 'unattributed'}`).join(', ') || 'All usage'}</td>
                <td>{row.roots} root(s), {row.attempts} attempt(s), invocations: {row.invocations}</td>
                <td>
                  {row.measures
                    .map((m) => `${m.measure}: ${m.total} ${m.unit} (${m.completeness})`)
                    .join(' · ')}
                </td>
                <td>Usage row</td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
      {#if nextCursor !== null}
        <button type="button" class="btn" disabled={loading} onclick={() => void loadMore()} data-testid="report-next-page">
          Load next page
        </button>
      {/if}
    {/if}
  {/if}

  {#if drillDown !== null}
    <ReportDrillDownPanel {drillDown} onClose={closeDrillDown} />
  {/if}

  <section class="saved-section" aria-label="Saved reports" data-testid="saved-reports-section">
    <h2>Saved reports ({savedReports.length})</h2>
    {#if savedReports.length === 0}
      <p class="empty-note">No saved report definitions stored yet.</p>
    {:else}
      <ul class="saved-list">
        {#each savedReports as item (item.reportId)}
          <li class="saved-row">
            <span>
              <strong>{item.reportId}</strong> &middot; {VIEW_LABELS[item.view]} &middot; cutoff {item.manifest.sourceCutoffUtc}
            </span>
            <div class="saved-actions">
              <button type="button" class="btn" onclick={() => void rerunSaved(item.reportId)} data-testid={`saved-rerun-${item.reportId}`}>
                Re-run now
              </button>
              <button type="button" class="btn" onclick={() => void reproduceSaved(item.reportId)} data-testid={`saved-reproduce-${item.reportId}`}>
                Verify reproducibility
              </button>
              {#if confirmDeleteId === item.reportId}
                <button type="button" class="btn" onclick={() => void confirmDeleteSaved(item.reportId)} data-testid={`saved-confirm-delete-${item.reportId}`}>
                  Confirm delete
                </button>
                <button type="button" class="btn" onclick={() => { confirmDeleteId = null; }}>
                  Keep
                </button>
              {:else}
                <button type="button" class="btn" onclick={() => { confirmDeleteId = item.reportId; }} data-testid={`saved-delete-${item.reportId}`}>
                  Delete
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</section>

<style>
  .reports-shell { display: flex; flex-direction: column; gap: 12px; }
  .query-bar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; padding: 12px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius); background: var(--schegent-surface); }
  .query-bar label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85em; color: var(--schegent-muted-fg); }
  .query-bar select, .query-bar input { min-height: var(--schegent-control-height, 28px); padding: 3px 8px; border: 1px solid var(--schegent-input-border, var(--schegent-border)); border-radius: var(--schegent-radius-sm); background: var(--vscode-input-background, transparent); color: var(--schegent-fg); font: inherit; }
  .query-actions, .export-bar, .saved-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .btn { padding: 4px 10px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius); background: var(--schegent-button-secondary-bg); color: var(--schegent-button-secondary-fg); cursor: pointer; font: inherit; font-size: 0.85em; }
  .btn:disabled { opacity: 0.6; cursor: not-allowed; }
  .status-banner, .csv-note, .empty-note { margin: 0; font-size: 0.85em; color: var(--schegent-muted-fg); }
  .coverage-strip { display: flex; flex-wrap: wrap; gap: 12px; padding: 8px 12px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius); background: var(--schegent-surface); font-size: 0.85em; }
  .omission-strip { margin: 0; padding-left: 18px; font-size: 0.85em; color: var(--schegent-muted-fg); }
  .report-table { width: 100%; border-collapse: collapse; font-size: 0.85em; background: var(--schegent-surface); border: 1px solid var(--schegent-border); }
  .report-table th, .report-table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--schegent-divider); }
  .badge { display: inline-block; padding: 1px 6px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius-sm); }
  .saved-section { padding: 12px; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius); background: var(--schegent-surface); }
  .saved-section h2 { margin: 0 0 8px; font-size: 0.95rem; }
  .saved-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .saved-row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; font-size: 0.85em; }
</style>
