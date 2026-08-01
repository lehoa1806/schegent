<script lang="ts">
  import type { QueueItem } from '../lib/snapshot-types';

  interface Props {
    readonly item: QueueItem;
    readonly showCurrentPhase: boolean;
    readonly showPausedReason: boolean;
    readonly showPausedBadge: boolean;
    readonly showResumeCountdown: boolean;
    readonly showRetryBadge: boolean;
    readonly phaseChipLabel: string;
    readonly pauseCauseLabel: string;
    readonly pauseCauseTitle: string;
    readonly pausedBadgeLabel: string;
    readonly resumeCountdownLabel: string;
  }

  const {
    item,
    showCurrentPhase,
    showPausedReason,
    showPausedBadge,
    showResumeCountdown,
    showRetryBadge,
    phaseChipLabel,
    pauseCauseLabel,
    pauseCauseTitle,
    pausedBadgeLabel,
    resumeCountdownLabel
  }: Props = $props();
</script>

<div class="row row-3 meta" data-testid="queue-item-meta-{item.id}">
  {#if showCurrentPhase}
    <span class="chip phase-chip" data-testid="queue-item-phase-{item.id}">{phaseChipLabel}</span>
  {/if}
  {#if showPausedReason}
    <span
      class="chip paused-chip"
      data-testid="queue-item-pause-cause-{item.id}"
      title={pauseCauseTitle}
    >{pauseCauseLabel}</span>
  {/if}
  {#if showPausedBadge}
    <span
      class="chip paused-chip paused-badge"
      data-testid="queue-item-pause-badge-{item.id}"
      data-pause-source={item.paused?.pauseSource}
      data-pause-cause-category={item.paused?.pauseCauseCategory ?? ''}
    >{pausedBadgeLabel}</span>
    {#if showResumeCountdown}
      <span
        class="chip restore-chip"
        data-testid="queue-item-restore-time-{item.id}"
        title="Queue auto-resumes when the quota window reopens"
      >{resumeCountdownLabel}</span>
    {/if}
  {/if}
  {#if showRetryBadge}
    <span class="badge retry-badge" data-testid="queue-item-retry-{item.id}">
      retry: {item.retryCount}
    </span>
  {/if}
</div>

<style>
  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--schegent-gap);
    padding-left: 4px;
    color: var(--schegent-muted-fg);
    font-size: 0.85em;
  }

  .chip,
  .badge {
    padding: 0 6px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: transparent;
  }

  .badge {
    display: inline-flex;
    align-items: center;
  }

  .phase-chip,
  .restore-chip {
    border-color: currentColor;
    color: var(--schegent-color-active);
  }

  .paused-chip {
    color: var(--schegent-muted-fg);
    font-style: italic;
  }

  .paused-badge[data-pause-source='system-paused'],
  .retry-badge {
    border-color: currentColor;
    color: var(--schegent-color-error);
  }

  .paused-badge[data-pause-source='system-paused'],
  .restore-chip {
    font-style: normal;
  }
</style>
