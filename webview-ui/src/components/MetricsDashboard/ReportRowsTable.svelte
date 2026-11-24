<!--
  A report's rows as the redesign's table. A page holds one kind of row: the view decides it, and
  the form asks for no grouping. So the first row's kind picks the columns, and each row draws the
  cells of its own kind.

  Only the column currently being sorted carries `aria-sort`. The headings are not sort buttons:
  the sort is part of the query, pinned with it when the report is saved.
-->
<script lang="ts">
  import { availabilityPhrase } from '../../../../src/contracts/change-review';
  import type { ReportSort } from '../../../../src/contracts/reporting/report-query';
  import type { Distribution, PercentileValue, ReportRow, UsageRow } from '../../../../src/contracts/reporting/report-rows';
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
  const rootCreatedSort = $derived<'ascending' | 'descending' | undefined>(
    sort === 'root-created-asc' ? 'ascending' : sort === 'root-created-desc' ? 'descending' : undefined
  );
  const statusSort = $derived<'ascending' | undefined>(sort === 'outcome-asc' ? 'ascending' : undefined);
  const durationSort = $derived<'descending' | undefined>(sort === 'duration-desc' ? 'descending' : undefined);
  const groupKeySort = $derived<'ascending' | undefined>(sort === 'key-asc' ? 'ascending' : undefined);
  const rootsCountSort = $derived<'descending' | undefined>(sort === 'roots-desc' ? 'descending' : undefined);

  function fmtMs(ms: number | null): string {
    return ms === null ? availabilityPhrase('unknown') : formatDuration(ms);
  }

  function fmtPct(value: PercentileValue): string {
    return value === 'unavailable' ? availabilityPhrase('unavailable') : `${value}ms`;
  }

  function fmtDist(d: Distribution): string {
    return `${d.basis}: p50 ${fmtPct(d.p50)}, p90 ${fmtPct(d.p90)}, p99 ${fmtPct(d.p99)} (${d.known}/${d.samples} known)`;
  }

  function fmtInvocations(invocations: UsageRow['invocations'] | number): string {
    return invocations === 'not-recorded' ? 'Not recorded' : String(invocations);
  }

  function hasPositiveEstimate(value: string | undefined): boolean {
    return value !== undefined && !/^0(?:\.0+)?$/.test(value);
  }

  function fmtMeasure(m: UsageRow['measures'][number]): string {
    if (m.completeness === 'unknown' && m.coverage.known === 0) {
      return hasPositiveEstimate(m.estimatedTotal)
        ? `${m.measure}: ${availabilityPhrase('unknown')} [estimated ${m.estimatedTotal} ${m.unit}] (${m.completeness})`
        : `${m.measure}: ${availabilityPhrase('unknown')} (${m.completeness})`;
    }
    const lanes: string[] = [];
    if (m.reportedTotal !== undefined) lanes.push(`reported ${m.reportedTotal}`);
    if (m.estimatedTotal !== undefined) lanes.push(`estimated ${m.estimatedTotal}`);
    const split = lanes.length > 0 ? ` [${lanes.join(', ')}]` : '';
    return `${m.measure}: ${m.total} ${m.unit}${split} (${m.completeness})`;
  }
</script>

<div class="table-wrap">
  <table class="t" data-testid="report-rows-table">
    <thead>
      <tr>
        {#if rowKind === 'root'}
          <th scope="col" aria-sort={rootCreatedSort}>Run</th>
          <th scope="col">Workflow</th>
          <th scope="col" aria-sort={statusSort}>Status</th>
          <th scope="col" class="num">Attempts</th>
          <th scope="col" class="num" aria-sort={durationSort}>Duration</th>
          <th scope="col"><span class="sr-only">Open</span></th>
        {:else if rowKind === 'attempt'}
          <th scope="col">Attempt</th>
          <th scope="col">Step</th>
          <th scope="col">Status</th>
          <th scope="col" class="num">Duration</th>
          <th scope="col" aria-sort={rootCreatedSort}>Run</th>
        {:else if rowKind === 'group'}
          <th scope="col" aria-sort={groupKeySort}>Group</th>
          <th scope="col" class="num" aria-sort={rootsCountSort}>Runs</th>
          <th scope="col" class="num">Attempts</th>
          <th scope="col">Duration</th>
        {:else}
          <th scope="col" aria-sort={groupKeySort}>Group</th>
          <th scope="col" class="num" aria-sort={rootsCountSort}>Runs</th>
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
            <td>
              <div>{fmtDist(row.rootDuration)}</div>
              {#if row.attemptDuration !== undefined}
                <div class="sub">{fmtDist(row.attemptDuration)}</div>
              {/if}
            </td>
          {:else}
            <td>{Object.entries(row.key).map(([k, v]) => `${k}=${v ?? 'unattributed'}`).join(', ') || 'All usage'}</td>
            <td class="num">{row.roots}</td>
            <td class="num">{row.attempts}</td>
            <td class="num">{fmtInvocations(row.invocations)}</td>
            <td>{row.measures.map(fmtMeasure).join(' · ')}</td>
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
