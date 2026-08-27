<script lang="ts">
  // Feature 103 (T017, T018, T020) — one row of the cross-queue history list.
  //
  // Split out of `HistorySection.svelte` rather than added to it. That file was
  // at 484 of its 500-line budget before this feature, and User Story 1 alone
  // adds a queue column and a source that is not a terminal outcome; US2 adds
  // provenance and US4 adds evidence. Extracting the row now means the split
  // happens once, at a seam that is obvious, instead of under budget pressure
  // three stories later.
  //
  // The row owns its own grid. Svelte scopes CSS per component, so a layout
  // declared in the parent would not reach these elements without `:global` —
  // and a `:global` grid keyed on `.entry` is exactly the kind of rule that
  // leaks into the next list someone writes.

  import {
    NO_CATALOG_NAMES,
    provenanceLabels,
    type CatalogNames,
    type EvidenceState,
    type HistoryRow
  } from '../lib/history-rows';
  import { formatDuration } from '../lib/format-duration';
  import { formatRelativeTime } from '../lib/format';

  interface Props {
    row: HistoryRow;
    variant: 'compact' | 'ledger';
    /** FR-021 — id-to-name for the definition and Workflow; ids stand in when absent. */
    catalogNames?: CatalogNames;
    /** FR-004 — a run still going has no durable record to re-run from. */
    rerunDisabled: boolean;
    selected: boolean;
    onSelect?: (runId: string) => void;
    evidence?: EvidenceState | undefined;
    auditPending: boolean;
    onRerun: (event: MouseEvent, row: HistoryRow) => void;
    onOpenAudit: (runId: string) => void;
    onOpenDetails: (runId: string) => void;
  }

  const {
    row,
    variant,
    catalogNames = NO_CATALOG_NAMES,
    rerunDisabled,
    selected,
    onSelect,
    evidence,
    auditPending,
    onRerun,
    onOpenAudit,
    onOpenDetails
  }: Props = $props();

  const readOnlyAria = 'false' as const;

  // A run still going cannot be re-run: there is no recorded plan to repeat,
  // and the one it is executing is the same one. The button stays present so
  // the column does not reflow row to row, and says why it is off.
  const isLive = $derived(row.source === 'in-flight');
  const rerunOff = $derived(rerunDisabled || isLive);
  const ariaRerun = $derived<'true' | 'false'>(rerunOff ? 'true' : 'false');

  // FR-053 (row half) — the stored preview for a recorded row, the live run's
  // feature label for one still going. Neither is guaranteed non-empty, and a
  // blank cell reads as a rendering fault rather than as an absent value.
  const label = $derived(row.descriptionPreview || row.runId);

  const duration = $derived(row.durationMs === null ? '—' : formatDuration(row.durationMs));

  // The recorded row is timed by when it ended, the live one by when it began —
  // the same split `orderingKey` makes, so the column and the sort agree.
  const timestamp = $derived(row.completedAt ?? row.startedAt);
  const timeText = $derived(timestamp === null ? '—' : formatRelativeTime(timestamp));
  const timeTitle = $derived(row.completedAt !== null ? 'Completed' : 'Started');

  // FR-011, FR-012, FR-014 — what this run froze, and how it was started. Three
  // cells rather than one composite string: the R2 case puts 'pipeline' in the
  // version's kind and 'workflow-member' in the origin on the same row, and a
  // reader has to be able to see both without one being read as the other.
  const provenance = $derived(provenanceLabels(row, catalogNames));
</script>

<li
  class="entry status-{row.status}"
  class:ledger={variant === 'ledger'}
  class:selected
  class:live={isLive}
  data-testid="history-entry-{row.runId}"
  data-history-row={row.runId}
  data-history-source={row.source}
  data-history-queue={row.queueId}
