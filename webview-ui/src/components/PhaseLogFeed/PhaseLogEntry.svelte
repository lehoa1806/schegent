<script lang="ts">
  // Feature 020 T035 — single phase-log entry row. Renders the kind
  // icon, body (kind-dependent), timestamp, truncation indicator, and
  // error-flag visual for `tool-result` with `isError === true`.
  //
  // Body strings have been sanitized by the host before crossing the
  // IPC boundary; the component renders them as text only (no `{@html}`,
  // no HTML decoding). Numeric and boolean fields are rendered verbatim.

  import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';
  import ToolCallCard from './parts/ToolCallCard.svelte';
  import AuditCompletionCard from './parts/AuditCompletionCard.svelte';
  import { detectAuditFooter } from '../../lib/activity-feed/detect-audit-footer';
  import type { AuditFooterDetection } from '../../lib/activity-feed/types';

  interface Props {
    readonly entry: PhaseLogDisplayEntry;
  }

  let { entry }: Props = $props();

  const ICONS: Record<PhaseLogDisplayEntry['kind'], string> = {
    'assistant-text': '✎',
    'tool-use': '▶',
    'tool-result': '✓',
    system: '·',
    result: '◆',
    'truncated-head': '…',
    'tail-ended': '⏹'
  };

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
  <span class="icon" aria-hidden="true">{ICONS[entry.kind]}</span>
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
    {/if}
    {#if truncatedMax !== null}
      <span class="truncation" data-testid="phase-log-entry-truncation">
        truncated · original {truncatedMax} bytes
      </span>
    {/if}
  </div>
  {#if entry.ts}
    <time class="ts" datetime={entry.ts}>{entry.ts}</time>
  {/if}
</li>

<style>
  .entry {
    display: grid;
    grid-template-columns: 1.25rem 1fr auto;
    gap: 0.5rem;
    padding: 0.3rem 0.5rem;
    border-bottom: 1px solid var(--schegent-border, transparent);
    font-size: var(--schegent-text-secondary);
    align-items: start;
  }
  .icon {
    opacity: 0.7;
    text-align: center;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    word-break: break-word;
  }
  .ts {
    color: var(--schegent-muted-fg);
    font-family: var(--schegent-mono-font);
    font-size: var(--schegent-text-caption);
    opacity: 0.8;
    white-space: nowrap;
  }
  .tool-name {
    font-weight: 600;
  }
  .tool-input,
  .tool-result {
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: pre-wrap;
  }
  .tool-result.error {
    color: var(--schegent-error-text);
  }
  .truncation {
    font-size: 0.7rem;
    opacity: 0.6;
    font-style: italic;
  }
  .dropped {
    font-style: italic;
    opacity: 0.7;
  }
</style>
