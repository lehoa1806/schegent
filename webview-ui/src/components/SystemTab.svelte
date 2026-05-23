<script lang="ts">
  import { snapshotStore } from '../lib/snapshot-store.svelte';
  import { formatAbsoluteTime } from '../lib/format';
  import { stripAnsi } from '../lib/ansi';
  import type { AuditCategory } from '../lib/snapshot-types';

  // Feature 064 T015 — System tab: renders entries the projector classified
  // as `scope === 'system'`. Legacy entries (pre-Feature 064, `scope ===
  // undefined`) are treated as `'task'` per FR-013 and are NOT shown here.
  //
  // Feature 068 (FR-011) — cli-invocation entries are cross-listed in the
  // System tab regardless of their underlying scope so the CLI command can
  // render per US2. See spec.md.
  //
  // Unlike AuditTail, the System tab is NEVER filtered by runId reachability
  // (FR-015).
  const entries = $derived(snapshotStore.auditTail);
  const visible = $derived(
    entries.filter((entry) => entry.scope === 'system' || entry.category === 'cli-invocation')
  );
  const reversed = $derived(visible.slice().reverse());
  const empty = $derived(visible.length === 0);

  const ICONS: Record<AuditCategory, string> = {
    'phase-transition': '→',
    'file-write': '✎',
    'cli-invocation': '$',
    error: '✕',
    warning: '!',
    system: '·'
  };

  function iconFor(category: AuditCategory | string): string {
    // Feature 068 UI-13 — unknown categories fall back to the system glyph
    // so an entry is never dropped (hard rule: never drop unknown audit
    // event types).
    return (ICONS as Record<string, string>)[category] ?? ICONS.system;
  }

  function outcomeKey(outcome: 'success' | 'error' | 'pending' | undefined): string {
    return outcome ?? 'unknown';
  }

  function outcomeAria(outcome: 'success' | 'error' | 'pending' | undefined): string {
    return outcome ?? 'no outcome';
  }
</script>

<section class="tail" aria-label="System events" data-testid="system-tab">
  <header class="title">System events</header>
  {#if empty}
    <p class="empty" data-testid="system-empty">No system events yet.</p>
  {:else}
    <ol>
      {#each reversed as entry (entry.id)}
        <li
          class="entry category-{entry.category} outcome-{outcomeKey(entry.outcome)}"
          data-testid="system-entry-{entry.id}"
          aria-label="{entry.category}, {outcomeAria(entry.outcome)}"
        >
          <div class="row meta">
            <span class="time" data-testid="system-entry-time-{entry.id}">
              {formatAbsoluteTime(entry.timestamp)}
            </span>
            <span class="category-badge" data-testid="system-entry-category-{entry.id}">
              <span class="icon" aria-hidden="true">{iconFor(entry.category)}</span>
              <span class="label">{entry.category}</span>
            </span>
            <span class="outcome-badge" data-testid="system-entry-outcome-{entry.id}">
              {entry.outcome ?? '—'}
            </span>
          </div>
          <div class="row ids">
            <span class="task" data-testid="system-entry-task-{entry.id}">
              <span class="key">task</span>
              <span class="value">{entry.taskId ?? '—'}</span>
            </span>
            <span class="phase" data-testid="system-entry-phase-{entry.id}">
              <span class="key">phase</span>
              <span class="value">{entry.phaseId ?? '—'}</span>
            </span>
          </div>
          <div class="row summary" data-testid="system-entry-summary-{entry.id}">
            {entry.summary}
          </div>
          {#if entry.category === 'cli-invocation' && entry.command}
            <pre class="cli-command" data-testid="system-entry-command-{entry.id}">{stripAnsi(entry.command)}</pre>
          {:else if entry.category === 'cli-invocation'}
            <p class="cli-command-missing" data-testid="system-entry-command-missing-{entry.id}">
              <em>(no command captured)</em>
            </p>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .tail {
    padding: var(--schegent-pad);
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .title {
    font-size: 0.8em;
    color: var(--schegent-muted-fg);
  }
  .empty {
    margin: 0;
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .entry {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 6px;
    color: var(--schegent-fg);
    font-size: 0.85em;
    border-bottom: 1px solid var(--schegent-muted-fg);
    border-left: 3px solid transparent;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: baseline;
  }
  .row.meta {
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }
  .row.ids {
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }
  .row.ids .key {
    text-transform: uppercase;
    font-size: 0.75em;
    margin-right: 3px;
    opacity: 0.7;
  }
  .row.ids .value {
    color: var(--schegent-fg);
  }
  .row.summary {
    color: var(--schegent-fg);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .category-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .category-badge .icon {
    color: var(--schegent-muted-fg);
  }
  .category-error {
    color: var(--schegent-color-error);
  }
  .category-warning {
    color: var(--schegent-color-warning);
  }
  .category-cli-invocation .icon,
  .category-file-write .icon {
    color: var(--schegent-color-active);
  }
  .outcome-success {
    border-left-color: var(--schegent-color-success, var(--schegent-color-active));
  }
  .outcome-error {
    border-left-color: var(--schegent-color-error);
  }
  .outcome-pending {
    border-left-color: var(--schegent-color-warning);
  }
  .outcome-unknown {
    border-left-color: transparent;
  }
  pre.cli-command {
    font-family: var(--schegent-mono-font, ui-monospace, SFMono-Regular, monospace);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
    max-height: 12em;
    overflow-y: auto;
    padding: 4px 6px;
    border-radius: 3px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    font-size: 0.85em;
    margin: 2px 0 0 0;
  }
  .cli-command-missing {
    margin: 2px 0 0 0;
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
</style>
