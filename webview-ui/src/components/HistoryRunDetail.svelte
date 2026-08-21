<script lang="ts">
  // Feature 103 (T052, T053, T056 — FR-024, FR-025, FR-026, FR-031, FR-053) —
  // one run, understood in full, without leaving the surface (FR-008).
  //
  // Two sources that fail independently. The recorded fields come off the row
  // the list already holds, so they are present whenever the detail is. Cost and
  // phase counts come from a run-scoped metrics read, and that read has three
  // answers where the obvious implementation has two: a run with no rollup
  // record and a read that never landed both leave nothing in hand, and both
  // then render as "not reported" — which tells an operator the run was free
  // when the truth is that nobody looked. So the join is a three-state machine
  // and each state is published as `data-state` (T091).
  //
  // A sub-view of `HistoryDashboard` rather than a route: `selectedRunId` lives
  // in `HistoryLocation` beside the filters, which is what makes the filter set
  // survive the return (FR-020).

  import {
    NO_CATALOG_NAMES,
    provenanceLabels,
    type CatalogNames,
    type HistoryRow
  } from '../lib/history-rows';
  import type { MetricsRunSummary } from '../lib/messages';
  import { readRunSummary } from '../lib/metrics-ipc';
  import { copyText } from '../lib/copy-text';
  import { formatAbsoluteTime, formatStatus } from '../lib/format';
  import { formatDuration } from '../lib/format-duration';
  import HistoryEvidencePanel from './HistoryEvidencePanel.svelte';

  interface Props {
    row: HistoryRow;
    onBack: () => void;
    catalogNames?: CatalogNames;
    /**
     * Feature 103 (T065, FR-033) — open the trigger form for this run.
     *
     * Optional, and absent means the control is not rendered rather than
     * rendered inert: the detail is a record, and a surface that cannot start
     * work should not show an action that starts work. Whether re-run is
     * *possible* is a different question, answered by the panel this opens
     * (FR-037) — resolving it here would put the same join in two places and
     * decide it at the wrong moment, since the catalog can change between the
     * detail rendering and the operator clicking.
     */
    onRerun?: () => void;
  }

  const { row, onBack, catalogNames = NO_CATALOG_NAMES, onRerun }: Props = $props();

  /**
   * The metrics join, as three states and not two.
   *
   * `read` with a `null` summary is a fact about the run — it reported nothing.
   * `unreadable` is a fact about the window — the host did not answer. They are
   * rendered apart because an operator quoting a cost has to know which one
   * they are looking at.
   */
  type MetricsJoin =
    | { readonly state: 'pending' }
    | { readonly state: 'read'; readonly summary: MetricsRunSummary | null }
    | { readonly state: 'unreadable' };

  let join = $state<MetricsJoin>({ state: 'pending' });

  // Keyed on the run id alone, and the `$derived` is what makes that true. A
  // new snapshot arrives on every host push and rebuilds every row object;
  // reading `row.runId` straight inside the effect subscribes it to the `row`
  // prop, so the effect would re-run on each push and re-read the rollup —
  // the repeated read FR-023 rules out. A derived over a primitive only
  // notifies when the string itself changes, so the effect fires once per run.
  const runId = $derived(row.runId);

  $effect(() => {
    const wanted = runId;
    let live = true;
    join = { state: 'pending' };
    void readRunSummary(wanted).then((result) => {
      if (!live) return;
      join =
        result.outcome === 'read'
          ? { state: 'read', summary: result.summary }
          : { state: 'unreadable' };
    });
    return () => {
      live = false;
    };
  });

  const summary = $derived(join.state === 'read' ? join.summary : null);

  // Cost branches on **presence**, not on falsiness. The writer omits `costUsd`
  // rather than writing a zero precisely so "reported nothing" stays
  // distinguishable, and `?? 0` here would throw that away at the last step.
  const costState = $derived.by((): 'reported' | 'not-reported' | 'unreadable' => {
    if (join.state === 'unreadable') return 'unreadable';
    if (summary === null || summary.costUsd === undefined) return 'not-reported';
    return 'reported';
  });

  const phaseState = $derived.by((): 'reported' | 'not-reported' | 'unreadable' => {
    if (join.state === 'unreadable') return 'unreadable';
    return summary === null ? 'not-reported' : 'reported';
  });

  // The same `$${n.toFixed(2)}` the metrics surfaces already use, so one run's
  // cost and the cumulative total read as the same kind of figure.
  const costText = $derived(
    summary?.costUsd === undefined ? '' : `$${summary.costUsd.toFixed(2)}`
  );

  const provenance = $derived(provenanceLabels(row, catalogNames));

  const startedText = $derived(row.startedAt === null ? 'Not recorded' : formatAbsoluteTime(row.startedAt));
  const endedText = $derived(
    row.completedAt === null
      ? row.source === 'in-flight'
        ? 'Still in flight'
        : 'Not recorded'
      : formatAbsoluteTime(row.completedAt)
  );
  const durationText = $derived(row.durationMs === null ? 'Not recorded' : formatDuration(row.durationMs));

  // FR-053 (detail half) — the retained preview, and how much of the original
  // it is. The preview is bounded and the original was not, so showing it alone
  // would read as the whole description: a truncation that does not say it is
  // one is indistinguishable from a complete record.
  const hasDescription = $derived(row.descriptionPreview.length > 0);
  const showsExtent = $derived(
    hasDescription &&
      row.descriptionLength !== null &&
      row.descriptionLength > row.descriptionPreview.length
  );
  // Fixed locale so the separator does not depend on the host's, which decides
  // whether "4,182" reads as four thousand or as four.
  const extentText = $derived(
    `Showing ${row.descriptionPreview.length.toLocaleString('en-US')} of ${(row.descriptionLength ?? 0).toLocaleString('en-US')} characters.`
  );

  let copied = $state<'idle' | 'done' | 'failed'>('idle');

  async function onCopyRunId(): Promise<void> {
    // FR-031 — a run id is what an operator pastes into a log search or a bug
    // report, and re-typing one by hand is how the wrong run gets investigated.
    // The outcome is reported either way: a control that claims a copy it did
    // not make leaves the operator holding someone else's clipboard.
    copied = (await copyText(row.runId)) ? 'done' : 'failed';
  }
