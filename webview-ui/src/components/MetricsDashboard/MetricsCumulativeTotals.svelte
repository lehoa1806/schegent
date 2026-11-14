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
  // The tile's context line says the same in a few words, since a title shows on hover only.
  const costNote = $derived(
    cumulative.costUsdIsPartial ? 'At least: some runs reported no cost' : 'Every run reported a cost'
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

<!-- The mockup's four tiles: a label, the figure, and a line of context. The
     failed, canceled and backend-call counts ride in the context lines. -->
<section class="cumulative" aria-label="All-time totals" data-testid="metrics-cumulative">
  <dl class="grid g4 tiles" data-testid="metrics-cumulative-cards">
    <div class="tile">
      <dt class="lbl">Runs</dt>
      <dd class="val" data-testid="metrics-cumulative-runs">{cumulative.runs}</dd>
      <dd class="ctx">All time</dd>
    </div>
    <div class="tile">
      <dt class="lbl">Completed</dt>
      <dd class="val" data-testid="metrics-cumulative-completed">{cumulative.completedRuns}</dd>
      <dd class="ctx">
        of {cumulative.runs} ·
        <span data-testid="metrics-cumulative-failed">{cumulative.failedRuns}</span> failed ·
        <span data-testid="metrics-cumulative-canceled">{cumulative.canceledRuns}</span> canceled
      </dd>
    </div>
    <div class="tile">
      <dt class="lbl">Run time</dt>
      <dd class="val" data-testid="metrics-cumulative-elapsed">{formatDuration(cumulative.durationMs)}</dd>
      <dd class="ctx">
        <span data-testid="metrics-cumulative-invocations">{cumulative.backendInvocations}</span> backend calls
      </dd>
    </div>
    <div class="tile">
      <dt class="lbl">Cost</dt>
      <dd
        class="val"
        class:cost-partial={cumulative.costUsdIsPartial}
        title={costTitle}
        data-testid="metrics-cumulative-cost"
      >{costLabel}</dd>
      <dd class="ctx">{costNote}</dd>
    </div>
  </dl>
  <p
    class="countline"
    class:unavailable={!coverage.totals.available}
    data-testid="metrics-totals-coverage-window"
  >{totalsWindow}</p>
</section>

<style>
  .tiles {
    margin: 0;
  }
  .tiles dd {
    margin: 0;
  }
  .tile {
    min-width: 0;
  }
  .tiles .val {
    overflow-wrap: anywhere;
  }
  .tiles .val.cost-partial {
    color: var(--schegent-muted-fg);
  }
  .countline {
    line-height: 1.4;
  }
  .countline.unavailable {
    font-style: italic;
  }
</style>
