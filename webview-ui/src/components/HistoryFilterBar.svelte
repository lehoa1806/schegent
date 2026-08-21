<script lang="ts">
  // Feature 103 (T043, T044 — FR-016, FR-018, FR-021, FR-022, FR-054, FR-058,
  // FR-060) — the six controls, and only the six.
  //
  // The component holds no filter state of its own. It renders the set it is
  // given and hands back a whole replacement, so the surface that owns the
  // location (FR-020) stays the single place a filter can change. That also
  // keeps the version-clearing rule below in one place rather than at every
  // call site that sets a definition.

  import { RUN_STATUS_FILTERS } from '../lib/format';
  import {
    ALL_TIME,
    EMPTY_HISTORY_FILTERS,
    HISTORY_ORIGIN_FILTERS,
    HISTORY_RELATIVE_WINDOWS,
    isFiltered,
    type HistoryFilterOption,
    type HistoryFilterOptions,
    type HistoryFilterSet,
    type HistoryOriginFilter,
    type HistoryRelativeWindow
  } from '../lib/history-filters';

  interface Props {
    filters: HistoryFilterSet;
    options: HistoryFilterOptions;
    onChange: (next: HistoryFilterSet) => void;
  }

  const { filters, options, onChange }: Props = $props();

  const anyActive = $derived(isFiltered(filters));
  const absolute = $derived(filters.range.kind === 'absolute' ? filters.range : null);
  // The mode a single control carries: 'all', one relative window, or 'custom'.
  const rangeMode = $derived(
    filters.range.kind === 'relative' ? filters.range.window : filters.range.kind
  );

  /**
   * FR-021 — a value the rows no longer carry stays in the list and says so.
   * Dropping it would change what the operator is looking at without telling
   * them; leaving it unmarked would have them read an empty list as an outage.
   */
  function optionLabel(option: HistoryFilterOption): string {
    return option.missing ? `${option.label} (no longer present)` : option.label;
  }

  /** `''` is the "no value" option every select carries; the set stores `null`. */
  function orNull(value: string): string | null {
    return value === '' ? null : value;
  }

  function set(patch: Partial<HistoryFilterSet>): void {
    onChange({ ...filters, ...patch });
  }

  function setDefinition(value: string): void {
    // FR-018 — a version label means something only inside its definition, so a
    // version selected under the old one cannot survive the change.
    set({ definitionId: orNull(value), versionId: null });
  }

  function setRangeMode(mode: string): void {
    if (mode === 'all') return set({ range: ALL_TIME });
    if (mode === 'custom') return set({ range: { kind: 'absolute', from: null, to: null } });
    set({ range: { kind: 'relative', window: mode as HistoryRelativeWindow } });
  }

  function setBound(edge: 'from' | 'to', value: string): void {
    const current = absolute ?? { kind: 'absolute' as const, from: null, to: null };
    set({ range: { ...current, [edge]: value === '' ? null : value } });
  }
</script>

