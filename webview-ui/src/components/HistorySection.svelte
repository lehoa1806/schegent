<script lang="ts">
  // Feature 103 (T017) — the list container for the cross-queue history list.
  //
  // What changed: this took `readonly HistoryEntry[]` and now takes
  // `readonly HistoryRow[]`. The two are not the same set. A `HistoryEntry` is
  // a durable record, so every entry had finished and every entry's status was
  // one of three terminal outcomes; a `HistoryRow` is either that or a run
  // still going, folded in for display only (FR-003 with FR-004). Keeping the
  // old prop type would have meant either dropping the live runs or writing
  // provisional records to invent them.
  //
  // The per-row markup moved to `HistoryRunRow.svelte` (see its header). What
  // stays here is what is genuinely per-list: the column header, the two empty
  // states, and the evidence state, which is keyed by run id across all rows
  // because only one Audit request should be in flight per run no matter how
  // the list is re-composed around it.

  import {
    NO_CATALOG_NAMES,
    type CatalogNames,
    type EvidenceState,
    type HistoryRow
  } from '../lib/history-rows';
  import HistoryRunRow from './HistoryRunRow.svelte';
  import { postCommand } from '../lib/vscode-api';
  import {
    CMD_RERUN_FROM_HISTORY,
    CMD_OPEN_AUDIT_LOG,
    CMD_OPEN_HISTORY_ITEM_DETAILS
  } from '../lib/messages';
  import { useConfirm } from '../lib/use-confirm';
  import { resolveAuditPointer } from '../lib/history-evidence-ipc';

  interface Props {
    rows: readonly HistoryRow[];
    isPrimary: boolean;
    selectedTaskId?: string | null;
    onTaskSelect?: (taskId: string) => void;
    variant?: 'compact' | 'ledger';
    /**
     * FR-021 — display names for the definition and Workflow ids a row carries.
     * Defaulted rather than required: the compact variant is mounted from places
     * that hold no catalog, and every label falls back to the id.
     */
    catalogNames?: CatalogNames;
    /**
     * Feature 103 (T052, FR-024) — where "Details" goes when the caller has a
     * detail view of its own.
     *
     * Optional, and the host command stays the default. The compact variant is
     * mounted from surfaces with nothing to drill into, and those must keep
     * posting `CMD_OPEN_HISTORY_ITEM_DETAILS`; only the History dashboard, which
     * renders the detail as a sub-view, overrides it.
     */
    onOpenDetail?: (runId: string) => void;
    /**
     * Feature 103 (T065, FR-033, FR-039) — where "Rerun" goes when the caller
     * has somewhere to put a trigger form.
     *
     * Optional on the same terms as `onOpenDetail`, and for a sharper reason:
     * the two paths are not the same action. The default posts
     * `CMD_RERUN_FROM_HISTORY`, which submits the run immediately — feature
     * 013's one-click repeat, and exactly what FR-039 rules out for the History
     * dashboard, which must open a pre-filled form and submit nothing until the
     * operator does. Surfaces with nowhere to render a form keep the one click.
     */
    onRerunRow?: (runId: string) => void;
  }

  const {
    rows,
    isPrimary,
    selectedTaskId = null,
    onTaskSelect,
    variant = 'compact',
    catalogNames = NO_CATALOG_NAMES,
    onOpenDetail,
    onRerunRow
  }: Props = $props();

  const empty = $derived(rows.length === 0);
  const rerunDisabled = $derived(!isPrimary);

  async function onRerun(event: MouseEvent, row: HistoryRow): Promise<void> {
    if (rerunDisabled) return;
    if (onRerunRow) {
      // No confirmation on this path, and that is not an omission. The
      // confirmation below exists because the default action enqueues a run on
      // the click; this one opens an editable form that starts nothing, and the
      // operator confirms by submitting it. A modal in front of a form is a
      // question asked twice.
      onRerunRow(row.runId);
      return;
    }
    // Feature 063 (T036) — gate rerun-from-history through the universal
    // confirmation. The task title surfaces in the modal body so the
    // operator can confirm they're re-enqueuing the right run.
    const ok = await useConfirm('history.rerun', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: { taskTitle: row.descriptionPreview }
    });
    if (!ok) return;
    postCommand(CMD_RERUN_FROM_HISTORY, { runId: row.runId });
  }

  // FR-R3-010 (T411) — per-row evidence state for the Audit action.
  //
  // `tone` is the whole point of this task. An operator told "could not load"
  // goes looking for a bug; one told "the audit log covering this run has been
  // rotated away" goes looking for the archive. Those are different actions, so
  // the three "no evidence" answers render as `info` and only a genuine
  // resolution failure renders as `error`. The host already keeps them apart on
  // the wire — collapsing them here would throw that away at the last step.
  let evidence = $state<Record<string, EvidenceState | undefined>>({});
  let pending = $state<Record<string, boolean>>({});

  async function onOpenAudit(runId: string): Promise<void> {
    if (pending[runId]) return;
    pending = { ...pending, [runId]: true };
    evidence = { ...evidence, [runId]: undefined };
    try {
      const result = await resolveAuditPointer(runId);
      evidence = { ...evidence, [runId]: describeEvidence(result) };
      // Only a run whose evidence is actually reachable opens the log. Opening
      // it on an expired pointer would drop the operator into a file that
      // cannot contain what they asked for, with nothing to say why.
      if (result.outcome === 'resolved') postCommand(CMD_OPEN_AUDIT_LOG);
    } finally {
      pending = { ...pending, [runId]: false };
    }
  }

  function describeEvidence(
    result: Awaited<ReturnType<typeof resolveAuditPointer>>
  ): EvidenceState {
    switch (result.outcome) {
      case 'resolved':
        return {
          tone: 'info',
          message: result.truncated
            ? `Opened audit log — showing the first ${result.entries.length} of this run's records.`
            : `Opened audit log — ${result.entries.length} record${result.entries.length === 1 ? '' : 's'} for this run.`
        };
      case 'evidence-expired':
        return {
          tone: 'info',
          message: 'The audit log covering this run has been rotated away. Check archived logs.'
        };
      case 'no-evidence-recorded':
        return { tone: 'info', message: 'This run recorded no audit entries.' };
      case 'unaddressable':
        return {
          tone: 'info',
          message: 'This run predates audit pointers, so its records cannot be located automatically.'
        };
      case 'failure':
        // The reason is a closed set the host chose; it never carries a path or
        // an adapter's message, so it is safe to branch on but not to print.
        return {
          tone: 'error',
          message:
            result.reason === 'corpus-unreadable'
              ? 'Could not read the audit log.'
              : 'Could not load this run’s audit records.'
        };
    }
  }

  function onOpenDetails(id: string): void {
    if (onOpenDetail) {
      onOpenDetail(id);
      return;
    }
    postCommand(CMD_OPEN_HISTORY_ITEM_DETAILS, { id });
  }
