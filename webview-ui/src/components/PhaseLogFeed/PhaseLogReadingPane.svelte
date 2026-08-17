<script lang="ts">
  // Feature 020 T038 + T052 — entry list rendering pane. Owns the
  // scroll container, loading state, LIVE indicator, and the
  // auto-scroll-suppression heuristic with the "↓ N new entries"
  // affordance.
  //
  // Auto-scroll contract (T052):
  //   - Sticky-at-bottom heuristic: `scrollTop + clientHeight ≥
  //     scrollHeight - 16`. When sticky, new entries auto-scroll the
  //     list to the bottom on every rerender.
  //   - When the user scrolls up past the threshold, the pane
  //     "remembers" the user is not at the bottom; new entries arriving
  //     via rerender DO NOT cause auto-scroll. Instead, a clickable
  //     "↓ N new entries" affordance appears (testid:
  //     `phase-log-new-entries`). Clicking it scrolls to the bottom and
  //     dismisses the affordance.
  //
  // Truncation banner: when the host capped the iteration's entries
  // (entries.length === MAX_ENTRIES === 500) the head was dropped; the
  // synthetic `truncated-head` entry already carries the dropped
  // count, so this component does NOT render a secondary banner.

  import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';
  import PhaseLogEntry from './PhaseLogEntry.svelte';
  import MetadataStrip from './parts/MetadataStrip.svelte';
  import { detectMetadataLinesFromSummary } from '../../lib/activity-feed/detect-metadata-line';
  import type { MetadataLine } from '../../lib/activity-feed/types';

  interface Props {
    readonly entries: readonly PhaseLogDisplayEntry[];
    readonly loading: boolean;
    readonly skippedLines: number;
    readonly truncatedCount: number;
    readonly isLive?: boolean;
  }

  let {
    entries,
    loading,
    skippedLines,
    truncatedCount,
    isLive = false
  }: Props = $props();

  // Feature 029 T030 — aggregate metadata key=value tokens from
  // sanitized `system` / `result` entry summaries into a typed
  // MetadataLine[]. Latest-value-wins dedup is performed inside the
  // MetadataStrip component. The strip renders nothing when the array
  // is empty, so entries with no metadata cause no DOM addition.
  const metadataLines = $derived.by<readonly MetadataLine[]>(() => {
    const out: MetadataLine[] = [];
    for (const e of entries) {
      if (e.kind === 'system' && typeof e.body.systemSummary === 'string') {
        for (const line of detectMetadataLinesFromSummary(e.body.systemSummary)) {
          out.push(line);
        }
      } else if (e.kind === 'result' && typeof e.body.resultSummary === 'string') {
        for (const line of detectMetadataLinesFromSummary(e.body.resultSummary)) {
          out.push(line);
        }
      }
    }
    return out;
  });

  // Threshold in pixels for the sticky-at-bottom heuristic. Matches
  // the T052 contract: `scrollTop + clientHeight ≥ scrollHeight - 16`.
  const STICKY_THRESHOLD_PX = 16;

  let listEl = $state<HTMLElement | null>(null);
  let stickyAtBottom = $state(true);
  // Snapshot of `entries.length` taken at the moment the user
  // scrolled away from the bottom. Any new entries beyond this count
  // contribute to the "↓ N new entries" affordance label.
  let baselineCount = $state(0);
  // Reactive count of entries delivered since the user left the
  // bottom. Cleared when the user returns to the bottom (manually or
  // via the affordance click).
  let newEntryCount = $state(0);

  function isSticky(el: HTMLElement): boolean {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - STICKY_THRESHOLD_PX;
  }

  function handleScroll(event: Event): void {
    const el = event.currentTarget as HTMLElement;
    const next = isSticky(el);
    if (next && !stickyAtBottom) {
      // User returned to the bottom — clear the affordance state.
      newEntryCount = 0;
    }
    if (!next && stickyAtBottom) {
      // User just scrolled up off the bottom — snapshot the current
      // entry count so subsequent rerenders compute a stable delta.
      baselineCount = entries.length;
    }
    stickyAtBottom = next;
  }

  function scrollToBottom(): void {
    const el = listEl;
    if (el === null) return;
    // jsdom marks scrollTop read-only on some element prototypes; the
    // affordance behavior is purely visual so swallow the assignment
    // error rather than crashing the component lifecycle.
    try {
      el.scrollTop = el.scrollHeight;
    } catch {
      /* jsdom test environment — non-fatal */
    }
    stickyAtBottom = true;
    newEntryCount = 0;
  }

  // Auto-scroll on rerender when sticky. Tracks `entries` so it
  // re-runs whenever the list grows. When NOT sticky, recompute the
  // "↓ N new entries" delta from the captured baseline.
  $effect(() => {
    const len = entries.length;
    const el = listEl;
    if (el === null) return;
    if (stickyAtBottom) {
      // Defer to after the DOM updates so scrollHeight reflects new
      // rows.
      queueMicrotask(() => {
        if (listEl === null) return;
        try {
          listEl.scrollTop = listEl.scrollHeight;
        } catch {
          /* jsdom test environment — non-fatal */
        }
      });
      // Keep the baseline up-to-date while at the bottom so a future
      // upward-scroll snapshot is correct.
      baselineCount = len;
    } else {
      const delta = Math.max(0, len - baselineCount);
      newEntryCount = delta;
    }
  });
