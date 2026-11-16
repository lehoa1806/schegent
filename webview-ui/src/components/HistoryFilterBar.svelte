<script lang="ts">
  // Feature 103 (T043, T044 — FR-016, FR-018, FR-021, FR-022, FR-054, FR-058,
  // FR-060) — the six controls, and only the six.
  //
  // The component holds no filter state of its own. It renders the set it is
  // given and hands back a whole replacement, so the surface that owns the
  // location (FR-020) stays the single place a filter can change. That also
  // keeps the version-clearing rule below in one place rather than at every
  // call site that sets a definition.
  //
  // Drawn as the redesign's toolbar: the outcome as a segmented control, and
  // every other filter as a pill. A pill is a native select laid invisibly over
  // the pill's face, so the keyboard, a screen reader and the platform's own
  // picker all meet the control the platform provides; the face only says what
  // the select holds.

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
  // 'custom' and not the range's own kind, 'absolute': the select offers no
  // option by that name, and a value it cannot find leaves it showing nothing.
  const rangeMode = $derived.by(() => {
    if (filters.range.kind === 'relative') return filters.range.window;
    return filters.range.kind === 'absolute' ? 'custom' : 'all';
  });

  const ANY_TIME_LABEL = 'Any time';
  const CUSTOM_RANGE_LABEL = 'Custom range';

  /**
   * FR-021 — a value the rows no longer carry stays in the list and says so.
   * Dropping it would change what the operator is looking at without telling
   * them; leaving it unmarked would have them read an empty list as an outage.
   */
  function optionLabel(option: HistoryFilterOption): string {
    return option.missing ? `${option.label} (no longer present)` : option.label;
  }

  /** What a pill shows for its chosen value: the option's words, or the raw value if it has none. */
  function chosenLabel(choices: readonly HistoryFilterOption[], value: string): string {
    const chosen = choices.find((option) => option.value === value);
    return chosen === undefined ? value : optionLabel(chosen);
  }

  const originLabel = $derived(
    HISTORY_ORIGIN_FILTERS.find((option) => option.value === filters.origin)?.label ?? filters.origin
  );
  const rangeLabel = $derived.by(() => {
    if (rangeMode === 'all') return ANY_TIME_LABEL;
    if (rangeMode === 'custom') return CUSTOM_RANGE_LABEL;
    return HISTORY_RELATIVE_WINDOWS.find((choice) => choice.value === rangeMode)?.label ?? rangeMode;
  });

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