</script>

<section
  class="history"
  class:ledger={variant === 'ledger'}
  aria-label="Run history"
  data-testid="history-section"
>
  {#if empty}
    <!-- FR-007 — the empty history states that nothing has been recorded. The
         other empty state, for filters that exclude everything, is a different
         sentence rendered by the caller: an operator who has filtered the list
         down to nothing must not be told their workspace has no runs. -->
    <div class="empty" data-testid="history-empty">
      <strong>No runs recorded yet</strong>
      <span>Runs appear here as soon as they start, and stay once they finish.</span>
    </div>
  {:else}
    {#if variant === 'ledger'}
      <div class="ledger-columns" aria-hidden="true">
        <span>Run / feature</span>
        <span>Definition / version</span>
        <span>Queue</span>
        <span>Status</span>
        <span>Duration</span>
        <span>Updated</span>
        <span>Actions</span>
      </div>
    {/if}
    <ul>
      {#each rows as row (row.runId)}
        <HistoryRunRow
          {row}
          {variant}
          {catalogNames}
          {rerunDisabled}
          selected={selectedTaskId === row.runId}
          onSelect={onTaskSelect}
          evidence={evidence[row.runId]}
          auditPending={pending[row.runId] ?? false}
          {onRerun}
          {onOpenAudit}
          {onOpenDetails}
        />
      {/each}
    </ul>
  {/if}
</section>

<style>
  .history {
    padding: 0;
  }
  .empty {
    display: flex;
    min-height: 160px;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 5px;
    color: var(--schegent-muted-fg);
    margin: 0;
    padding: 20px;
    text-align: center;
  }
  .empty strong {
    color: var(--schegent-fg);
    font-size: 0.9rem;
  }
  .empty span {
    max-width: 38ch;
    font-size: 0.82rem;
    line-height: 1.45;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ledger ul {
    gap: 0;
  }

  .ledger-columns {
    display: grid;
    /* Character-identical to `.entry.ledger` in `HistoryRunRow.svelte`, and to
       that file's breakpoint below. Two declarations because Svelte scopes CSS
       per component and the header lives here while the rows live there. */
    grid-template-columns:
      minmax(200px, 1fr) minmax(150px, 1.2fr) 120px 104px 96px 116px 180px;
    gap: 12px;
    padding: 9px 14px;
    border-bottom: 1px solid var(--schegent-divider);
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  @media (max-width: 1000px) {
    .ledger-columns {
      display: none;
    }
  }
</style>