</script>

<section class="pane" data-testid="phase-log-reading-pane">
  <header class="pane-header">
    {#if isLive}
      <span class="live-indicator" data-testid="phase-log-live-indicator" aria-live="polite">
        ● LIVE
      </span>
    {/if}
    {#if skippedLines > 0}
      <span class="warning" data-testid="phase-log-skipped">
        {skippedLines} malformed line{skippedLines === 1 ? '' : 's'} skipped
      </span>
    {/if}
    {#if truncatedCount > 0}
      <span class="warning" data-testid="phase-log-truncated-count">
        {truncatedCount} entries truncated
      </span>
    {/if}
  </header>
  <MetadataStrip lines={metadataLines} />
  {#if loading}
    <p class="loading" data-testid="phase-log-loading">Loading…</p>
  {:else if entries.length === 0}
    <!-- Empty-state cards are rendered by the parent feed (see
         PhaseLogEmptyStates.svelte). This pane shows nothing when
         entries are empty so the empty-state guidance can sit in its
         place. -->
    <div
      bind:this={listEl}
      class="entries"
      data-testid="phase-log-entry-list"
      onscroll={handleScroll}
    ></div>
  {:else}
    <ol
      bind:this={listEl}
      class="entries"
      data-testid="phase-log-entry-list"
      onscroll={handleScroll}
    >
      {#each entries as e (e.seq)}
        <PhaseLogEntry entry={e} />
      {/each}
    </ol>
  {/if}
  {#if newEntryCount > 0 && !stickyAtBottom}
    <button
      type="button"
      class="new-entries"
      data-testid="phase-log-new-entries"
      onclick={scrollToBottom}
    >
      ↓ {newEntryCount} new entr{newEntryCount === 1 ? 'y' : 'ies'}
    </button>
  {/if}
</section>

<style>
  .pane {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    position: relative;
  }
  .pane-header {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: var(--schegent-text-caption);
    min-height: 1rem;
  }
  .live-indicator {
    color: var(--vscode-charts-red);
    font-weight: 600;
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
  .warning {
    opacity: 0.7;
    font-style: italic;
  }
  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    /* `RunDetailTier` scrolls as a normal, content-sized page (like the tiers
       above it), not a viewport-bound flex column, so this list cannot rely on
       flex-grow to inherit a height from an ancestor. It sizes to its own
       content up to this cap and scrolls internally beyond it — the bound the
       sticky-at-bottom auto-scroll heuristic above needs to have any effect. */
    max-height: min(60vh, 480px);
    border: 1px solid var(--schegent-border, transparent);
    border-radius: var(--schegent-radius-sm);
    background: var(--schegent-surface-sunken);
  }
  .loading {
    opacity: 0.7;
    font-style: italic;
  }
  .new-entries {
    position: absolute;
    bottom: 0.5rem;
    left: 50%;
    transform: translateX(-50%);
    padding: 0.25rem 0.75rem;
    font-size: 0.75rem;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: var(--schegent-radius-sm);
    cursor: pointer;
    transition: transform 0.1s ease;
  }
  .new-entries:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .new-entries:active {
    transform: translateX(-50%) scale(0.93);
  }
</style>
