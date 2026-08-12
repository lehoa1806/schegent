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
            <span class="runner-badge" title="Executing on {selectedRunner}">{selectedRunner}</span>
          {/if}
        {/if}
      {/if}
    {:else}
      <span class="crumb crumb-empty">No selection</span>
    {/if}
  </div>

  <button
    type="button"
    class="jump-btn {jumpDisabled ? 'is-aria-disabled' : ''}"
    data-testid="phase-log-jump-current"
    aria-disabled={jumpDisabled}
    title={jumpTooltip}
    onclick={handleJumpClick}
  >
    <svg class="jump-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"></polygon>
    </svg>
    <span class="jump-label">Live</span>
  </button>
  {#if entryCount > 0}
    <button
      type="button"
      class="copy-btn {copyFeedback ? 'copied' : ''}"
      data-testid="phase-log-copy-all"
      title="Copy all entries to clipboard"
      onclick={handleCopy}
    >
      {#if copyFeedback}
        <svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      {:else}
        <svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
      {/if}
    </button>
  {/if}
</div>

<style>
  .selectors {
    display: flex;
    gap: var(--schegent-gap, 0.5rem);
    align-items: center;
    min-height: 28px;
  }

  .breadcrumb-trail {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }

  .crumb {
    font-size: 0.78rem;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 160px;
    padding: 2px 8px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--vscode-list-hoverBackground) 80%, transparent);
  }

  .crumb-queue {
    color: var(--schegent-color-active);
  }

  .crumb-task {
    color: var(--schegent-fg);
  }

  .crumb-phase {
    color: var(--schegent-color-completed);
  }

  .crumb-empty {
    color: var(--schegent-muted-fg);
    font-style: italic;
    background: transparent;
  }

  .crumb-separator {
    color: var(--schegent-disabled-fg);
    font-size: 0.85rem;
    flex-shrink: 0;
    user-select: none;
  }

  .jump-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 12px 4px 8px;
    border-radius: 999px;
    border: 1px solid var(--schegent-color-active);
    background: color-mix(in srgb, var(--schegent-color-active) 12%, transparent);
    color: var(--schegent-color-active);
    font-size: 0.78rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition:
      background-color 0.2s ease,
      border-color 0.2s ease,
      color 0.2s ease,
      opacity 0.2s ease,
      transform 0.1s ease;
  }

  .jump-btn:hover:not(.is-aria-disabled) {
    background: color-mix(in srgb, var(--schegent-color-active) 25%, transparent);
  }

  .jump-btn:active:not(.is-aria-disabled) {
    transform: scale(0.93);
    opacity: 0.8;
  }

  .jump-btn.is-aria-disabled {
    opacity: 0.55;
    cursor: pointer;
    border-color: var(--schegent-disabled-fg);
    color: var(--schegent-disabled-fg);
    background: transparent;
  }

  .jump-label {
    display: none;
    font-size: 11px;
    font-weight: 600;
  }

  .runner-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    height: 18px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-left: 6px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    opacity: 0.9;
  }

  .jump-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  .jump-label {
    line-height: 1;
  }

  .copy-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
    background: transparent;
    color: var(--schegent-muted-fg);
    cursor: pointer;
    flex-shrink: 0;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease,
      opacity 0.15s ease,
      transform 0.1s ease;
  }

  .copy-btn:hover {
    color: var(--schegent-fg);
    border-color: var(--schegent-focus-border);
    background: color-mix(in srgb, var(--vscode-list-hoverBackground) 60%, transparent);
  }

  .copy-btn:active {
    transform: scale(0.88);
    opacity: 0.8;
  }

  .copy-btn.copied {
    color: var(--schegent-color-completed);
    border-color: var(--schegent-color-completed);
  }

  .copy-icon {
    width: 14px;
    height: 14px;
  }
</style>
