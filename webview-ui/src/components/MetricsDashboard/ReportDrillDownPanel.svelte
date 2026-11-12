<script lang="ts">
  import { availabilityPhrase } from '../../../../src/contracts/change-review';
  import type { PercentileValue, RootDrillDown } from '../../../../src/contracts/reporting/report-rows';
  import { formatDuration } from '../../lib/format-duration';

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
  class="drilldown-panel"
  aria-label={`Root execution drill-down ${drillDown.root.rootId}`}
  data-testid="report-drilldown-panel"
>
  <header class="drilldown-header">
    <div>
      <h2>Root execution {drillDown.root.rootId}</h2>
      <p class="drilldown-sub">
        Workflow: <span>{drillDown.root.workflowId}</span>
        &middot; Frozen definition:
        <span>{drillDown.frozenDefinitionId ?? 'Not recorded'}</span>
        &middot; Outcome: <span class="badge">{drillDown.root.outcome}</span>
      </p>
    </div>
    <button
      type="button"
      class="drilldown-close"
      data-testid="report-drilldown-close"
      onclick={onClose}
    >
      Close drill-down
    </button>
  </header>

  <dl class="drilldown-summary">
    <div>
      <dt>Created (UTC)</dt>
      <dd>{drillDown.root.createdUtc}</dd>
    </div>
    <div>
      <dt>Wall-clock duration</dt>
      <dd>{fmtMs(drillDown.root.durationMs)}</dd>
    </div>
    <div>
      <dt>Recorded attempts</dt>
      <dd>{drillDown.attempts.length}</dd>
    </div>
    <div>
      <dt>Outcome lineage</dt>
      <dd>
        {#if drillDown.outcomeLineage.length === 0}
          Not recorded
        {:else}
          {drillDown.outcomeLineage.map((entry) => `${entry.source}: ${entry.outcome}`).join(', ')}
        {/if}
      </dd>
    </div>
  </dl>

  {#if drillDown.attempts.length > 0}
    <div class="sub-block">
      <h3>Attempts ({drillDown.attempts.length})</h3>
      <table class="drilldown-table" data-testid="report-drilldown-attempts">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Phase</th>
            <th scope="col">Attempt</th>
            <th scope="col">Status</th>
            <th scope="col">Duration</th>
            <th scope="col">Exit</th>
          </tr>
        </thead>
        <tbody>
          {#each drillDown.attempts as attempt (attempt.attemptId)}
            <tr>
              <td>{attempt.stepIndex}</td>
              <td>{attempt.phaseId ?? 'Not recorded'}</td>
              <td>#{attempt.attemptNumber} ({attempt.attemptId})</td>
              <td><span class="badge">{attempt.status}</span></td>
              <td>{fmtMs(attempt.durationMs)}</td>
              <td>{attempt.exitCode ?? 'Not recorded'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <div class="aux-grid">
    <div class="sub-block" data-testid="report-drilldown-usage">
      <h3>Pinned usage accounting</h3>
      {#if drillDown.usage === null}
        <p class="muted">{availabilityPhrase('unavailable')}</p>
      {:else if drillDown.usage.length === 0}
        <p class="muted">No usage rows recorded for this root at the pinned cutoff.</p>
      {:else}
        <ul class="compact-list">
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

    <div class="sub-block" data-testid="report-drilldown-evidence">
      <h3>Artifact &amp; ACP metadata</h3>
      <p class="compact-line">
        Evidence items: {(drillDown.evidenceRefs ?? []).length}
        {#if (drillDown.evidenceRefs ?? []).length > 0}
          ({(drillDown.evidenceRefs ?? []).map((e) => `${e.storeKind}:${e.availability}`).join(', ')})
        {/if}
      </p>
      <p class="compact-line">
        Live ACP attributions: {(drillDown.acpAttributions ?? []).length}
        {#if (drillDown.acpAttributions ?? []).length > 0}
          ({(drillDown.acpAttributions ?? [])
            .map((a) => `${a.profileId ?? a.backendKind ?? 'acp'}:${a.liveObservations} live`)
            .join(', ')})
        {/if}
      </p>
      <p class="compact-line">
        Accepted handoffs: {(drillDown.handoffSummaries ?? []).length}
        &middot; Review loops: {(drillDown.reviewSummaries ?? []).length}
      </p>
    </div>
  </div>

  {#if drillDown.omissions.length > 0}
    <div class="omissions" data-testid="report-drilldown-omissions">
      <strong>Stated omissions ({fmtPct('unavailable')} never shown as zero):</strong>
      <ul>
        {#each drillDown.omissions as omission, idx (idx)}
          <li>{omission.what} — {omission.reason}</li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

<style>
  .drilldown-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--schegent-surface);
  }
  .drilldown-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
  }
  .drilldown-header h2, .sub-block h3 {
    margin: 0;
    font-size: 0.95rem;
  }
  .drilldown-sub {
    margin: 4px 0 0;
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }
  .drilldown-close {
    padding: 4px 10px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--schegent-button-secondary-bg);
    color: var(--schegent-button-secondary-fg);
    cursor: pointer;
  }
  .drilldown-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 8px;
    margin: 0;
    font-size: 0.85em;
  }
  .drilldown-summary dt { color: var(--schegent-muted-fg); }
  .drilldown-summary dd { margin: 2px 0 0; }
  .drilldown-table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  .drilldown-table th, .drilldown-table td {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid var(--schegent-divider);
  }
  .aux-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 10px;
  }
  .badge {
    display: inline-block;
    padding: 1px 6px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius-sm);
    font-size: 0.85em;
  }
  .compact-list, .omissions ul { margin: 4px 0 0; padding-left: 18px; font-size: 0.85em; }
  .compact-line, .muted { margin: 4px 0 0; font-size: 0.85em; color: var(--schegent-muted-fg); }
  .omissions { font-size: 0.85em; color: var(--schegent-muted-fg); }
</style>
