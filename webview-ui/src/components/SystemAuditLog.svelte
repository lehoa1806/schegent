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

  /** The Event column's words; a category the webview does not know shows as recorded. */
  const LABELS: Record<AuditCategory, string> = {
    'phase-transition': 'Step change',
    'file-write': 'File write',
    'cli-invocation': 'Backend call',
    error: 'Error',
    warning: 'Warning',
    system: 'System'
  };

  function isKnownCategory(category: AuditCategory | string): category is AuditCategory {
    return Object.prototype.hasOwnProperty.call(ICONS, category);
  }

  function iconFor(category: AuditCategory | string): string {
    return isKnownCategory(category) ? ICONS[category] : ICONS.system;
  }

  function labelFor(category: AuditCategory | string): string {
    return isKnownCategory(category) ? LABELS[category] : category;
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

<section aria-label="Audit events" data-testid="system-audit-log">
  <div class="table-wrap">
    <div class="ltable" class:fit={empty}>
      <div class="lhead" aria-hidden="true">
        <span>Time</span><span>Event</span><span>Task</span><span>What happened</span>
      </div>
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
              <span class="cell time mono muted" data-testid="system-entry-time-{entry.id}">{formatAbsoluteTime(entry.timestamp)}</span>
              <span class="cell">
                <span class="event" data-testid="system-entry-category-{entry.id}"><span class="glyph" aria-hidden="true">{iconFor(entry.category)}</span>{labelFor(entry.category)}</span>
                <span class="outcome" data-testid="system-entry-outcome-{entry.id}">{entry.outcome ?? '—'}</span>
              </span>
              <span class="cell">
                <span class="task mono" data-testid="system-entry-task-{entry.id}">{entry.taskId ?? '—'}</span>
                {#if entry.phaseId !== undefined}
                  <span class="line sub" data-testid="system-entry-phase-{entry.id}">{entry.phaseId}</span>
                {/if}
              </span>
              <span class="cell">
                <span class="summary" data-testid="system-entry-summary-{entry.id}">{entry.summary}</span>
                {#if entry.category === 'cli-invocation'}
                  <span class="line sub" data-testid="system-entry-command-missing-{entry.id}">Invocation details are intentionally omitted.</span>
                {/if}
              </span>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </div>
</section>

<style>
  .ltable {
    grid-template-columns: max-content max-content fit-content(16rem) minmax(0, 1fr);
  }

  .event,
  .line {
    display: block;
  }

  .glyph {
    display: inline-block;
    min-width: 1.2em;
    color: var(--schegent-muted-fg);
  }

  .task {
    overflow-wrap: anywhere;
  }

  .summary {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* The outcome sits under the event as the store records it, first letter capitalised, in the
     outcome's status colour; an entry without one shows a muted dash. */
  .outcome {
    display: block;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-secondary);
    text-transform: capitalize;
  }

  .outcome-success .outcome {
    color: var(--schegent-status-completed-text);
  }

  .outcome-error .outcome {
    color: var(--schegent-status-error-text);
  }

  .outcome-pending .outcome {
    color: var(--schegent-status-warning-text);
  }
</style>
