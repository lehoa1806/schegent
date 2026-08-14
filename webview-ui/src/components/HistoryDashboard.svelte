<script lang="ts">
  import type { HistoryEntry } from '../lib/snapshot-types';
  import HistorySection from './HistorySection.svelte';

  interface Props {
    history: readonly HistoryEntry[];
    isPrimary: boolean;
  }

  const { history, isPrimary }: Props = $props();

  let query = $state('');
  let outcome = $state<'all' | HistoryEntry['terminalStatus']>('all');

  const visibleHistory = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    return history.filter((entry) => {
      if (outcome !== 'all' && entry.terminalStatus !== outcome) return false;
      if (needle.length === 0) return true;
      return [entry.descriptionPreview, entry.runId, entry.featureId]
        .some((value) => value.toLocaleLowerCase().includes(needle));
    });
  });
</script>

<main class="history-dashboard" data-testid="history-dashboard">
  <header class="history-header">
    <div>
      <h1>Run History</h1>
      <p>A workspace-wide ledger of completed pipeline runs and their outcomes.</p>
    </div>
    <span class="history-count" aria-label={`${visibleHistory.length} matching runs`}>
      {visibleHistory.length} {visibleHistory.length === 1 ? 'run' : 'runs'}
    </span>
  </header>

  <section class="history-ledger" aria-label="History filters and results">
    <div class="history-filters">
      <label class="search-field">
        <span class="visually-hidden">Search run history</span>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="11" cy="11" r="7"></circle>
          <path d="m20 20-3.5-3.5"></path>
        </svg>
        <input bind:value={query} type="search" placeholder="Search by run ID, feature, or description" />
      </label>
      <label class="outcome-field">
        <span>Outcome</span>
        <select bind:value={outcome}>
          <option value="all">All outcomes</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="canceled">Canceled</option>
        </select>
      </label>
    </div>

    {#if visibleHistory.length === 0 && history.length > 0}
      <div class="filtered-empty" role="status">
        <strong>No matching runs</strong>
        <span>Adjust the search or outcome filter.</span>
      </div>
    {:else}
      <HistorySection history={visibleHistory} {isPrimary} variant="ledger" />
    {/if}
  </section>
</main>

<style>
  .history-dashboard {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: var(--schegent-space-3);
    overflow-y: auto;
    padding: var(--schegent-space-4) var(--schegent-space-5) var(--schegent-space-5);
  }
  .history-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 20px;
  }
  .history-header h1 {
    margin: 0;
    font-size: var(--schegent-text-heading);
    font-weight: 650;
    letter-spacing: -0.025em;
  }
  .history-header p {
    max-width: 65ch;
    margin: 5px 0 0;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-secondary);
    line-height: 1.45;
    text-wrap: pretty;
  }
  .history-count {
    flex: 0 0 auto;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
    font-variant-numeric: tabular-nums;
  }
  .history-ledger {
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--schegent-surface);
  }
  .history-filters {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 12px;
    padding: var(--schegent-space-3);
    border-bottom: 1px solid var(--schegent-divider);
  }
  .search-field {
    position: relative;
    display: flex;
    width: min(460px, 100%);
    align-items: center;
    color: var(--schegent-muted-fg);
  }
  .search-field svg {
    position: absolute;
    left: 10px;
    pointer-events: none;
  }
  .search-field input {
    width: 100%;
    min-height: var(--schegent-control-height);
    padding: 6px 10px 6px 34px;
    border: 1px solid var(--schegent-input-border);
    border-radius: var(--schegent-radius-sm);
    background: var(--schegent-input-bg);
  }
  .outcome-field {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: 4px;
    color: var(--schegent-muted-fg);
    font-size: 0.76rem;
  }
  .outcome-field select {
    min-width: 148px;
    min-height: var(--schegent-control-height);
    padding: 5px 28px 5px 9px;
    border: 1px solid var(--schegent-input-border);
    border-radius: var(--schegent-radius-sm);
  }
  .filtered-empty {
    display: flex;
    min-height: 190px;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 5px;
    color: var(--schegent-muted-fg);
  }
  .filtered-empty strong {
    color: var(--schegent-fg);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 720px) {
    .history-dashboard {
      padding: 16px;
    }
    .history-header,
    .history-filters {
      align-items: stretch;
      flex-direction: column;
    }
    .outcome-field select {
      width: 100%;
    }
  }
</style>