>
  {#if onSelect}
    <button
      type="button"
      class="label entry-select"
      aria-label={`Select run '${label}'`}
      aria-pressed={selected}
      data-testid="history-item-select-{row.runId}"
      title={label}
      onclick={() => onSelect(row.runId)}
    >{label}</button>
  {:else}
    <span class="label" title={label}>{label}</span>
  {/if}
  <span class="meta">
    <span class="provenance">
      <span
        class="definition"
        data-testid="history-item-{row.runId}-definition"
        aria-label={`Definition: ${provenance.definition}`}
        title="Definition"
      >{provenance.definition}</span>
      <span
        class="badge version-badge"
        class:not-recorded={row.catalogVersion === null}
        data-testid="history-item-{row.runId}-version"
        aria-label={`Version: ${provenance.version}`}
        title="Published version this run froze"
      >{provenance.version}</span>
      <span
        class="badge origin-badge"
        data-testid="history-item-{row.runId}-origin"
        aria-label={`Started as: ${provenance.origin}`}
        title="How this run was started"
      >{provenance.origin}</span>
    </span>
    <span
      class="badge queue-badge"
      data-testid="history-item-{row.runId}-queue"
      aria-label={`Queue: ${row.queueName}`}
      title="Queue"
    >{row.queueName}</span>
    <span
      class="badge status-badge"
      data-testid="history-item-{row.runId}-status"
      aria-label={`Status: ${row.status}`}
    >{row.status}</span>
    <span
      class="time duration"
      data-testid="history-item-{row.runId}-duration"
      title="Duration"
    >{duration}</span>
    <span
      class="time completed-at"
      data-testid="history-item-{row.runId}-completed-at"
      title={timeTitle}
    >{timeText}</span>
  </span>
  <span class="actions">
    <button
      type="button"
      class="action"
      data-testid="history-item-rerun-{row.runId}"
      aria-label={isLive ? `Cannot rerun '${label}' — it has not finished` : `Rerun '${label}'`}
      aria-disabled={ariaRerun}
      onclick={(event) => (rerunOff ? undefined : onRerun(event, row))}
    >Rerun</button>
    <button
      type="button"
      class="action"
      data-testid="history-item-open-audit-{row.runId}"
      aria-label="Open audit log"
      aria-disabled={auditPending ? 'true' : readOnlyAria}
      onclick={() => onOpenAudit(row.runId)}
    >Audit</button>
    <button
      type="button"
      class="action"
      data-testid="history-item-open-details-{row.runId}"
      aria-label={`Open details for '${label}'`}
      aria-disabled={readOnlyAria}
      onclick={() => onOpenDetails(row.runId)}
    >Details</button>
  </span>
  {#if evidence}
    {#if evidence.tone === 'error'}
      <span
        class="evidence tone-error"
        data-testid="history-item-evidence-{row.runId}"
        data-evidence-tone="error"
        role="alert"
      >{evidence.message}</span>
    {:else}
      <span
        class="evidence tone-info"
        data-testid="history-item-evidence-{row.runId}"
        data-evidence-tone="info"
        role="status"
      >{evidence.message}</span>
    {/if}
  {/if}
</li>

<style>
  .entry {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    column-gap: var(--schegent-gap);
    align-items: center;
    padding: 4px var(--schegent-pad);
    border-radius: var(--schegent-radius);
  }
  .entry:hover {
    background: var(--schegent-list-hover);
  }
  .entry.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .entry.selected .label {
    color: inherit;
  }
  .entry.selected .meta {
    color: inherit;
    opacity: 0.8;
  }
  .entry.selected .action {
    color: inherit;
    border-color: currentColor;
    opacity: 0.8;
  }
  .entry.selected .action:hover:not([aria-disabled='true']) {
    opacity: 1;
  }
  .label {
    grid-column: 1;
    grid-row: 1;
    overflow: hidden;
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-height: 1.35;
    word-break: break-word;
  }
  .entry-select {
    width: 100%;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    padding: 0;
    text-align: left;
    cursor: pointer;
  }
  .entry-select:hover {
    text-decoration: underline;
  }
  .entry-select:focus-visible {
    border-radius: var(--schegent-radius-sm);
    outline: 1px solid var(--schegent-focus-border);
    outline-offset: 2px;
  }
  .meta {
    grid-column: 1;
    grid-row: 2;
    display: flex;
    flex-wrap: wrap;
    gap: var(--schegent-gap);
    align-items: center;
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }
  .badge {
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius-sm);
    padding: 0 6px;
  }
  .queue-badge {
    max-width: 18ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* FR-011 — the definition reads as the primary of the three; the version and
     the kind qualify it. All three are always present, so the group has a fixed
     shape whether or not a run recorded any of them. */
  .provenance {
    display: inline-flex;
    min-width: 0;
    gap: 5px;
    align-items: center;
  }
  .definition {
    max-width: 20ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--schegent-fg);
  }
  .version-badge,
  .origin-badge {
    max-width: 16ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* FR-012 — a stated absence is not a value. It is said in full, and it is
     dimmed so it does not read as one of the versions beside it. */
  .version-badge.not-recorded {
    max-width: none;
    border-style: dashed;
    /* FR-R3-131 (T1498) — was `opacity: 0.75`, which dimmed the text below AA and
       was six of the thirty baselined findings. The dashed border and the italic
       already say "a stated absence, not a value"; the opacity was saying it a
       third time at the cost of legibility. The muted foreground is the theme's own
       token for secondary text and is contrast-safe against the surface. */
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
  .status-completed .status-badge {
    color: var(--schegent-color-completed);
    border-color: currentColor;
  }
  .status-failed .status-badge {
    color: var(--schegent-error-text);
    border-color: currentColor;
  }
  .status-canceled .status-badge {
    color: var(--schegent-muted-fg);
    border-color: currentColor;
  }
  /* FR-003 — a run still going must be distinguishable from one that finished,
     and the three live statuses are distinguishable from each other. */
  .status-running .status-badge {
    /* `--schegent-color-active` is the in-flight colour the rest of the surface
       already uses for this state; `StatusBar.svelte` paints its live dot with
       the same token. */
    color: var(--schegent-color-active);
    border-color: currentColor;
  }
  .status-paused .status-badge {
    color: var(--schegent-warning-text);
    border-color: currentColor;
  }
  .status-idle .status-badge {
    color: var(--schegent-muted-fg);
    border-color: currentColor;
  }
  .actions {
    grid-column: 2;
    grid-row: 1 / span 2;
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  /* FR-R3-010 (T411) — the two tones are visually distinct on purpose. An
     expired pointer is an ordinary fact about retention, so it reads muted;
     only a failure borrows the error colour. */
  .evidence {
    grid-column: 1 / -1;
    grid-row: 3;
    padding-top: 3px;
    font-size: 0.82em;
    line-height: 1.4;
  }
  .evidence.tone-info {
    color: var(--schegent-muted-fg);
  }
  .evidence.tone-error {
    color: var(--schegent-error-text);
  }
  .action {
    background: transparent;
    color: var(--schegent-muted-fg);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius-sm);
    padding: 0 6px;
    font: inherit;
    cursor: pointer;
  }
  .action[aria-disabled='true'] {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .action:hover:not([aria-disabled='true']) {
    color: var(--schegent-fg);
  }

  .entry.ledger {
    /* Seven columns since T033: provenance sits between the run and its queue,
       because "what ran" belongs next to "which run" and before the bookkeeping.
       The minimums total 966px, which is what moved the collapse breakpoint
       below from 900px to 1000px. */
    grid-template-columns:
      minmax(200px, 1fr) minmax(150px, 1.2fr) 120px 104px 96px 116px 180px;
    grid-template-rows: auto;
    gap: 12px;
    min-height: 54px;
    padding: 9px 14px;
    border-bottom: 1px solid var(--schegent-divider);
    border-radius: 0;
  }
  .entry.ledger:last-child {
    border-bottom: 0;
  }
  .entry.ledger .label {
    grid-column: 1;
    grid-row: 1;
    line-clamp: 1;
    -webkit-line-clamp: 1;
  }
  .entry.ledger .meta {
    display: contents;
  }
  .entry.ledger .provenance {
    grid-column: 2;
    align-self: center;
    justify-self: start;
  }
  .entry.ledger .queue-badge {
    grid-column: 3;
    align-self: center;
    justify-self: start;
  }
  .entry.ledger .status-badge {
    grid-column: 4;
    align-self: center;
    justify-self: start;
  }
  .entry.ledger .time {
    align-self: center;
    font-variant-numeric: tabular-nums;
  }
  .entry.ledger .duration {
    grid-column: 5;
  }
  .entry.ledger .completed-at {
    grid-column: 6;
  }
  .entry.ledger .actions {
    grid-column: 7;
    grid-row: 1;
    justify-self: end;
  }
  .entry.ledger .action {
    min-height: 28px;
    padding: 0 8px;
  }

  @media (max-width: 1000px) {
    .entry.ledger {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-rows: auto auto;
    }
    .entry.ledger .label {
      grid-column: 1;
      grid-row: 1;
      line-clamp: 2;
      -webkit-line-clamp: 2;
    }
    .entry.ledger .meta {
      grid-column: 1;
      grid-row: 2;
      display: flex;
    }
    .entry.ledger .actions {
      grid-column: 2;
      grid-row: 1 / span 2;
    }
  }

  @media (max-width: 620px) {
    .entry.ledger {
      grid-template-columns: 1fr;
    }
    .entry.ledger .actions {
      grid-column: 1;
      grid-row: 3;
      justify-self: start;
    }
  }
</style>
