<script lang="ts">
  // Feature 103 (T054, T055 — FR-028, FR-029, FR-030) — what the detail says
  // about one run's evidence.
  //
  // The host's resolver answers with a five-arm union whose failure arm carries
  // its own reason: seven answers, and six an operator has to be able to tell
  // apart. FR-028 forbids the shortcut of grading them — healthy, degraded,
  // unavailable is the vocabulary for an evidence *sink*, which is a writer,
  // workspace-wide, over time. A run has no writer; it has one pointer. Under a
  // sink grade "the log was rotated away" and "this run recorded nothing" come
  // out the same, and those are opposite facts: the first has archives to look
  // in and the second has nothing to look for.
  //
  // So every arm gets its own sentence, and the arm itself is published on the
  // root as `data-evidence-outcome` — the copy may be rewritten, but two arms
  // may never become one.
  //
  // The read is per-open and unconditional: the panel is only ever mounted for
  // a run the operator drilled into (FR-023), so there is nothing to throttle.

  import { resolveAuditPointer, type ResolveAuditPointerResult } from '../lib/history-evidence-ipc';
  import { formatAbsoluteTime } from '../lib/format';

  interface Props {
    runId: string;
    /**
     * FR-R3-127 (FR-004) — the Run's terminal status, the capture mode, and the
     * window. Together they decide whether an unredacted transcript is being held
     * for THIS Run, which is the question an operator looking at a failed Run has
     * and which a settings page cannot answer.
     */
    runStatus?: string;
    rawTranscriptMode?: 'always' | 'errors-only' | 'off';
    retentionMaxAgeDays?: number;
  }

  const {
    runId,
    runStatus = '',
    rawTranscriptMode = 'errors-only',
    retentionMaxAgeDays = 30
  }: Props = $props();

  /**
   * Whether this Run retains an unredacted raw transcript right now.
   *
   * The condition is `(mode, outcome)` and NOT the mode alone. Under the shipped
   * `errors-only` a successful Run retains nothing raw, and a panel that announced
   * a retention window anyway would be noise attached to the majority case — which
   * is how a real warning gets ignored.
   *
   *   off          -> never
   *   always       -> every Run
   *   errors-only  -> failed, canceled or paused Runs, which is exactly where the
   *                   audit of 2026-08-27 found the concentration: "where prompts
   *                   and output are most likely to contain sensitive debugging
   *                   context".
   */
  const RAW_RETAINING_OUTCOMES = ['failed', 'canceled', 'cancelled', 'paused'];
  const retainsRawTranscript = $derived.by(() => {
    if (rawTranscriptMode === 'off') return false;
    if (rawTranscriptMode === 'always') return true;
    return RAW_RETAINING_OUTCOMES.includes(runStatus.toLowerCase());
  });

  let result = $state<ResolveAuditPointerResult | null>(null);

  // Keyed on the run id and nothing else, which the `$derived` is what makes
  // true. A prop is a getter back into the parent's expression, so reading
  // `runId` straight inside the effect subscribes it to whatever the parent
  // read to produce it — here, the row object the detail rebuilds on every host
  // push. The effect would then re-resolve the corpus once per push (T051,
  // FR-023). A derived over a primitive stops there: same string, no notify.
  const wantedRunId = $derived(runId);

  $effect(() => {
    const wanted = wantedRunId;
    let live = true;
    result = null;
    void resolveAuditPointer(wanted).then((answer) => {
      // A late answer for a run the panel has moved off would otherwise
      // overwrite the current one with evidence about a different run.
      if (live) result = answer;
    });
    return () => {
      live = false;
    };
  });

  /**
   * The arm the panel commits to, flattened so the failure reason is a peer of
   * the other outcomes rather than nested inside one of them. Six answers an
   * operator acts on differently should not require reading two fields.
   */
  const outcome = $derived.by(() => {
    if (result === null) return 'pending';
    return result.outcome === 'failure' ? result.reason : result.outcome;
  });

  const resolved = $derived(result?.outcome === 'resolved' ? result : null);

  const message = $derived.by(() => {
    if (result === null) return 'Looking for this run’s evidence…';
    switch (result.outcome) {
      case 'resolved':
        return result.entries.length === 1
          ? 'The audit log for this run resolved to 1 record.'
          : `The audit log for this run resolved to ${result.entries.length} records.`;
      // FR-029 — the pointer worked and the target is gone. An ordinary fact
      // about retention, and the operator's next move is the archives.
      case 'evidence-expired':
        return 'The audit log covering this run has been rotated away. Check archived logs.';
      // FR-030 — nothing was ever written. There is no next move, and telling
      // an operator to check archives would send them after a file that does
      // not exist.
      case 'no-evidence-recorded':
        return 'This run recorded no audit entries.';
      case 'unaddressable':
        return 'This run predates audit pointers, so its records cannot be located automatically.';
      case 'failure':
        // The reason is a closed set the host chose. It never carries a path or
        // an adapter's message, so it is safe to branch on — and each branch is
        // a different thing to do next, which is why there is no shared string.
        return failureMessage(result.reason);
    }
  });

  function failureMessage(reason: 'unknown-run' | 'corpus-unreadable' | 'internal-error'): string {
    switch (reason) {
      case 'unknown-run':
        return 'No run with this identifier is on record, so its evidence could not be looked up.';
      case 'corpus-unreadable':
        return 'The audit log could not be read.';
      case 'internal-error':
        return 'Resolving this run’s audit records did not complete.';
    }
  }

  const tone = $derived(result?.outcome === 'failure' ? 'error' : 'info');
