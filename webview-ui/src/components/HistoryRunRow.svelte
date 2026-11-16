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
  // Drawn as a row of the redesign's run table: the run's name with what it
  // froze under it, then its queue, its status as a chip, its duration, when it
  // last changed, and its actions in an overflow menu. The cells sit under the
  // section's own column headers, so the two cannot drift apart the way two
  // copies of one grid template could.

  import SgMenu from './sg/SgMenu.svelte';
  import {
    NO_CATALOG_NAMES,
    provenanceLabels,
    type CatalogNames,
    type EvidenceState,
    type HistoryRow
  } from '../lib/history-rows';
  import { formatDuration } from '../lib/format-duration';
  import { formatRelativeTime } from '../lib/format';
  import { runStatusChip } from '../lib/run-status-chip';

  interface Props {
    row: HistoryRow;
    /**
     * Which list the row is drawn in. Both draw the same table row since the redesign; a
     * ledger row carries the `ledger` class, so the two can still be told apart.
     */
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
  // and the one it is executing is the same one. The item stays in the menu so
  // the menu has the same shape on every row, and says why it is off.
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

  // FR-003 — a run still going must be distinguishable from one that finished,
  // and the live statuses from each other: the chip says each in words, with a
  // mark of its own, so none of them rests on colour alone.
  const chip = $derived(runStatusChip(row.status));

  // FR-011, FR-012, FR-014 — what this run froze, and how it was started. Three
  // parts rather than one composite string: the R2 case puts 'pipeline' in the
  // version's kind and 'workflow-member' in the origin on the same row, and a
  // reader has to be able to see both without one being read as the other.
  const provenance = $derived(provenanceLabels(row, catalogNames));
</script>

<tr
  class:ledger={variant === 'ledger'}
  class:sel={selected}
  class:live={isLive}
  data-testid="history-entry-{row.runId}"
  data-history-row={row.runId}
  data-history-source={row.source}
  data-history-queue={row.queueId}
>
  <td class="run">
    {#if onSelect}
      <button
        type="button"
        class="rowname"
        aria-label={`Select run '${label}'`}
        aria-pressed={selected}
        data-testid="history-item-select-{row.runId}"
        title={label}
        onclick={() => onSelect(row.runId)}
      >{label}</button>
    {:else}
      <!-- The run's name opens its detail, as a name does in every other table
           of the redesign. `aria-current` marks the run whose detail is open. -->
      <button
        type="button"
        class="rowname"
        aria-label={`Open details for '${label}'`}
        aria-disabled={readOnlyAria}
        aria-current={selected ? 'true' : undefined}
        data-testid="history-item-open-details-{row.runId}"
        title={label}
        onclick={() => onOpenDetails(row.runId)}
      >{label}</button>
    {/if}
    <!-- FR-011 — the definition reads first; the version and the kind qualify
         it. All three are always present, so the line has one shape whether or
         not a run recorded any of them. -->
    <div class="sub">
      <span
        data-testid="history-item-{row.runId}-definition"
        aria-label={`Definition: ${provenance.definition}`}
        title="Definition"
      >{provenance.definition}</span>
      <span aria-hidden="true">·</span>
      <span
        class:not-recorded={row.catalogVersion === null}
        data-testid="history-item-{row.runId}-version"
        aria-label={`Version: ${provenance.version}`}
        title="Published version this run froze"
      >{provenance.version}</span>
      <span aria-hidden="true">·</span>
      <span
        data-testid="history-item-{row.runId}-origin"
        aria-label={`Started as: ${provenance.origin}`}
        title="How this run was started"
      >{provenance.origin}</span>
    </div>
    {#if evidence}
      {#if evidence.tone === 'error'}
        <div
          class="evidence tone-error"
          data-testid="history-item-evidence-{row.runId}"
          data-evidence-tone="error"
          role="alert"
        >{evidence.message}</div>
      {:else}
        <div
          class="evidence tone-info"
          data-testid="history-item-evidence-{row.runId}"
          data-evidence-tone="info"
          role="status"
        >{evidence.message}</div>
      {/if}
    {/if}
  </td>
  <td>
    <span
      class="queue"
      data-testid="history-item-{row.runId}-queue"
      aria-label={`Queue: ${row.queueName}`}
      title="Queue"
    >{row.queueName}</span>
  </td>
  <td>
    <span
      class="chip {chip.tone}"
      data-testid="history-item-{row.runId}-status"
      aria-label={`Status: ${chip.label}`}
    >{#if chip.icon}<svg class="i" aria-hidden="true"><use href={chip.icon}></use></svg>{:else}<span
          class="dot"
          aria-hidden="true"
        ></span>{/if}{chip.label}</span>
  </td>
  <td class="num nowrap" data-testid="history-item-{row.runId}-duration" title="Duration">{duration}</td>
  <td class="nowrap" data-testid="history-item-{row.runId}-completed-at" title={timeTitle}>{timeText}</td>
  <td class="acts">
    <SgMenu label={`Actions for '${label}'`} testid="history-item-actions-{row.runId}">
      <button
        type="button"
        role="menuitem"
        data-testid="history-item-rerun-{row.runId}"
        aria-disabled={ariaRerun}
        onclick={(event) => (rerunOff ? undefined : onRerun(event, row))}
      >
        <svg class="i" aria-hidden="true"><use href="#i-refresh"></use></svg>
        Run again…
        {#if isLive}<span class="hint">Not finished</span>{/if}
      </button>
      <button
        type="button"
        role="menuitem"
        data-testid="history-item-open-audit-{row.runId}"
        aria-disabled={auditPending ? 'true' : readOnlyAria}
        onclick={() => onOpenAudit(row.runId)}
      >
        <svg class="i" aria-hidden="true"><use href="#i-pulse"></use></svg>
        Open audit log
      </button>
      {#if onSelect}
        <!-- The name selects here, so the detail needs a way in of its own. -->
        <button
          type="button"
          role="menuitem"
          data-testid="history-item-open-details-{row.runId}"
          aria-disabled={readOnlyAria}
          onclick={() => onOpenDetails(row.runId)}
        >
          <svg class="i" aria-hidden="true"><use href="#i-open"></use></svg>
          Open details
        </button>
      {/if}
    </SgMenu>
  </td>
</tr>

<style>
  /* A long description stops at two lines; the whole of it is in the title. */
  .rowname {
    display: -webkit-box;
    max-width: 52ch;
    overflow: hidden;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    word-break: break-word;
  }
  .rowname:hover {
    text-decoration: underline;
  }
  .sub {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--schegent-space-1);
    margin-top: var(--schegent-space-0-5);
  }
  /* FR-012 — a stated absence is not a value. It is said in full, and set in
     italic so it does not read as one of the versions beside it. FR-R3-131
     (T1498) keeps it at the theme's muted foreground rather than dimmed further,
     which took it below AA. */
  .not-recorded {
    font-style: italic;
  }
  .queue {
    display: inline-block;
    max-width: 18ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: top;
  }
  .nowrap {
    white-space: nowrap;
  }
  /* As narrow as its one button, at the row's far edge. */
  .acts {
    width: 1%;
    text-align: right;
  }
  /* FR-R3-010 (T411) — the two tones are visually distinct on purpose. An
     expired pointer is an ordinary fact about retention, so it reads muted;
     only a failure borrows the error colour. */
  .evidence {
    max-width: 60ch;
    margin-top: var(--schegent-space-1);
    font-size: var(--schegent-text-secondary);
  }
  .evidence.tone-info {
    color: var(--schegent-muted-fg);
  }
  .evidence.tone-error {
    color: var(--schegent-error-text);
  }
  /* On the selection colour, every line of the row reads in the row's own
     foreground; the words already say which is which. */
  .sel .evidence.evidence {
    color: inherit;
  }
</style>
