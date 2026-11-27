<script lang="ts">
  // Feature 020 T035 — single phase-log entry row. Renders the time of
  // day, the kind as a word, body (kind-dependent), truncation indicator,
  // and error-flag visual for `tool-result` with `isError === true`.
  //
  // Body strings have been sanitized by the host before crossing the
  // IPC boundary; the component renders them as text only (no `{@html}`,
  // no HTML decoding). Numeric and boolean fields are rendered verbatim.

  import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';
  import ToolCallCard from './parts/ToolCallCard.svelte';
  import AuditCompletionCard from './parts/AuditCompletionCard.svelte';
  import { detectAuditFooter } from '../../lib/activity-feed/detect-audit-footer';
  import type { AuditFooterDetection } from '../../lib/activity-feed/types';
  import {
    coverageGapFigure,
    coverageGapLabel,
    coverageGapReason
  } from '../../lib/activity-feed/coverage-gap-label';
  import { formatTimeOfDay } from '../../lib/format-time-of-day';

  interface Props {
    readonly entry: PhaseLogDisplayEntry;
  }

  let { entry }: Props = $props();

  // The redesign's log names each line's kind in a word ("tool"); the
  // kinds it does not draw take the nearest word, and the log's own notices
  // (hidden head, ended tail, coverage gap) read "note".
  const KIND_LABELS: Record<PhaseLogDisplayEntry['kind'], string> = {
    'assistant-text': 'assistant',
    'tool-use': 'tool',
    'tool-result': 'output',
    system: 'system',
    result: 'result',
    'truncated-head': 'note',
    'tail-ended': 'note',
    'coverage-gap': 'note'
  };

  // The local time of day, as the redesign's log reads; the full stamp stays
  // in `datetime` and the tooltip, and one that does not parse shows as it came.
  const timeLabel = $derived(entry.ts ? formatTimeOfDay(entry.ts, { seconds: true }) || entry.ts : '');

  const isError = $derived(entry.kind === 'tool-result' && entry.body.isError === true);

  const truncated = $derived(entry.bodyTruncated);

  function truncationBytes(
    t: PhaseLogDisplayEntry['bodyTruncated']
  ): number | null {
    if (t === null || t === undefined) return null;
    // Sum every field's `originalLength`; UI shows the largest single
    // dropped value for brevity (matches spec example "5000 bytes").
    let max = 0;
    for (const v of Object.values(t)) {
      if (v && typeof v.originalLength === 'number' && v.originalLength > max) {
        max = v.originalLength;
      }
    }
    return max > 0 ? max : null;
  }

  const truncatedMax = $derived(truncationBytes(truncated));

  // FR-R6-F07 T036 (FR-012) — a coverage gap shows a label for its reason and
  // its figures as numbers; a record count of one is implied by the row.
  const gapReason = $derived(coverageGapReason(entry.body.reason));
  const gapLabel = $derived(coverageGapLabel(entry.body.reason));
  const gapCount = $derived.by<number | null>(() => {
    const count = coverageGapFigure(entry.body.count);
    return count !== null && count > 1 ? count : null;
  });
  const gapBytes = $derived(coverageGapFigure(entry.body.bytes));

  // Feature 029 T031 — detect the SCHEGENT AUDIT LOG footer in
  // assistant-text bodies and render the matched block via
  // AuditCompletionCard so the operator gets a colored status badge.
  // The detector is pure and operates on already-sanitized strings.
  const auditFooter = $derived.by<AuditFooterDetection>(() => {
    if (entry.kind !== 'assistant-text') return { matched: false };
    const text = entry.body.text;
    if (typeof text !== 'string' || text.length === 0) return { matched: false };
    return detectAuditFooter(text);
  });
</script>

<li
  class="entry kind-{entry.kind}"
  data-testid="phase-log-entry"
  data-kind={entry.kind}
  data-is-error={isError ? 'true' : 'false'}
>
  {#if entry.ts}
    <time class="ts" datetime={entry.ts} title={entry.ts}>{timeLabel}</time>
  {/if}
  <span class="kind">{KIND_LABELS[entry.kind]}</span>
  <div class="body">
    {#if entry.kind === 'assistant-text'}
      {#if auditFooter.matched}
        {#if auditFooter.prefixText.length > 0}
          <span class="text">{auditFooter.prefixText}</span>
        {/if}
        <AuditCompletionCard match={auditFooter} />
        {#if auditFooter.suffixText.length > 0}
          <span class="text">{auditFooter.suffixText}</span>
        {/if}
      {:else}
        <span class="text">{entry.body.text ?? ''}</span>
      {/if}
    {:else if entry.kind === 'tool-use'}
      <ToolCallCard {entry} />
    {:else if entry.kind === 'tool-result'}
      <span class="tool-result" class:error={isError}>
        {entry.body.toolResult ?? ''}
      </span>
    {:else if entry.kind === 'system'}
      <span class="system-summary">{entry.body.systemSummary ?? entry.body.systemSubtype ?? ''}</span>
    {:else if entry.kind === 'result'}
      <span class="result-summary">{entry.body.resultSummary ?? ''}</span>
    {:else if entry.kind === 'truncated-head'}
      <span class="dropped">
        {entry.body.droppedEntryCount ?? 0} earlier entries hidden (head-truncated)
      </span>
    {:else if entry.kind === 'tail-ended'}
      <span class="tail-ended">Tail ended ({entry.body.reason ?? 'unknown'})</span>
    {:else if entry.kind === 'coverage-gap'}
      <span class="coverage-gap" data-testid="phase-log-coverage-gap" data-reason={gapReason}>
        <span class="coverage-label">{gapLabel}</span>
        {#if gapCount !== null}
          <span class="coverage-figure" data-testid="coverage-gap-count">· {gapCount} records</span>
        {/if}
        {#if gapBytes !== null}
          <span class="coverage-figure" data-testid="coverage-gap-bytes">· {gapBytes} bytes</span>
        {/if}
      </span>
    {/if}
    {#if truncatedMax !== null}
      <span class="truncation" data-testid="phase-log-entry-truncation">
        truncated · original {truncatedMax} bytes
      </span>
    {/if}
  </div>
</li>

<style>
  /* One line of the redesign's log (`.log` in its run page): time, kind and
     text in three columns, every other line tinted. The columns are placed,
     so a line without a stamp keeps its kind and text where they belong.
     The redesign's 70px and 74px columns, in characters so they follow the
     editor font. */
  .entry {
    display: grid;
    grid-template-columns: 9.75ch 10.25ch minmax(0, 1fr);
    gap: var(--schegent-space-2);
    padding: 3px var(--schegent-space-2-5);
    align-items: baseline;
  }
  .entry:nth-child(odd) {
    background: color-mix(in srgb, var(--schegent-list-hover) 50%, transparent);
  }
  .ts,
  .kind {
    grid-row: 1;
    color: var(--schegent-muted-fg);
    white-space: nowrap;
  }
  /* A stamp that does not parse shows as sent, cut to the column; the title holds it whole. */
  .ts {
    grid-column: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .kind {
    grid-column: 2;
  }
  .body {
    grid-row: 1;
    grid-column: 3;
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-0-5);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .tool-result {
    white-space: pre-wrap;
  }
  .tool-result.error {
    color: var(--schegent-error-text);
  }
  .truncation {
    font-size: var(--schegent-text-caption);
    color: var(--schegent-muted-fg);
  }
  .dropped,
  .tail-ended,
  .coverage-gap {
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
</style>
