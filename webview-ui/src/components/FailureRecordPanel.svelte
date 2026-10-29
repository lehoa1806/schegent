<script lang="ts">
  // FR-R4-F15 (feature 243, contract P3) — what the "Show last error" region says about a Run's
  // retained failure record.
  //
  // Presentational: the region (`QueueItemError`) asks the host and hands this a state. Every value is
  // interpolated as text, `{value}`, and never with `{@html}`, an `innerHTML` write or a link: a summary
  // is text the agent wrote about its own failing work, the host has already redacted, stripped and
  // bounded it, and this panel still treats it as untrusted (hard rule 2). The record was validated by
  // the shared validator before it reached here.
  import { FAILURE_CAUSE_LABELS } from '../../../src/contracts/failure-cause';
  import { formatAbsoluteTime } from '../lib/format';
  import type { FailureRecordPanelState } from '../lib/failure-record-ipc';

  interface Props {
    readonly itemId: string;
    readonly label: string;
    readonly state: FailureRecordPanelState;
  }

  const { itemId, label, state }: Props = $props();

  /** The cap warning's threshold, and feature 242's notice's: a count of 1 is one comparison, not a stall. */
  const STALL_COUNT_SHOWN_ABOVE = 1;
</script>

<div
  class="failure-record"
  data-testid="failure-record-panel-{itemId}"
  role="region"
  aria-label="Failure diagnostics for {label}"
>
  {#if state.kind === 'loading'}
    <p class="sentence">Loading failure diagnostics…</p>
  {:else if state.kind === 'failed'}
    <p class="sentence">Could not load failure diagnostics.</p>
  {:else if state.answer.outcome === 'available'}
    {@const record = state.answer.record}
    {#if state.answer.recordCount > 1}
      <p class="line" data-testid="failure-record-count-{itemId}">
        Latest of {state.answer.recordCount} recorded failures of this Run
      </p>
    {/if}
    <p class="line" data-testid="failure-record-cause-{itemId}">
      Cause: {FAILURE_CAUSE_LABELS[record.cause]} ({record.cause})
    </p>
    {#if record.phase !== undefined}
      <p class="line" data-testid="failure-record-phase-{itemId}">Phase: {record.phase}</p>
    {/if}
    {#if record.iteration !== undefined && record.iterationCap !== undefined}
      <p class="line" data-testid="failure-record-iteration-{itemId}">
        Iteration {record.iteration} of {record.iterationCap}
      </p>
    {/if}
    {#if record.stalledCount !== undefined && record.stalledCount > STALL_COUNT_SHOWN_ABOVE}
      <p class="line" data-testid="failure-record-stalled-{itemId}">
        Unchanged comparisons: {record.stalledCount}
      </p>
    {/if}
    <p class="line" data-testid="failure-record-failed-at-{itemId}">
      Failed at {formatAbsoluteTime(record.failedAt)}
    </p>
    {#if record.issueState === 'listed'}
      <ul class="issues" data-testid="failure-record-issues-{itemId}">
        {#each record.entries as entry, index (index)}
          <li data-testid="failure-record-issue-{itemId}-{index}">
            {entry.summary} — {entry.source === 'host' ? 'added by Schegent' : `reported as ${entry.tag}`}
          </li>
        {/each}
      </ul>
    {:else if record.issueState === 'none-reported'}
      <p class="line">The phase reported no open issues.</p>
    {:else if record.issueState === 'unparsed'}
      <p class="line">No issue list could be read from the phase's output.</p>
    {:else}
      <p class="line">The Run failed before a phase produced output.</p>
    {/if}
    {#if record.omittedIssueCount > 0}
      <p class="line" data-testid="failure-record-omitted-issues-{itemId}">
        {record.omittedIssueCount} more issues were not recorded.
      </p>
    {/if}
    {#if record.metrics.length > 0}
      <p class="line heading">Last metrics</p>
      <ul class="metrics" data-testid="failure-record-metrics-{itemId}">
        {#each record.metrics as metric, index (metric.key)}
          <li data-testid="failure-record-metric-{itemId}-{index}">{metric.key}: {metric.value}</li>
        {/each}
      </ul>
    {/if}
    {#if record.omittedMetricCount > 0}
      <p class="line" data-testid="failure-record-omitted-metrics-{itemId}">
        {record.omittedMetricCount} more metrics were not recorded.
      </p>
    {/if}
    {#if record.entries.some((entry) => entry.source === 'agent')}
      <p class="line note" data-testid="failure-record-claims-{itemId}">
        Tags are the agent's own labels; Schegent does not check them.
      </p>
    {/if}
  {:else if state.answer.outcome === 'none'}
    <p class="sentence">No failure diagnostics were recorded for this Run.</p>
  {:else if state.answer.outcome === 'expired'}
    <p class="sentence">This Run's failure diagnostics were removed by retention.</p>
  {:else if state.answer.outcome === 'unavailable'}
    <p class="sentence">Failure diagnostics for this Run are unavailable.</p>
  {:else if state.answer.outcome === 'malformed'}
    <p class="sentence">This Run's failure record could not be read.</p>
  {/if}
</div>

<style>
  .failure-record {
    padding: 4px 0 0;
    color: var(--schegent-fg);
    font-size: 0.85em;
  }

  .sentence,
  .line {
    margin: 0 0 2px;
    word-break: break-word;
  }

  .heading {
    color: var(--schegent-muted-fg);
  }

  .note {
    color: var(--schegent-muted-fg);
    font-style: italic;
  }

  .issues,
  .metrics {
    margin: 0 0 2px;
    padding-left: 18px;
    word-break: break-word;
  }
</style>
