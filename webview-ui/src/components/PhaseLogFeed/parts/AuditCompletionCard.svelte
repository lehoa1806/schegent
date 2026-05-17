<script lang="ts">
  // Feature 029 T029 — visual highlight for a detected SCHEGENT AUDIT
  // LOG footer block. Pairs the parsed status (CLEAR / FAILED / UNKNOWN)
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
    FAILED: 'FAILED',
    UNKNOWN: 'UNKNOWN'
  };
</script>

<article
  class="audit-completion-card"
  data-testid="audit-completion-card"
  data-status={match.status}
>
  <header class="header">
    <span class="label">Schegent audit log</span>
    <span class="badge" data-badge={match.status}>{STATUS_LABEL[match.status]}</span>
  </header>
  <div class="body">
    <MultiLineCodeBlock text={match.blockText} />
  </div>
</article>

<style>
  .audit-completion-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    border: 1px solid var(--schegent-border, var(--vscode-panel-border, transparent));
    border-left-width: 4px;
    border-radius: 3px;
    padding: 0.375rem 0.5rem;
    margin: 0.25rem 0;
    background: var(--vscode-editorWidget-background, transparent);
  }
  .audit-completion-card[data-status='CLEAR'] {
    border-left-color: var(--vscode-testing-iconPassed, transparent);
  }
  .audit-completion-card[data-status='FAILED'] {
    border-left-color: var(--vscode-testing-iconFailed, transparent);
  }
  .audit-completion-card[data-status='UNKNOWN'] {
    border-left-color: var(--vscode-testing-iconQueued, transparent);
  }
  .header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
  }
  .label {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 0.0625rem 0.375rem;
    border-radius: 999px;
    font-weight: 600;
    font-size: 0.7rem;
    letter-spacing: 0.04em;
    line-height: 1.4;
  }
  .badge[data-badge='CLEAR'] {
    background: var(--vscode-testing-iconPassed, transparent);
    color: var(--vscode-editor-background, transparent);
  }
  .badge[data-badge='FAILED'] {
    background: var(--vscode-testing-iconFailed, transparent);
    color: var(--vscode-editor-background, transparent);
  }
  .badge[data-badge='UNKNOWN'] {
    background: var(--vscode-testing-iconQueued, transparent);
    color: var(--vscode-editor-background, transparent);
  }
  .body {
    margin: 0;
  }
</style>
