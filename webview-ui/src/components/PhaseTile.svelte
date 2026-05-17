<script lang="ts">
  import { formatPhaseLabel, formatIteration } from '../lib/format';
  import { formatDuration } from '../lib/format-duration';
  import { isLoopablePhaseTile } from '../lib/snapshot-types';
  import type { DelayedRetryState, PhaseTile } from '../lib/snapshot-types';

  // Feature 011 — `pendingRetry` is shown only on the active tile when
  // the host's snapshot reports `delayedRetry.pendingRetryAt !== null`
  // (FR-008 hidden-when-not-pending). `nowMs` is a reactive clock the
  // parent ticks every second so the countdown re-renders smoothly.
  // `onRetryNow` dispatches CMD_RETRY_PHASE_NOW via the parent.
  // `retryDisabled` reflects pending-ack state so we cannot fire twice.
  let {
    tile,
    pendingRetry,
    nowMs,
    onRetryNow,
    retryDisabled
  }: {
    tile: PhaseTile;
    pendingRetry?: DelayedRetryState | null;
    nowMs?: number;
    onRetryNow?: () => void;
    retryDisabled?: boolean;
  } = $props();

  const isActive = $derived(tile.state === 'active');
  const showIteration = $derived(isActive && isLoopablePhaseTile(tile) && tile.iteration > 0);
  const showElapsed = $derived(tile.state !== 'not-started' && tile.elapsedMs > 0);
  const elapsedLabel = $derived(showElapsed ? formatDuration(tile.elapsedMs) : '');
  const subProgress = $derived(tile.subProgress);
  const subProgressLabel = $derived(formatSubProgress(subProgress));

  // Feature 011 — only render the affordance on the active tile when a
  // delayed retry is pending. The host clears `pendingRetryAt` to null
  // when the retry resolves or the user invokes "Retry Now", so the
  // countdown disappears automatically.
  const showPendingRetry = $derived(
    isActive &&
      !!pendingRetry &&
      pendingRetry.pendingRetryAt !== null
  );
  const retryDeadlineMs = $derived(
    pendingRetry?.pendingRetryAt ? Date.parse(pendingRetry.pendingRetryAt) : null
  );
  const retryCountdownSec = $derived(
    retryDeadlineMs !== null && nowMs !== undefined
      ? Math.max(0, Math.floor((retryDeadlineMs - nowMs) / 1000))
      : 0
  );
  const retryCountdownLabel = $derived(formatCountdown(retryCountdownSec));
  const retryCauseLabel = $derived(
    pendingRetry?.pendingRetryCause === 'rate_limit'
      ? 'rate-limit'
      : pendingRetry?.pendingRetryCause === 'transient_error'
        ? 'transient'
        : ''
  );

  function formatCountdown(totalSec: number): string {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  function formatSubProgress(sp: PhaseTile['subProgress']): string {
    if (!sp) return '';
    if (sp.label === 'iteration') {
      return `${sp.current}/${sp.total} iterations`;
    }
    return `${sp.current}/${sp.total} tasks`;
  }

  function handleRetryClick(): void {
    if (retryDisabled) return;
    onRetryNow?.();
  }
</script>

<li
  class="tile state-{tile.state}"
  data-testid="phase-tile-{tile.name}"
  aria-current={isActive ? 'step' : undefined}
>
  <span class="order">{tile.order}</span>
  <span class="name">{formatPhaseLabel(tile.name)}</span>
  {#if showIteration && !subProgressLabel}
    <span class="iteration" data-testid="phase-iteration-{tile.name}">
      {formatIteration(tile.iteration)}
    </span>
  {/if}
  {#if subProgressLabel}
    <span class="sub-progress" data-testid="phase-subprogress-{tile.name}">
      {subProgressLabel}
    </span>
  {/if}
  {#if showElapsed}
    <span class="elapsed" data-testid="phase-elapsed-{tile.name}">{elapsedLabel}</span>
  {/if}
  {#if tile.state === 'skipped'}
    <span class="badge skipped">skipped</span>
  {/if}
  {#if tile.state === 'completed' && tile.lastResult}
    <span class="badge result-{tile.lastResult}">{tile.lastResult}</span>
  {/if}
  {#if showPendingRetry}
    <span
      class="pending-retry"
      data-testid="phase-pending-retry-{tile.name}"
      title="Cause: {retryCauseLabel}; count {pendingRetry?.delayedRetryCount ?? 0}"
    >
      Pending retry in {retryCountdownLabel}
    </span>
    <button
      type="button"
      class="retry-now"
      data-testid="phase-retry-now-{tile.name}"
      disabled={retryDisabled}
      onclick={handleRetryClick}
    >
      Retry Phase Now
    </button>
  {/if}
</li>

<style>
  .tile {
    display: flex;
    align-items: center;
    gap: var(--schegent-gap);
    padding: 4px var(--schegent-pad);
    border-radius: var(--schegent-radius);
    color: var(--schegent-muted-fg);
  }
  .tile.state-active {
    color: var(--schegent-fg);
    background: var(--schegent-list-active);
    box-shadow: inset 2px 0 0 var(--schegent-color-active);
  }
  .tile.state-completed {
    color: var(--schegent-fg);
  }
  .tile.state-skipped {
    color: var(--schegent-muted-fg);
    text-decoration: line-through;
  }
  .order {
    flex: 0 0 1.25em;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--schegent-muted-fg);
  }
  .name {
    flex: 1 1 auto;
  }
  .iteration {
    flex: 0 0 auto;
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }
  .sub-progress {
    flex: 0 0 auto;
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
    font-variant-numeric: tabular-nums;
  }
  .elapsed {
    flex: 0 0 auto;
    color: var(--schegent-muted-fg);
    font-size: 0.8em;
    font-variant-numeric: tabular-nums;
  }
  .badge {
    font-size: 0.75em;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--schegent-list-hover);
    color: var(--schegent-muted-fg);
  }
  .badge.result-clean {
    color: var(--schegent-color-completed);
  }
  .badge.result-issues-remain,
  .badge.result-ambiguities-remain {
    color: var(--schegent-color-warning);
  }
  .pending-retry {
    flex: 0 0 auto;
    color: var(--schegent-color-warning);
    font-size: 0.8em;
    font-variant-numeric: tabular-nums;
  }
  .retry-now {
    flex: 0 0 auto;
    font-size: 0.78em;
    padding: 1px 8px;
    border-radius: 3px;
    border: 1px solid var(--schegent-button-border, transparent);
    background: var(--schegent-button-bg, var(--vscode-button-background));
    color: var(--schegent-button-fg, var(--vscode-button-foreground));
    cursor: pointer;
  }
  .retry-now[disabled] {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .retry-now:hover:not([disabled]) {
    background: var(--schegent-button-hover-bg, var(--vscode-button-hoverBackground));
  }
</style>
