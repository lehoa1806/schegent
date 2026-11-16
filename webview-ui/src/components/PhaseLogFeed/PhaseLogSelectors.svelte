<script lang="ts">
  // Feature 021 — Streamlined Activity Feed header. The three cascading
  // dropdowns (Queue → Task → Phase) have been removed in favour of
  // direct panel/phase-step selection. This component now shows only a
  // compact breadcrumb trail reflecting the current selection and the
  // "Jump to current phase" affordance.
  //
  // Props come from PhaseLogFeed.svelte; this component owns no state.

  import type {
    QueueProjection,
    HistoryEntry
  } from '../../lib/snapshot-types';
  import type { PhaseLogSelectionDraft } from '../../lib/phase-log-store.svelte';

  interface Props {
    readonly snapshot: {
      readonly queue: QueueProjection;
      readonly history: readonly HistoryEntry[];
    };
    readonly selection: PhaseLogSelectionDraft;
    readonly iterations: readonly number[];
    readonly availablePhases?: readonly { readonly id: string; readonly name?: string }[];
    readonly selectedRunner?: string | null;
    readonly entryCount?: number;
    readonly onSelectQueue: (queueId: string | null) => void;
    readonly onSelectTask: (taskId: string | null, pipelineId: string | null) => void;
    readonly onSelectPhase: (phaseId: string | null) => void;
    readonly onJumpToCurrent: () => void;
    readonly onCopyAll?: () => void;
  }

  let {
    snapshot,
    selection,
    iterations: _iterations,
    availablePhases = [],
    selectedRunner = null,
    entryCount = 0,
    onSelectQueue: _onSelectQueue,
    onSelectTask: _onSelectTask,
    onSelectPhase: _onSelectPhase,
    onJumpToCurrent,
    onCopyAll
  }: Props = $props();

  let copyFeedback = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  function handleCopy(): void {
    if (!onCopyAll || entryCount === 0) return;
    onCopyAll();
    if (copyTimer !== null) clearTimeout(copyTimer);
    copyFeedback = true;
    copyTimer = setTimeout(() => {
      copyFeedback = false;
      copyTimer = null;
    }, 1500);
  }

  // Feature 067 T029 (FR-008, FR-012) — Live button MUST remain
  // click-receptive whenever the operator may need to re-engage Live
  // Mode. When `inFlight === null` we render an `aria-disabled` visual
  // treatment, but the click handler still fires so the store can set
  // intent ON for the next non-null inFlight push (FR-008).
  const jumpDisabled = $derived(snapshot.queue.inFlight === null);
  const jumpTooltip = $derived(jumpDisabled ? 'No in-flight phase (click to enable Live Mode)' : 'Jump to the currently executing phase');

  // Breadcrumb derivations — show the user what's currently selected
  // without requiring dropdowns.
  const selectedQueueName = $derived(
    selection.queueId
      ? (snapshot.queue.queues ?? []).find((q) => q.id === selection.queueId)?.name ?? selection.queueId
      : null
  );

  const selectedTaskLabel = $derived.by(() => {
    if (!selection.taskId) return null;
    const inFlight = snapshot.queue.inFlight;
    if (inFlight && inFlight.id === selection.taskId) return inFlight.label || selection.taskId;
    const pending = snapshot.queue.pending.find((p) => p.id === selection.taskId);
    if (pending) return pending.label || selection.taskId;
    const recent = snapshot.queue.recent.find((r) => r.id === selection.taskId);
    if (recent) return recent.label || selection.taskId;
    const hist = snapshot.history.find((h) => h.runId === selection.taskId);
    if (hist) return hist.descriptionPreview || selection.taskId;
    return selection.taskId;
  });

  const selectedPhaseName = $derived(
    selection.phaseId
      ? availablePhases.find((p) => p.id === selection.phaseId)?.name ?? selection.phaseId
      : null
  );

  // Feature 067 T030 — unconditional dispatch. The store's
  // `jumpToCurrent` handles both the cascade path (inFlight !== null)
  // and the intent-only path (inFlight === null) per FR-007/FR-008.
  function handleJumpClick(): void {
    onJumpToCurrent();
  }
