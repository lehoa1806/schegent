<script lang="ts">
  import {
    RUNNER_DEFAULT_MODEL,
    type WakeUpLogProjection
  } from '../../../lib/snapshot-types';
  import WakeupSessionLogPanel from './WakeupSessionLogPanel.svelte';

  interface Props {
    wakeUpLog: WakeUpLogProjection;
  }

  const { wakeUpLog }: Props = $props();

  let expandedCorrelationId = $state<string | null>(null);

  function toggleExpansion(correlationId: string): void {
    expandedCorrelationId = expandedCorrelationId === correlationId ? null : correlationId;
  }

  function formatAttemptTime(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  function formatDuration(ms: number | null): string {
    if (ms === null) return '';
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
  }
</script>

<section class="log-section" data-testid="wakeup-log-section">
  <header class="log-header">
    <h3>Recent attempts</h3>
    {#if wakeUpLog.readError}
      <span class="status-text status-rejected" data-testid="wakeup-log-error">{wakeUpLog.readError}</span>
    {/if}
  </header>

  {#if wakeUpLog.entries.length === 0}
    <div class="empty-log" data-testid="wakeup-log-empty">No wake-up attempts recorded.</div>
  {:else}
    <div class="log-list" data-testid="wakeup-log-list">
      {#each wakeUpLog.entries as entry (entry.id)}
        {@const actual = entry.actualModel ?? RUNNER_DEFAULT_MODEL}
        {@const requested = entry.requestedModel ?? RUNNER_DEFAULT_MODEL}
        {@const fellBack = actual === RUNNER_DEFAULT_MODEL && requested !== RUNNER_DEFAULT_MODEL}
        {@const cid = entry.correlationId ?? null}
        {@const isExpanded = cid !== null && expandedCorrelationId === cid}
        <article class="log-row" data-testid="wakeup-log-row">
          <div class="log-row-top">
            <span class="status-pill status-{entry.status}">{entry.status}</span>
            <span class="source-label">{entry.triggerSource}</span>
            <time datetime={entry.timestamp}>{formatAttemptTime(entry.timestamp)}</time>
            {#if entry.durationMs !== null}
              <span class="duration">{formatDuration(entry.durationMs)}</span>
            {/if}
            <span class="model-label" data-testid="wakeup-log-model">
              {actual}
              {#if fellBack}
                <span
                  class="model-fallback-note"
                  data-testid="wakeup-log-model-fallback"
                  title={`Operator requested ${requested}; runner fell back to ${actual}.`}
                >{`(was: ${requested})`}</span>
              {/if}
            </span>
            {#if cid !== null}
              <button
                type="button"
                class="expand-toggle"
                data-testid="wakeup-log-expand-toggle"
                aria-expanded={isExpanded}
                onclick={() => toggleExpansion(cid)}
              >{isExpanded ? 'Hide session log' : 'View session log'}</button>
            {:else}
              <span
                class="no-session-log"
                data-testid="wakeup-log-no-session-log"
              >{'(no session log available)'}</span>
            {/if}
          </div>
          <pre class="raw-response" data-testid="wakeup-log-response">{entry.rawResponse || entry.message}</pre>
          {#if isExpanded && cid !== null}
            <WakeupSessionLogPanel correlationId={cid} />
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .log-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
    border-top: 1px solid var(--sch-glass-border);
  }
  .log-header,
  .log-row-top {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .log-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .log-row {
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    padding: 10px;
  }
  .status-pill {
    font-size: 0.78em;
    text-transform: uppercase;
  }
  .model-label {
    font-size: 0.82em;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--schegent-muted-fg);
  }
  .model-fallback-note {
    font-style: italic;
    color: var(--vscode-editorWarning-foreground, var(--schegent-muted-fg));
    margin-left: 4px;
  }
  .status-succeeded { color: var(--vscode-charts-green); }
  .status-failed,
  .status-timed-out { color: var(--schegent-error-text); }
  .status-skipped { color: var(--vscode-editorWarning-foreground, var(--schegent-muted-fg)); }
  .status-text { font-size: 0.9em; }
  .status-rejected { color: var(--schegent-error-text); }
  .raw-response {
    margin: 8px 0 0 0;
    max-height: 120px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.82em;
  }
</style>
