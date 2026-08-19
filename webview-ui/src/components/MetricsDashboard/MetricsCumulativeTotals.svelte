<script lang="ts">
  // FR-R3-009 T396 — all-time cumulative totals, captioned with the window
  // they actually cover.
  //
  // These figures come from the durable rollup at `.schegent/metrics-rollup.jsonl`
  // unioned with whatever the retained audit corpus still holds, so they do not
  // shrink when an archive is pruned. The strip below this one is the log-derived
  // detail and carries its own, narrower window — the two are rendered
  // separately on purpose, because a figure presented without its window reads
  // as an all-time figure whether or not it is one.
  import type { CumulativeTotals, MetricsCoverage } from '../../lib/messages';
  import { formatAbsoluteTime } from '../../lib/format';
  import { formatDuration } from '../../lib/format-duration';

  interface Props {
    cumulative: CumulativeTotals;
    coverage: MetricsCoverage;
  }

  const { cumulative, coverage }: Props = $props();

  // "$12.34" when every counted run reported a cost; "$12.34+" when at least one
  // did not. The trailing marker is the difference between a total and a floor,
  // and dropping it would let an under-reported figure be quoted as exact.
  const costLabel = $derived(
    `$${cumulative.costUsd.toFixed(2)}${cumulative.costUsdIsPartial ? '+' : ''}`
  );
  const costTitle = $derived(
    cumulative.costUsdIsPartial
      ? 'At least this much: one or more counted runs reported no cost.'
      : 'Every counted run reported a cost.'
  );

  const totalsWindow = $derived.by(() => {
    const { available, earliest, runs } = coverage.totals;
    if (!available) {
      return 'No durable rollup recorded yet — these totals cover the scanned audit log only.';
    }
    const since = earliest === undefined ? 'the first recorded run' : formatAbsoluteTime(earliest);
    return `Durable rollup covers ${runs} run${runs === 1 ? '' : 's'} since ${since}; older runs are included from the retained audit log where still present.`;
  });
</script>

<section class="cumulative" aria-label="All-time totals" data-testid="metrics-cumulative">
  <dl class="cumulative-strip" data-testid="metrics-cumulative-cards">
    <div class="cumulative-item">
      <dt class="cumulative-label">Runs Recorded</dt>
      <dd class="cumulative-value" data-testid="metrics-cumulative-runs">{cumulative.runs}</dd>
    </div>
    <div class="cumulative-item">
      <dt class="cumulative-label">Completed</dt>
      <dd class="cumulative-value" data-testid="metrics-cumulative-completed">{cumulative.completedRuns}</dd>
    </div>
    <div class="cumulative-item">
      <dt class="cumulative-label">Failed</dt>
      <dd class="cumulative-value" data-testid="metrics-cumulative-failed">{cumulative.failedRuns}</dd>
    </div>
    <div class="cumulative-item">
      <dt class="cumulative-label">Canceled</dt>
      <dd class="cumulative-value" data-testid="metrics-cumulative-canceled">{cumulative.canceledRuns}</dd>
    </div>
    <div class="cumulative-item">
      <dt class="cumulative-label">Total Elapsed</dt>
      <dd class="cumulative-value" data-testid="metrics-cumulative-elapsed">{formatDuration(cumulative.durationMs)}</dd>
    </div>
    <div class="cumulative-item">
      <dt class="cumulative-label">Total Cost</dt>
      <dd
        class="cumulative-value"
        class:cost-partial={cumulative.costUsdIsPartial}
        title={costTitle}
        data-testid="metrics-cumulative-cost"
      >{costLabel}</dd>
    </div>
    <div class="cumulative-item">
      <dt class="cumulative-label">Backend Calls</dt>
      <dd class="cumulative-value" data-testid="metrics-cumulative-invocations">{cumulative.backendInvocations}</dd>
    </div>
  </dl>
  <p
    class="cumulative-window"
    class:unavailable={!coverage.totals.available}
    data-testid="metrics-totals-coverage-window"
  >{totalsWindow}</p>
</section>

<style>
  .cumulative {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .cumulative-strip {
    display: flex;
    flex-wrap: wrap;
    margin: 0;
    padding: 8px 0;
    border-block-start: 1px solid var(--schegent-divider);
  }
  .cumulative-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 110px;
    min-width: 0;
    padding: 4px var(--schegent-pad);
  }
  .cumulative-item + .cumulative-item {
    border-inline-start: 1px solid var(--schegent-divider);
  }
  .cumulative-label {
    order: 2;
    color: var(--schegent-muted-fg);
    font-size: 0.8em;
  }
  .cumulative-value {
    order: 1;
    margin: 0;
    font-size: 1.2em;
    font-weight: 600;
  }
  .cumulative-value.cost-partial {
    color: var(--schegent-muted-fg);
  }
  .cumulative-window {
    margin: 0;
    color: var(--schegent-muted-fg);
    font-size: 0.8em;
    line-height: 1.4;
  }
  .cumulative-window.unavailable {
    font-style: italic;
  }

  @media (max-width: 560px) {
    .cumulative-item {
      flex-basis: 50%;
    }
    .cumulative-item:nth-child(odd) {
      border-inline-start: 0;
    }
  }
</style>