<div class="filter-bar" data-testid="history-filter-bar" role="group" aria-label="History filters">
  <label class="filter-field">
    <span>Kind</span>
    <select
      data-testid="history-filter-origin"
      value={filters.origin}
      onchange={(event) => set({ origin: event.currentTarget.value as HistoryOriginFilter })}
    >
      {#each HISTORY_ORIGIN_FILTERS as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  </label>

  <label class="filter-field">
    <span>Definition</span>
    <select
      data-testid="history-filter-definition"
      value={filters.definitionId ?? ''}
      onchange={(event) => setDefinition(event.currentTarget.value)}
    >
      <option value="">All definitions</option>
      {#each options.definitions as option (option.value)}
        <option value={option.value}>{optionLabel(option)}</option>
      {/each}
    </select>
  </label>

  <!-- FR-018 — no definition selected, no version control. Offering one across
       definitions would list the same label twice and mean two things by it. -->
  {#if filters.definitionId !== null}
    <label class="filter-field">
      <span>Version</span>
      <select
        data-testid="history-filter-version"
        value={filters.versionId ?? ''}
        onchange={(event) => set({ versionId: orNull(event.currentTarget.value) })}
      >
        <option value="">All versions</option>
        {#each options.versions as option (option.value)}
          <option value={option.value}>{optionLabel(option)}</option>
        {/each}
      </select>
    </label>
  {/if}

  <label class="filter-field">
    <span>Outcome</span>
    <select
      data-testid="history-filter-status"
      value={filters.status}
      onchange={(event) => set({ status: event.currentTarget.value as HistoryFilterSet['status'] })}
    >
      <!-- FR-054 — one flat set. The terminal outcomes and the non-terminal
           states come from the same vocabulary module, so "the paused one" and
           "the failed one" are the same question asked of the same control. -->
      <option value="all">All outcomes</option>
      {#each RUN_STATUS_FILTERS as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  </label>

  <label class="filter-field">
    <span>Queue</span>
    <select
      data-testid="history-filter-queue"
      value={filters.queueId ?? ''}
      onchange={(event) => set({ queueId: orNull(event.currentTarget.value) })}
    >
      <!-- FR-058 — the unattributed partition arrives as an ordinary option,
           because a bounded render makes those runs unreachable otherwise. -->
      <option value="">All queues</option>
      {#each options.queues as option (option.value)}
        <option value={option.value}>{optionLabel(option)}</option>
      {/each}
    </select>
  </label>

  <label class="filter-field">
    <span>Time</span>
    <select
      data-testid="history-filter-range"
      value={rangeMode}
      onchange={(event) => setRangeMode(event.currentTarget.value)}
    >
      <!-- FR-060 — both shapes on one control: the windows an operator reaches
           for daily, and the explicit range they need to bracket a publish. -->
      <option value="all">Any time</option>
      {#each HISTORY_RELATIVE_WINDOWS as window (window.value)}
        <option value={window.value}>{window.label}</option>
      {/each}
      <option value="custom">Custom range</option>
    </select>
  </label>

  {#if absolute !== null}
    <label class="filter-field">
      <span>From</span>
      <input
        data-testid="history-filter-from"
        type="date"
        value={absolute.from ?? ''}
        onchange={(event) => setBound('from', event.currentTarget.value)}
      />
    </label>
    <label class="filter-field">
      <span>To</span>
      <input
        data-testid="history-filter-to"
        type="date"
        value={absolute.to ?? ''}
        onchange={(event) => setBound('to', event.currentTarget.value)}
      />
    </label>
  {/if}

  {#if anyActive}
    <!-- FR-022 — the way out, offered wherever filters are set rather than only
         from the empty state, so narrowing to nothing is not the only route
         back to the whole list. -->
    <button
      class="clear-filters"
      type="button"
      data-testid="history-filter-clear"
      onclick={() => onChange(EMPTY_HISTORY_FILTERS)}
    >
      Clear filters
    </button>
  {/if}
</div>

<style>
  .filter-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 10px;
  }
  .filter-field {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    gap: 4px;
    color: var(--schegent-muted-fg);
    font-size: 0.76rem;
  }
  .filter-field select,
  .filter-field input {
    min-width: 132px;
    min-height: var(--schegent-control-height);
    padding: 5px 9px;
    border: 1px solid var(--schegent-input-border);
    border-radius: var(--schegent-radius-sm);
    background: var(--schegent-input-bg);
    color: var(--schegent-fg);
  }
  .filter-field select {
    padding-right: 28px;
  }
  .clear-filters {
    min-height: var(--schegent-control-height);
    padding: 5px 12px;
    border: 1px solid var(--schegent-input-border);
    border-radius: var(--schegent-radius-sm);
    background: transparent;
    color: var(--schegent-fg);
    cursor: pointer;
    font-size: 0.76rem;
  }
  .clear-filters:hover {
    background: var(--schegent-hover-bg);
  }

  @media (max-width: 720px) {
    .filter-field {
      flex: 1 1 100%;
    }
    .filter-field select,
    .filter-field input {
      width: 100%;
    }
  }
</style>