</script>

<section
  class="evidence-panel tone-{tone}"
  data-testid="history-evidence-panel"
  data-evidence-outcome={outcome}
  aria-label="Run evidence"
>
  <h3>Evidence</h3>
  <p class="message" data-testid="history-evidence-message">{message}</p>

  <!--
    FR-R3-127 (FR-004) — the retention consequence, at the Run.

    The audit of 2026-08-27 found the tiers correctly separated and then found a
    concentration: failed, paused and canceled Runs retain UNREDACTED transcripts,
    which is exactly where prompts and output are most likely to carry sensitive
    debugging context. An operator looking at such a Run should not have to open a
    settings page to learn that, or to find the way to remove it.

    Silent when the Run retains nothing raw — see `retainsRawTranscript`.
  -->
  {#if retainsRawTranscript}
    <p class="raw-retention" data-testid="history-evidence-raw-retention">
      <strong>An unredacted raw transcript is held for this run</strong> — operator prompts,
      source, and model output — for up to {retentionMaxAgeDays}
      day{retentionMaxAgeDays === 1 ? '' : 's'} or until the session-artifact byte budget evicts it.
      To remove it now, run <code>Schegent: Delete Run Evidence</code> from the Command Palette; to
      keep a copy elsewhere first, <code>Schegent: Export Run Evidence</code>.
    </p>
  {/if}

  {#if resolved}
    {#if resolved.truncated}
      <!-- T055 — a truncated read that says nothing reads as a complete one. -->
      <p class="note" data-testid="history-evidence-truncated">
        More records matched than are shown here. Open the audit log for the rest.
      </p>
    {/if}
    {#if resolved.parseWarnings > 0}
      <!-- T055 — preserved, not dropped. A warning swallowed here is a record
           the operator never learns was unreadable. -->
      <p class="note" data-testid="history-evidence-parse-warnings">
        {resolved.parseWarnings}
        {resolved.parseWarnings === 1 ? 'line was' : 'lines were'} kept with a parse warning.
      </p>
    {/if}
    {#if resolved.entries.length > 0}
      <ul class="entries">
        <!-- T055 — every entry the host returned, including one whose event
             type this build does not know. The parser warns and preserves; a
             surface that filtered to a known set would hide exactly the records
             a newer writer produced. -->
        {#each resolved.entries as entry (entry.id)}
          <li class="entry" data-testid="history-evidence-entry-{entry.id}">
            <span class="entry-time">{formatAbsoluteTime(entry.timestamp)}</span>
            <span class="entry-type">{entry.eventType}</span>
            <span class="entry-phase">{entry.phase}</span>
            <span class="entry-outcome">{entry.outcome}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .raw-retention {
    margin: 0 0 var(--schegent-space-2, 8px);
    padding: 6px 8px;
    border-left: 3px solid var(--vscode-editorWarning-foreground);
    /* Theme tokens only: FR-R3-131 baselined 30 contrast violations and this adds
       no new hard-coded colour. */
    color: var(--vscode-foreground);
    background: var(--vscode-editorWidget-background);
    font-size: 0.95em;
  }

  .evidence-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--schegent-space-3);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--schegent-surface);
  }
  .evidence-panel h3 {
    margin: 0;
    font-size: var(--schegent-text-secondary);
    font-weight: 600;
  }
  .message {
    margin: 0;
    line-height: 1.45;
    text-wrap: pretty;
  }
  /* FR-029 — a pruned pointer is not an error. Only a resolution that failed
     borrows the error colour; everything else reads as ordinary text. */
  .tone-info .message {
    color: var(--schegent-fg);
  }
  .tone-error .message {
    color: var(--schegent-error-text);
  }
  .note {
    margin: 0;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    line-height: 1.4;
  }
  .entries {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
  }
  .entry {
    display: flex;
    flex-wrap: wrap;
    gap: var(--schegent-gap);
    align-items: baseline;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
  }
  .entry-time {
    font-variant-numeric: tabular-nums;
  }
  .entry-type {
    color: var(--schegent-fg);
  }
</style>
