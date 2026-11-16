<!--
  One run of a report, opened from its row: what it ran, its attempts, and what the store holds
  about its usage and evidence. An inline card under the results, closed with its X button; the
  panel then returns focus to the row the card was opened from.
-->
<script lang="ts">
  import { availabilityPhrase } from '../../../../src/contracts/change-review';
  import type { PercentileValue, RootDrillDown } from '../../../../src/contracts/reporting/report-rows';
  import { formatDuration } from '../../lib/format-duration';
  import ReportStatusChip from './ReportStatusChip.svelte';

  interface Props {
    drillDown: RootDrillDown;
    onClose: () => void;
  }

  const { drillDown, onClose }: Props = $props();

  function fmtMs(ms: number | null): string {
    return ms === null ? availabilityPhrase('unknown') : formatDuration(ms);
  }

  function fmtPct(value: PercentileValue): string {
    return value === 'unavailable' ? availabilityPhrase('unavailable') : `${value} ms`;
  }
</script>

<section
  class="section card drilldown"
  aria-label={`Root execution drill-down ${drillDown.root.rootId}`}
  data-testid="report-drilldown-panel"
>
  <div class="titlerow">
    <h2>Root execution <span class="mono">{drillDown.root.rootId}</span></h2>
    <ReportStatusChip status={drillDown.root.outcome} />
    <button type="button" class="icon-btn push" aria-label="Close drill-down" data-testid="report-drilldown-close" onclick={onClose}>
      <svg class="i" aria-hidden="true"><use href="#i-x"></use></svg>
    </button>
  </div>
  <p class="meta small muted">
    Workflow <span class="mono">{drillDown.root.workflowId}</span>
    &middot; Frozen definition <span class="mono">{drillDown.frozenDefinitionId ?? 'Not recorded'}</span>
  </p>

  <dl class="kv facts">
    <dt>Created (UTC)</dt>
    <dd>{drillDown.root.createdUtc}</dd>
    <dt>Wall-clock duration</dt>
    <dd>{fmtMs(drillDown.root.durationMs)}</dd>
    <dt>Recorded attempts</dt>
    <dd>{drillDown.attempts.length}</dd>
    <dt>Outcome lineage</dt>
    <dd>
      {#if drillDown.outcomeLineage.length === 0}
        Not recorded
      {:else}
        {drillDown.outcomeLineage.map((entry) => `${entry.source}: ${entry.outcome}`).join(', ')}
      {/if}
    </dd>
  </dl>

  {#if drillDown.attempts.length > 0}
    <h3>Attempts ({drillDown.attempts.length})</h3>
    <div class="table-wrap">
      <table class="t fit" data-testid="report-drilldown-attempts">
        <thead>
          <tr>
            <th scope="col" class="num">Step</th>
            <th scope="col">Phase</th>
            <th scope="col">Attempt</th>
            <th scope="col">Status</th>
            <th scope="col" class="num">Duration</th>
            <th scope="col" class="num">Exit</th>
          </tr>
        </thead>
        <tbody>
          {#each drillDown.attempts as attempt (attempt.attemptId)}
            <tr>
              <td class="num">{attempt.stepIndex}</td>
              <td>{attempt.phaseId ?? 'Not recorded'}</td>
              <td>#{attempt.attemptNumber} <span class="mono muted">{attempt.attemptId}</span></td>
              <td><ReportStatusChip status={attempt.status} /></td>
              <td class="num">{fmtMs(attempt.durationMs)}</td>
              <td class="num">{attempt.exitCode ?? 'Not recorded'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="aux">
    <div data-testid="report-drilldown-usage">
      <h3>Pinned usage accounting</h3>
      {#if drillDown.usage === null}
        <p class="small muted">{availabilityPhrase('unavailable')}</p>
      {:else if drillDown.usage.length === 0}
        <p class="small muted">No usage rows recorded for this root at the pinned cutoff.</p>
      {:else}
        <ul class="small">
          {#each drillDown.usage as row, idx (idx)}
            <li>
              {Object.entries(row.key).map(([k, v]) => `${k}=${v ?? 'unattributed'}`).join(', ') || 'total'}:
              {row.measures
                .map((m) => `${m.measure}=${m.total} ${m.unit} (${m.completeness})`)
                .join('; ')}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div data-testid="report-drilldown-evidence">
      <h3>Artifact &amp; ACP metadata</h3>
      <p class="small">
        Evidence items: {(drillDown.evidenceRefs ?? []).length}
        {#if (drillDown.evidenceRefs ?? []).length > 0}
          ({(drillDown.evidenceRefs ?? []).map((e) => `${e.storeKind}:${e.availability}`).join(', ')})
        {/if}
      </p>
      <p class="small">
        Live ACP attributions: {(drillDown.acpAttributions ?? []).length}
        {#if (drillDown.acpAttributions ?? []).length > 0}
          ({(drillDown.acpAttributions ?? [])
            .map((a) => `${a.profileId ?? a.backendKind ?? 'acp'}:${a.liveObservations} live`)
            .join(', ')})
        {/if}
      </p>
      <p class="small">
        Accepted handoffs: {(drillDown.handoffSummaries ?? []).length}
        &middot; Review loops: {(drillDown.reviewSummaries ?? []).length}
      </p>
    </div>
  </div>

  {#if drillDown.omissions.length > 0}
    <div class="omissions small muted" data-testid="report-drilldown-omissions">
      <strong>Stated omissions (each shown as &ldquo;{fmtPct('unavailable')}&rdquo;, never as zero):</strong>
      <ul>
        {#each drillDown.omissions as omission, idx (idx)}
          <li>{omission.what} — {omission.reason}</li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

<style>
  /* Ids run long: they wrap anywhere rather than push the card wider than the page. */
  .drilldown h2,
  .drilldown .meta,
  .drilldown .facts dd {
    overflow-wrap: anywhere;
  }
  .drilldown h3 {
    margin: var(--schegent-space-4) 0 var(--schegent-space-1-5);
    font-weight: 600;
  }
  .drilldown p {
    margin: 0;
  }
  .drilldown .meta {
    margin-top: var(--schegent-space-1);
  }
  .drilldown .facts {
    margin-top: var(--schegent-space-3);
  }
  .aux {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 0 var(--schegent-space-4);
  }
  .aux p + p {
    margin-top: var(--schegent-space-1);
  }
  .drilldown ul {
    margin: 0;
    padding-left: var(--schegent-space-4-5);
  }
  .omissions {
    margin-top: var(--schegent-space-3-5);
  }
  .omissions ul {
    margin-top: var(--schegent-space-1);
  }
</style>
