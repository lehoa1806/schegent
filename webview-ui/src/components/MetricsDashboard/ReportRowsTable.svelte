<!--
  A report's rows as the redesign's table. A page holds one kind of row: the view decides it, and
  the form asks for no grouping. So the first row's kind picks the columns, and each row draws the
  cells of its own kind.

  The first heading carries the order the form chose. The headings are not sort buttons, as they
  are in the mockup: the sort is part of the query, pinned with it when the report is saved.
-->
<script lang="ts">
  import { availabilityPhrase } from '../../../../src/contracts/change-review';
  import type { ReportSort } from '../../../../src/contracts/reporting/report-query';
  import type { Distribution, ReportRow } from '../../../../src/contracts/reporting/report-rows';
  import { formatDuration } from '../../lib/format-duration';
  import ReportStatusChip from './ReportStatusChip.svelte';

  interface Props {
    rows: readonly ReportRow[];
    sort: ReportSort;
    /** Opens a run's drill-down; the id is the button's, so closing it can return focus there. */
    onOpenRoot: (rootId: string, triggerDomId: string) => void;
  }

  const { rows, sort, onOpenRoot }: Props = $props();

  const rowKind = $derived(rows.at(0)?.kind);
  const sortOrder = $derived(sort.includes('asc') ? 'ascending' : 'descending');

  function fmtMs(ms: number | null): string {
    return ms === null ? availabilityPhrase('unknown') : formatDuration(ms);
  }

  function fmtDist(d: Distribution): string {
    const p50 = d.p50 === 'unavailable' ? 'n/a' : `${d.p50}ms`;
    const p90 = d.p90 === 'unavailable' ? 'n/a' : `${d.p90}ms`;
    return `p50 ${p50}, p90 ${p90} (${d.known}/${d.samples} known)`;
  }
</script>

<div class="table-wrap">
  <table class="t" data-testid="report-rows-table">
    <thead>
      <tr>
        {#if rowKind === 'root'}
          <th scope="col" aria-sort={sortOrder}>Run</th>
          <th scope="col">Workflow</th>
          <th scope="col">Status</th>
          <th scope="col" class="num">Attempts</th>
          <th scope="col" class="num">Duration</th>
          <th scope="col"><span class="sr-only">Open</span></th>
        {:else if rowKind === 'attempt'}
          <th scope="col" aria-sort={sortOrder}>Attempt</th>
          <th scope="col">Step</th>
          <th scope="col">Status</th>
          <th scope="col" class="num">Duration</th>
          <th scope="col">Run</th>
        {:else if rowKind === 'group'}
          <th scope="col" aria-sort={sortOrder}>Group</th>
          <th scope="col" class="num">Runs</th>
          <th scope="col" class="num">Attempts</th>
          <th scope="col">Run time</th>
        {:else}
          <th scope="col" aria-sort={sortOrder}>Group</th>
          <th scope="col" class="num">Runs</th>
          <th scope="col" class="num">Attempts</th>
          <th scope="col" class="num">Backend calls</th>
          <th scope="col">Measures</th>
        {/if}
      </tr>
    </thead>
    <tbody>
      {#each rows as row, idx (idx)}
        <tr>
          {#if row.kind === 'root'}
            <td class="mono">{row.rootId}</td>
            <td class="mono">{row.workflowId}</td>
            <td><ReportStatusChip status={row.outcome} /></td>
            <td class="num">{row.attempts}</td>
            <td class="num">{fmtMs(row.durationMs)}</td>
            <td>
              <button
                id={`drill-trigger-${idx}`}
                type="button"
                class="linkbtn"
                aria-label={`Details for ${row.rootId}`}
                data-testid={`report-drilldown-open-${row.rootId}`}
                onclick={() => onOpenRoot(row.rootId, `drill-trigger-${idx}`)}
              >Details</button>
            </td>
          {:else if row.kind === 'attempt'}
            <td><span class="mono">{row.attemptId}</span><div class="sub">Attempt {row.attemptNumber}</div></td>
            <td>{row.phaseId ?? 'Not recorded'}<div class="sub">Step {row.stepIndex}</div></td>
            <td><ReportStatusChip status={row.status} /></td>
            <td class="num">{fmtMs(row.durationMs)}</td>
            <td>
              <button
                id={`drill-trigger-${idx}`}
                type="button"
                class="linkbtn mono"
                aria-label={`Details for ${row.rootId}`}
                onclick={() => onOpenRoot(row.rootId, `drill-trigger-${idx}`)}
              >{row.rootId}</button>
            </td>
          {:else if row.kind === 'group'}
            <td>{row.key === null ? 'All runs' : Object.entries(row.key).map(([k, v]) => `${k}=${v ?? 'none'}`).join(', ')}</td>
            <td class="num">{row.roots}</td>
            <td class="num">{row.attempts}</td>
            <td>{fmtDist(row.rootDuration)}</td>
          {:else}
            <td>{Object.entries(row.key).map(([k, v]) => `${k}=${v ?? 'unattributed'}`).join(', ') || 'All usage'}</td>
            <td class="num">{row.roots}</td>
            <td class="num">{row.attempts}</td>
            <td class="num">{row.invocations}</td>
            <td>{row.measures.map((m) => `${m.measure}: ${m.total} ${m.unit} (${m.completeness})`).join(' · ')}</td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  td.num {
    white-space: nowrap;
  }
</style>
