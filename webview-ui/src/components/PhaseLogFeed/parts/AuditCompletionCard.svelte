<script lang="ts">
  // Feature 029 T029 — visual highlight for a detected SCHEGENT AUDIT
  // LOG footer block. Pairs the parsed status (CLEAR / UNKNOWN)
  // with a colored badge and renders the block body inside the shared
  // MultiLineCodeBlock so newlines render correctly. Pure renderer —
  // the host has already sanitized the block bytes at the IPC boundary
  // (single-sanitization-point invariant).

  import type { AuditFooterMatch } from '../../../lib/activity-feed/types';
  import MultiLineCodeBlock from './MultiLineCodeBlock.svelte';

  interface Props {
    readonly match: AuditFooterMatch;
  }

  let { match }: Props = $props();

  const STATUS_LABEL: Record<AuditFooterMatch['status'], string> = {
    CLEAR: 'CLEAR',
    UNKNOWN: 'UNKNOWN'
  };

  // The redesign's status chip colours: done for a clear log, warning for one whose status
  // could not be read.
  const STATUS_CHIP: Record<AuditFooterMatch['status'], string> = {
    CLEAR: 's-ok',
    UNKNOWN: 's-warn'
  };
</script>

<!-- A framed block in the log's body column, its frame tinted by the status: a caption line naming
     the audit log with the redesign's status chip, then the block itself. -->
<article
  class="audit-completion-card"
  data-testid="audit-completion-card"
  data-status={match.status}
>
  <header class="header">
    <span class="label">Schegent audit log</span>
    <span class="chip {STATUS_CHIP[match.status]}" data-badge={match.status}
      ><span class="dot" aria-hidden="true"></span>{STATUS_LABEL[match.status]}</span
    >
  </header>
  <div class="body">
    <MultiLineCodeBlock text={match.blockText} />
  </div>
</article>

<style>
  .audit-completion-card {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-space-1-5);
    margin: var(--schegent-space-1) 0;
    padding: var(--schegent-space-1-5) var(--schegent-space-2);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius-sm);
    background: var(--schegent-surface);
  }
  .audit-completion-card[data-status='CLEAR'] {
    border-color: color-mix(in srgb, var(--schegent-color-completed) 55%, var(--schegent-border));
  }
  .audit-completion-card[data-status='UNKNOWN'] {
    border-color: color-mix(in srgb, var(--schegent-color-warning) 55%, var(--schegent-border));
  }
  .header {
    display: flex;
    align-items: center;
    gap: var(--schegent-space-2);
  }
  /* The redesign's small section label. */
  .label {
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
</style>