</script>

<article class="run-detail" data-testid="history-run-detail" aria-label="Run detail">
  <header class="detail-header">
    <button type="button" class="back" data-testid="history-detail-back" onclick={onBack}>
      Back to the list
    </button>
    <div class="identity">
      <span class="run-id" data-testid="history-detail-run-id">{row.runId}</span>
      <button
        type="button"
        class="copy"
        data-testid="history-detail-copy-run-id"
        aria-label={`Copy run ID ${row.runId}`}
        onclick={onCopyRunId}
      >
        {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy blocked' : 'Copy run ID'}
      </button>
      {#if onRerun}
        <button
          type="button"
          class="copy"
          data-testid="history-detail-rerun"
          onclick={() => onRerun()}
        >
          Run again
        </button>
      {/if}
    </div>
  </header>

  <!-- FR-024 — what the record itself says. Started, ended and duration, and no
       queued time: `queuedAt` lives on the live queue item and dies with it, so
       a figure here could only be reconstructed, and a reconstructed timestamp
       beside recorded ones is a lie that looks exactly like a fact. -->
  <dl class="fields">
    <div class="field" data-testid="history-detail-definition">
      <dt>Definition</dt>
      <dd>{provenance.definition}</dd>
    </div>
    <div class="field" data-testid="history-detail-version">
      <dt>Version</dt>
      <!-- FR-012 — the same stated absence the row uses, so drilling in does
           not change what a run is understood to have recorded. -->
      <dd class:absent={row.catalogVersion === null}>{provenance.version}</dd>
    </div>
    <div class="field" data-testid="history-detail-origin">
      <dt>Started as</dt>
      <dd>{provenance.origin}</dd>
    </div>
    <div class="field" data-testid="history-detail-queue">
      <dt>Queue</dt>
      <dd>{row.queueName}</dd>
    </div>
    <div class="field" data-testid="history-detail-status">
      <dt>Status</dt>
      <dd>{formatStatus(row.status)}</dd>
    </div>
    <div class="field" data-testid="history-detail-started">
      <dt>Started</dt>
      <dd>{startedText}</dd>
    </div>
    <div class="field" data-testid="history-detail-ended">
      <dt>Ended</dt>
      <dd>{endedText}</dd>
    </div>
    <div class="field" data-testid="history-detail-duration">
      <dt>Duration</dt>
      <dd>{durationText}</dd>
    </div>
  </dl>

  <section class="description" aria-label="Run description">
    {#if hasDescription}
      <p class="description-text" data-testid="history-detail-description">
        {row.descriptionPreview}
      </p>
      {#if showsExtent}
        <p class="note" data-testid="history-detail-description-extent">{extentText}</p>
      {/if}
    {:else}
      <!-- Retention removes the text and keeps the run. An empty block here
           would read as a rendering fault rather than as an absent value. -->
      <p class="note" data-testid="history-detail-description-absent">
        No description is retained for this run.
      </p>
    {/if}
  </section>

  <section aria-label="Run cost and phases">
    {#if join.state === 'pending'}
      <p class="note" data-testid="history-detail-metrics-pending">Reading this run’s figures…</p>
    {:else}
      <dl class="fields metrics">
        <!-- FR-026 (T091) — three causes stay three answers. A zero the surface
             invented from a missing field, or from a read that never landed,
             reads exactly like a recorded one. -->
        <div class="field" data-testid="history-detail-cost" data-state={costState}>
          <dt>Cost</dt>
          <dd>
            {costState === 'reported'
              ? costText
              : costState === 'not-reported'
                ? 'Not reported'
                : 'Could not be read'}
          </dd>
        </div>
        <div class="field" data-testid="history-detail-phases" data-state={phaseState}>
          <dt>Phases</dt>
          <dd>
            <!-- FR-027 — three totals and nothing more. Nothing in the system
                 records a per-phase outcome for a finished run: the rollup holds
                 these integers and the audit corpus rotates away, so a breakdown
                 could only be invented and an invented one would be
                 indistinguishable from a recorded one. -->
            {#if phaseState === 'reported' && summary !== null}
              {summary.phasesTotal} total, {summary.phasesCompleted} completed,
              {summary.phasesSkipped} skipped
            {:else if phaseState === 'not-reported'}
              Not reported
            {:else}
              Could not be read
            {/if}
          </dd>
        </div>
      </dl>
    {/if}
  </section>

  <!-- The derived id, not `row.runId`: passing the raw property makes the prop
       a getter that re-reads `row`, which is the subscription the panel's own
       derived then has to absorb. Cheaper to not create it. -->
  <HistoryEvidencePanel {runId} />
</article>

<style>
  .run-detail {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-3);
    padding: var(--schegent-space-3);
  }
  .detail-header {
    display: flex;
    flex-wrap: wrap;
    gap: var(--schegent-gap);
    align-items: center;
    justify-content: space-between;
  }
  .identity {
    display: inline-flex;
    gap: 8px;
    align-items: center;
    min-width: 0;
  }
  .run-id {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--schegent-text-caption);
  }
  .back,
  .copy {
    min-height: var(--schegent-control-height);
    padding: 4px 10px;
    border: 1px solid var(--schegent-input-border);
    border-radius: var(--schegent-radius-sm);
    background: transparent;
    color: var(--schegent-fg);
    font: inherit;
    cursor: pointer;
  }
  .back:hover,
  .copy:hover {
    background: var(--schegent-list-hover);
  }
  .fields,
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
    gap: var(--schegent-gap);
    margin: 0;
  }
  .metrics {
    align-items: start;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .field dt {
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
  }
  .field dd {
    margin: 0;
    word-break: break-word;
  }
  /* FR-012, FR-026 — a stated absence is not a value, and must not read as one
     of the figures beside it. */
  .field dd.absent,
  .field[data-state='not-reported'] dd,
  .field[data-state='unreadable'] dd {
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
  .description-text {
    margin: 0;
    line-height: 1.45;
    text-wrap: pretty;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .note {
    margin: 4px 0 0;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    line-height: 1.4;
  }
</style>