</script>

<!-- Drawn as the redesign's log toolbar: what the log shows, then its actions at the end. The
     product follows live output with a ghost "Live" button where the redesign has a checkbox, and
     copies with the redesign's copy icon. -->
<div class="selectors" data-testid="phase-log-selectors">
  <div class="breadcrumb-trail" data-testid="phase-log-breadcrumb">
    {#if selectedQueueName}
      <span class="crumb crumb-queue" title="Selected queue">{selectedQueueName}</span>
      {#if selectedTaskLabel}
        <span class="crumb-separator" aria-hidden="true">›</span>
        <span class="crumb crumb-task" title="Selected task">{selectedTaskLabel}</span>
        {#if selectedPhaseName}
          <span class="crumb-separator" aria-hidden="true">›</span>
          <span class="crumb crumb-phase" title="Selected phase">{selectedPhaseName}</span>
          {#if selectedRunner}
            <span class="tag runner-badge" title="Executing on {selectedRunner}">{selectedRunner}</span>
          {/if}
        {/if}
      {/if}
    {:else}
      <span class="crumb crumb-empty">No selection</span>
    {/if}
  </div>

  <button
    type="button"
    class="btn btn-ghost btn-sm jump-btn {jumpDisabled ? 'is-aria-disabled' : ''}"
    data-testid="phase-log-jump-current"
    aria-disabled={jumpDisabled}
    title={jumpTooltip}
    onclick={handleJumpClick}
  >
    <svg class="i" aria-hidden="true"><use href="#i-play"></use></svg>
    <span class="jump-label">Live</span>
  </button>
  {#if entryCount > 0}
    <button
      type="button"
      class="icon-btn copy-btn {copyFeedback ? 'copied' : ''}"
      data-testid="phase-log-copy-all"
      title="Copy all entries to clipboard"
      onclick={handleCopy}
    >
      {#if copyFeedback}
        <svg class="i" aria-hidden="true"><use href="#i-check"></use></svg>
      {:else}
        <svg class="i" aria-hidden="true"><use href="#i-copy"></use></svg>
      {/if}
    </button>
  {/if}
</div>

<style>
  /* The rest of the log's toolbar row; below the stepper when the row cannot hold both. */
  .selectors {
    display: flex;
    flex: 1 1 20rem;
    min-width: 0;
    align-items: center;
    gap: var(--schegent-space-2);
    min-height: var(--schegent-control-height-compact);
  }

  /* What the log shows, in secondary text: where it sits muted and the step itself in the
     foreground, as the redesign's run page names a step. Long names end in an ellipsis. */
  .breadcrumb-trail {
    display: flex;
    align-items: center;
    gap: var(--schegent-space-1-5);
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    font-size: var(--schegent-text-secondary);
    color: var(--schegent-muted-fg);
  }
  .crumb {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The step keeps its name when the row is tight, up to half the trail; the queue and the task
     give way first. */
  .crumb-phase {
    flex-shrink: 0;
    max-width: min(160px, 50%);
    color: var(--schegent-fg);
    font-weight: 600;
  }
  .crumb-empty {
    font-style: italic;
  }
  .crumb-separator,
  .runner-badge,
  .jump-btn,
  .copy-btn {
    flex-shrink: 0;
  }
  .crumb-separator {
    user-select: none;
  }

  /* The play icon takes the active colour while there is a phase to follow. With nothing in
     flight the button reads as off but stays a button, since a click arms Live Mode for the next
     phase (FR-008). */
  .jump-btn .i {
    --sg-status-color: var(--schegent-color-active);
  }
  .jump-btn.is-aria-disabled {
    color: var(--schegent-muted-fg);
  }
  .jump-btn.is-aria-disabled .i {
    --sg-status-color: currentColor;
  }

  .copy-btn {
    color: var(--schegent-muted-fg);
  }
  .copy-btn:hover {
    color: var(--schegent-fg);
  }
  .copy-btn.copied .i {
    --sg-status-color: var(--schegent-color-completed);
  }
</style>