<!-- Shaped for the sidebar's byte budget (SC-010). A fragment whose only element is an <svg>, with
     no literal text beside it, compiles to an SVG fragment, and that one call ships Svelte's
     fragment code in the chunk the sidebar loads first. So the block holds the icon alone, and the
     literal ": " keeps the face itself an HTML fragment. -->
{#snippet pillFace(name: string, value: string | null)}
  {#if value === null}<svg class="i" aria-hidden="true"><use href="#i-plus"></use></svg>{/if}{name}{#if value !== null}: {value}{/if}
{/snippet}

<div class="filter-bar" data-testid="history-filter-bar" role="group" aria-label="History filters">
  <!-- FR-054 — one flat set. The terminal outcomes and the non-terminal states
       come from the same vocabulary module, so "the paused one" and "the failed
       one" are the same question asked of the same control. -->
  <div class="seg" role="group" aria-label="Outcome" data-testid="history-filter-status">
    <button
      type="button"
      data-testid="history-filter-status-all"
      aria-pressed={filters.status === 'all'}
      onclick={() => set({ status: 'all' })}
    >All</button>
    {#each RUN_STATUS_FILTERS as option (option.value)}
      <button
        type="button"
        data-testid="history-filter-status-{option.value}"
        aria-pressed={filters.status === option.value}
        onclick={() => set({ status: option.value })}
      >{option.label}</button>
    {/each}
  </div>

  <!-- FR-060 — both shapes on one control: the windows an operator reaches for
       daily, and the explicit range they need to bracket a publish. -->
  <label class="filter-btn filter-pick" class:on={rangeMode !== 'all'}>
    <svg class="i" aria-hidden="true"><use href="#i-history"></use></svg>
    {rangeLabel}
    <svg class="i" aria-hidden="true"><use href="#i-chev"></use></svg>
    <select
      aria-label="Time"
      data-testid="history-filter-range"
      value={rangeMode}
      onchange={(event) => setRangeMode(event.currentTarget.value)}
    >
      <option value="all">{ANY_TIME_LABEL}</option>
      {#each HISTORY_RELATIVE_WINDOWS as window (window.value)}
        <option value={window.value}>{window.label}</option>
      {/each}
      <option value="custom">{CUSTOM_RANGE_LABEL}</option>
    </select>
  </label>

  {#if absolute !== null}
    <label class="bound">
      <span>From</span>
      <input
        class="input"
        data-testid="history-filter-from"
        type="date"
        value={absolute.from ?? ''}
        onchange={(event) => setBound('from', event.currentTarget.value)}
      />
    </label>
    <label class="bound">
      <span>To</span>
      <input
        class="input"
        data-testid="history-filter-to"
        type="date"
        value={absolute.to ?? ''}
        onchange={(event) => setBound('to', event.currentTarget.value)}
      />
    </label>
  {/if}

  <label class="filter-btn filter-pick" class:on={filters.definitionId !== null}>
    {@render pillFace(
      'Definition',
      filters.definitionId === null ? null : chosenLabel(options.definitions, filters.definitionId)
    )}
    <select
      aria-label="Definition"
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
    <label class="filter-btn filter-pick" class:on={filters.versionId !== null}>
      {@render pillFace(
        'Version',
        filters.versionId === null ? null : chosenLabel(options.versions, filters.versionId)
      )}
      <select
        aria-label="Version"
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

  <label class="filter-btn filter-pick" class:on={filters.queueId !== null}>
    {@render pillFace(
      'Queue',
      filters.queueId === null ? null : chosenLabel(options.queues, filters.queueId)
    )}
    <select
      aria-label="Queue"
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

  <label class="filter-btn filter-pick" class:on={filters.origin !== 'all'}>
    {@render pillFace('Kind', filters.origin === 'all' ? null : originLabel)}
    <select
      aria-label="Kind"
      data-testid="history-filter-origin"
      value={filters.origin}
      onchange={(event) => set({ origin: event.currentTarget.value as HistoryOriginFilter })}
    >
      {#each HISTORY_ORIGIN_FILTERS as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  </label>

  {#if anyActive}
    <!-- FR-022 — the way out, offered wherever filters are set rather than only
         from the empty state, so narrowing to nothing is not the only route
         back to the whole list. -->
    <button
      class="linkbtn clear-filters"
      type="button"
      data-testid="history-filter-clear"
      onclick={() => onChange(EMPTY_HISTORY_FILTERS)}
    >Clear filters</button>
  {/if}
</div>

<style>
  /* The bar draws no box. Its controls are laid out by the page's toolbar, beside the
     search, and each one wraps on its own, as in the redesign. The element stays for its
     group role and name. */
  .filter-bar {
    display: contents;
  }

  /* Too narrow for the outcome group in one row, which takes about 29em: the group becomes a
     grid of equal cells. It runs three across while a cell still holds the longest label
     ("Completed", about 7em with its padding), then two, then one. A label that still does
     not fit wraps inside its cell instead of spilling into the next one. Each cell's 1px
     ring paints the 1px gap beside it, and the group's own border and clip hide the rings
     at its edge. The query container is the toolbar in HistoryDashboard.svelte.
     `.filter-bar` leads each selector so it outranks the sheet's `.sg .seg button + button`:
     Svelte scopes every part after the first with `:where()`, which adds nothing. */
  @container history-toolbar (max-width: 30em) {
    .filter-bar .seg {
      display: grid;
      flex: 1 1 100%;
      grid-template-columns: repeat(auto-fit, minmax(max(7em, 30%), 1fr));
      gap: 1px;
    }
    .filter-bar .seg button {
      border-left: 0;
      white-space: normal;
      box-shadow: 0 0 0 1px var(--schegent-border);
    }
    .filter-bar .seg button[aria-pressed='true'] {
      box-shadow:
        0 0 0 1px var(--schegent-border),
        inset 0 0 0 1px var(--schegent-selection-outline);
    }
  }
  /* The select covers the whole pill and is transparent, so a press anywhere on
     the pill opens the platform's own picker, anchored where the pill is. */
  .filter-pick {
    position: relative;
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
  }
  .filter-pick select {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-height: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  /* The select is the focused element, and it cannot be seen, so the pill
     carries its ring. */
  .filter-pick:has(> select:focus-visible) {
    outline: 2px solid var(--schegent-focus-border);
    outline-offset: 2px;
  }
  .bound {
    display: inline-flex;
    align-items: center;
    gap: var(--schegent-space-1-5);
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-secondary);
  }
  .bound .input {
    width: auto;
    height: var(--schegent-control-height-compact);
  }
  .clear-filters {
    font-size: var(--schegent-text-secondary);
  }

  /* A touch or pen target of 44px, as every other control gets from the theme.
     The theme raises the select itself; the pill grows with it, so the select
     never hangs below the face it is laid over. */
  @media (pointer: coarse) {
    /* Two classes, to outrank the sheet's fixed pill height. */
    .filter-bar .filter-pick {
      height: auto;
      min-height: 44px;
    }
    .bound .input {
      height: auto;
    }
  }
</style>
