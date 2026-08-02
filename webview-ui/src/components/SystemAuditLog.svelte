<script lang="ts">
  import { formatAbsoluteTime } from '../lib/format';
  import type { AuditCategory, AuditTailEntry } from '../lib/snapshot-types';

  interface Props {
    readonly entries: readonly AuditTailEntry[];
  }

  const { entries }: Props = $props();

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

  function isKnownCategory(category: AuditCategory | string): category is AuditCategory {
    return Object.prototype.hasOwnProperty.call(ICONS, category);
  }

  function iconFor(category: AuditCategory | string): string {
    return isKnownCategory(category) ? ICONS[category] : ICONS.system;
  }

  function categoryClass(category: AuditCategory | string): string {
    return `category-${isKnownCategory(category) ? category : 'system'}`;
  }

  function outcomeKey(outcome: AuditTailEntry['outcome']): string {
    return outcome ?? 'unknown';
  }

  function outcomeAria(outcome: AuditTailEntry['outcome']): string {
    return outcome ?? 'no outcome';
  }
</script>

<section class="tail" aria-label="Audit events" data-testid="system-audit-log">
  <header class="title">Audit events</header>
  {#if empty}
    <p class="empty" data-testid="system-empty">No system events yet.</p>
  {:else}
    <ol data-testid="system-audit-list">
      {#each reversed as entry (entry.id)}
        <li
          class="entry {categoryClass(entry.category)} outcome-{outcomeKey(entry.outcome)}"
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
          {#if entry.category === 'cli-invocation'}
            <p class="cli-command-missing" data-testid="system-entry-command-missing-{entry.id}">
              <em>Invocation details are intentionally omitted.</em>
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
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 6px;
    overflow: hidden;
  }

  .title {
    color: var(--schegent-muted-fg);
    font-size: 0.8em;
  }

  .empty {
    margin: 0;
    color: var(--schegent-muted-fg);
    font-style: italic;
  }

  ol {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }

  .entry {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--schegent-border);
    color: var(--schegent-fg);
    font-size: 0.85em;
  }

  .row {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 8px;
  }

  .row.meta,
  .row.ids {
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }

  .row.ids .key {
    margin-right: 3px;
    opacity: 0.7;
    font-size: 0.75em;
    text-transform: uppercase;
  }

  .row.ids .value,
  .row.summary {
    color: var(--schegent-fg);
  }

  .row.summary {
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

  .category-error .category-badge,
  .outcome-error .outcome-badge {
    color: var(--schegent-color-error);
  }

  .category-warning .category-badge,
  .outcome-pending .outcome-badge {
    color: var(--schegent-color-warning);
  }

  .category-cli-invocation .icon,
  .category-file-write .icon {
    color: var(--schegent-color-active);
  }

  .outcome-success .outcome-badge {
    color: var(--schegent-color-completed);
  }

  .outcome-badge {
    font-weight: 600;
  }

  .cli-command-missing {
    margin: 2px 0 0;
    color: var(--schegent-muted-fg);
    font-style: italic;
  }
</style>
