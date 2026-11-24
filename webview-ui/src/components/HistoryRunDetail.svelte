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
  //
  // Since the redesign the detail is the body of the dashboard's drawer, and it
  // draws the drawer's three bands itself: the run's name and state on top, the
  // record in a scrolling body, and the two actions in the footer. Names come
  // first and the run id sits in the Diagnostics fold, where it is still one
  // click from the clipboard.

  import { untrack } from 'svelte';
  import {
    NO_CATALOG_NAMES,
    provenanceLabels,
    type CatalogNames,
    type HistoryRow
  } from '../lib/history-rows';
  import type { MetricsRunSummary } from '../lib/messages';
  import { readRunSummary, type RunSummaryResult } from '../lib/metrics-ipc';
  import {
    FAILURE_CAUSE_LABELS,
    FAILURE_CAUSE_NOT_RECORDED,
    isFailureCause
  } from '../../../src/contracts/failure-cause';
  import { copyText } from '../lib/copy-text';
  import { formatAbsoluteTime } from '../lib/format';
  import { formatDuration } from '../lib/format-duration';
  import { runStatusChip } from '../lib/run-status-chip';
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import HistoryEvidencePanel from './HistoryEvidencePanel.svelte';
  import ExecutionVisibilityPanel from './ExecutionVisibilityPanel.svelte';

  interface Props {
    row: HistoryRow;
    onBack: () => void;
    catalogNames?: CatalogNames;
    /** Whether this window holds workspace primacy; falls back to live `snapshotStore.isPrimary`. */
    isPrimary?: boolean;
    /**
     * FR-R3-127 (FR-004) — the two facts the evidence panel needs to say whether
     * this Run's unredacted transcript is being kept, and for how long.
     *
     * Defaulted to the shipped values rather than made required: every existing
     * mount would otherwise break, and the shipped default is the correct reading
     * when a caller has no snapshot to read from.
     */
    rawTranscriptMode?: 'always' | 'errors-only' | 'off';
    retentionMaxAgeDays?: number;
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
    /**
     * The id the heading carries, so the drawer around the detail can take its
     * name from it (`aria-labelledby`) and move focus to it when it opens.
     * Optional: a mount with no drawer around it has nothing to label.
     */
    headingId?: string;
  }

  const {
    row,
    onBack,
    catalogNames = NO_CATALOG_NAMES,
    isPrimary,
    onRerun,
    rawTranscriptMode = 'errors-only',
    retentionMaxAgeDays = 30,
    headingId
  }: Props = $props();

  const effectiveIsPrimary = $derived(isPrimary ?? snapshotStore.isPrimary);

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
    // FR-R4-F05 (I6, I8, FR-024) — a late answer replaces the unreadable state through the same
    // path; a new run or unmounting aborts the wait.
    const lifetime = new AbortController();
    const show = (result: RunSummaryResult): void => {
      if (!live) return;
      join =
        result.outcome === 'read'
          ? { state: 'read', summary: result.summary }
          : { state: 'unreadable' };
    };
    // Asked untracked. The intent ledger marks the request pending in the
    // snapshot store, which reads the store's pending set and replaces it; read
    // tracked, that set makes this effect depend on its own write, and it reads
    // the rollup a second time.
    void untrack(() =>
      readRunSummary(wanted, { signal: lifetime.signal, onLateOutcome: show })
    ).then(show);
    return () => {
      live = false;
      lifetime.abort();
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

  // FR-R4-F14 (M7, data-model §8) — a failed run's cause, in the same states the fields above have, with
  // the one a cost cannot have: a run that recorded no cause is "not recorded", which is a fact about the
  // run, and a read that never landed is "unreadable", which is a fact about the window. The code is shown
  // only if it is a member of the closed vocabulary, so a value this build cannot label never reaches the
  // page as text; both words around it are host constants.
  const recordedCause = $derived(
    summary !== null && isFailureCause(summary.failureCause) ? summary.failureCause : null
  );
  const causeState = $derived.by((): 'recorded' | 'not-recorded' | 'unreadable' => {
    if (join.state === 'unreadable') return 'unreadable';
    return recordedCause === null ? 'not-recorded' : 'recorded';
  });

  // The same `$${n.toFixed(2)}` the metrics surfaces already use, so one run's
  // cost and the cumulative total read as the same kind of figure.
  const costText = $derived(
    summary?.costUsd === undefined ? '' : `$${summary.costUsd.toFixed(2)}`
  );

  const provenance = $derived(provenanceLabels(row, catalogNames));
  const chip = $derived(runStatusChip(row.status));
  // The run's name is its description, as in the list; a run whose description
  // retention removed is named by its id rather than by nothing.
  const runLabel = $derived(row.descriptionPreview || row.runId);

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
  <div class="dh">
    <div class="heading">
      <h2 id={headingId} tabindex="-1">{runLabel}</h2>
      <div class="state">
        <span class="chip {chip.tone}" data-testid="history-detail-status"><span class="sr-only">Status: </span>{#if chip.icon}<svg class="i" aria-hidden="true"><use href={chip.icon}></use></svg>{:else}<span class="dot" aria-hidden="true"></span>{/if}{chip.label}</span>
      </div>
    </div>
    <button
      type="button"
      class="icon-btn"
      aria-label="Close run details"
      data-testid="history-detail-back"
      onclick={onBack}
    >
      <svg class="i" aria-hidden="true"><use href="#i-x"></use></svg>
    </button>
  </div>

  <div class="db">
    <!-- FR-R4-F14 (FR-018, clarification Q4) — only a failed run has a cause. The label and the code
         come from host constants and Svelte escapes both; no count, chart, filter or column (Q3).
         The box stands for every failed run, a cause not recorded or not read included: that the
         run failed is on the record either way. -->
    {#if row.status === 'failed'}
      <div class="attn">
        <svg class="i ic" aria-hidden="true"><use href="#i-warn"></use></svg>
        <div class="body small">
          <b>Why it failed.</b>
          {#if join.state === 'pending'}
            <span class="pending">Reading the recorded cause…</span>
          {:else}
            <span class="cause" data-testid="history-detail-cause" data-state={causeState}>
              {#if causeState === 'recorded' && recordedCause !== null}
                {FAILURE_CAUSE_LABELS[recordedCause]} <span class="code mono">({recordedCause})</span>
              {:else if causeState === 'not-recorded'}
                {FAILURE_CAUSE_NOT_RECORDED}
              {:else}
                Could not be read
              {/if}
            </span>
          {/if}
        </div>
      </div>
    {/if}

    <h3>Run</h3>
    <!-- FR-024 — what the record itself says. Started, ended and duration, and no
         queued time: `queuedAt` lives on the live queue item and dies with it, so
         a figure here could only be reconstructed, and a reconstructed timestamp
         beside recorded ones is a lie that looks exactly like a fact. -->
    <dl class="kv">
      <div class="pair" data-testid="history-detail-definition">
        <dt>Definition</dt>
        <dd>{provenance.definition}</dd>
      </div>
      <div class="pair" data-testid="history-detail-version">
        <dt>Version</dt>
        <!-- FR-012 — the same stated absence the row uses, so drilling in does
             not change what a run is understood to have recorded. -->
        <dd class:absent={row.catalogVersion === null}>{provenance.version}</dd>
      </div>
      <div class="pair" data-testid="history-detail-origin">
        <dt>Started as</dt>
        <dd>{provenance.origin}</dd>
      </div>
      <div class="pair" data-testid="history-detail-queue">
        <dt>Queue</dt>
        <dd>{row.queueName}</dd>
      </div>
      <div class="pair" data-testid="history-detail-started">
        <dt>Started</dt>
        <dd>{startedText}</dd>
      </div>
      <div class="pair" data-testid="history-detail-ended">
        <dt>Ended</dt>
        <dd>{endedText}</dd>
      </div>
      <div class="pair" data-testid="history-detail-duration">
        <dt>Duration</dt>
        <dd>{durationText}</dd>
      </div>
      {#if join.state === 'pending'}
        <!-- The two figures hold their rows while the read is out, so the list
             does not grow under the operator's eye when it lands. -->
        <div class="pair" data-testid="history-detail-metrics-pending">
          <dt>Cost</dt>
          <dd class="absent">Reading…</dd>
        </div>
        <div class="pair">
          <dt>Phases</dt>
          <dd class="absent">Reading…</dd>
        </div>
      {:else}
        <!-- FR-026 (T091) — three causes stay three answers. A zero the surface
             invented from a missing field, or from a read that never landed,
             reads exactly like a recorded one. -->
        <div class="pair" data-testid="history-detail-cost" data-state={costState}>
          <dt>Cost</dt>
          <dd>
            {costState === 'reported'
              ? costText
              : costState === 'not-reported'
                ? 'Not reported'
                : 'Could not be read'}
          </dd>
        </div>
        <div class="pair" data-testid="history-detail-phases" data-state={phaseState}>
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
      {/if}
    </dl>

    <h3>Description</h3>
    {#if hasDescription}
      <p class="description-text small" data-testid="history-detail-description">{row.descriptionPreview}</p>
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

    <!-- The derived id, not `row.runId`: passing the raw property makes the prop
         a getter that re-reads `row`, which is the subscription the panel's own
         derived then has to absorb. Cheaper to not create it. -->
    <HistoryEvidencePanel
      {runId}
      runStatus={row.status}
      rawTranscriptMode={rawTranscriptMode}
      retentionMaxAgeDays={retentionMaxAgeDays}
    />

    <details class="diag">
      <summary>Diagnostics</summary>
      <dl class="kv">
        <dt>Run ID</dt>
        <dd class="mono" data-testid="history-detail-run-id">{row.runId}</dd>
      </dl>
    </details>

    <ExecutionVisibilityPanel rootExecutionId={runId} isPrimary={effectiveIsPrimary} />
  </div>

  <div class="df">
    <button
      type="button"
      class="btn btn-secondary"
      data-testid="history-detail-copy-run-id"
      aria-label={`Copy run ID ${row.runId}`}
      onclick={onCopyRunId}
    >
      <svg class="i" aria-hidden="true"><use href={copied === 'done' ? '#i-check' : '#i-copy'}></use></svg>{copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy blocked' : 'Copy run ID'}
    </button>
    {#if onRerun}
      <button
        type="button"
        class="btn btn-primary"
        data-testid="history-detail-rerun"
        onclick={() => onRerun()}
      >
        <svg class="i" aria-hidden="true"><use href="#i-refresh"></use></svg>Run again…
      </button>
    {/if}
  </div>
</article>

<style>
  /* The bands themselves (`.dh`, `.db`, `.df`) are the drawer's, from the dashboard
     sheet. This column only hands the body the height left between head and
     footer, so the record scrolls and the two actions stay in reach. */
  .run-detail {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .heading {
    flex: 1;
    min-width: 0;
  }
  /* A description names the run here, and some descriptions are paragraphs.
     Three lines name it; the Description section below carries all of it. */
  .heading h2 {
    display: -webkit-box;
    overflow: hidden;
    line-clamp: 3;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow-wrap: anywhere;
  }
  .state {
    margin-top: var(--schegent-space-1);
  }
  .pair {
    display: contents;
  }
  .kv dd {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .code {
    display: block;
    margin-top: var(--schegent-space-0-5);
    color: var(--schegent-muted-fg);
  }
  /* FR-012, FR-026 — a stated absence is not a value, and must not read as one
     of the figures beside it. */
  .absent,
  .pair[data-state='not-reported'] dd,
  .pair[data-state='unreadable'] dd {
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
  /* Inside the failure box an absence keeps the box's ink, for contrast on the
     tinted ground, and says what it is by its slant. */
  .pending,
  .cause[data-state='not-recorded'],
  .cause[data-state='unreadable'] {
    font-style: italic;
  }
  .description-text {
    margin: 0;
    line-height: 1.45;
    text-wrap: pretty;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .note {
    margin: var(--schegent-space-1) 0 0;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    line-height: 1.4;
  }
</style>
