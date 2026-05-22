<script lang="ts">
  import type {
    QueueItem,
    PhaseTile,
    WorkflowSnapshot
  } from '../lib/snapshot-types';
  import { postCommand } from '../lib/vscode-api';
  import {
    CMD_PAUSE_QUEUE,
    CMD_RESUME_QUEUE,
    CMD_START_QUEUE,
    CMD_CLEAR_ALL,
    CMD_CLEAR_COMPLETED
  } from '../lib/messages';
  import {
    EMPTY_ACTIVITY_FEED_SELECTION,
    jumpActivityFeedToCurrent,
    reconcileActivityFeedSelection,
    resolveColdStartFallback,
    selectActivityFeedPhase,
    selectActivityFeedQueue,
    selectActivityFeedTask,
    toPhaseLogSelection,
    type ActivityFeedSelection
  } from '../lib/activity-feed-selection.svelte';
  import { createPhaseLogStore } from '../lib/phase-log-store.svelte';
  // Feature 030 (US3, T039/T040) — QueueManagementPanel.svelte was deleted
  // alongside the multi-queue surfaces. Item 053 (053-webview-decomposition)
  // further split the inline dashboard zones into QueueInputForm,
  // QueueControls, and QueueListView sub-components.
  import PhaseProgression from './PhaseProgression.svelte';
  import PhaseLogFeed from './PhaseLogFeed/PhaseLogFeed.svelte';
  import QueueInputForm from './QueueInputForm.svelte';
  import QueueControls from './QueueControls.svelte';
  import QueueListView from './QueueListView.svelte';
  import { useConfirm } from '../lib/use-confirm';
  import { deriveCleanAllContext } from '../lib/queue-derived';

  let leftPanelCollapsed = $state(false);

  function toggleLeftPanel(): void {
    leftPanelCollapsed = !leftPanelCollapsed;
  }

  interface Props {
    snapshot: WorkflowSnapshot;
  }

  const { snapshot }: Props = $props();

  const queue = $derived(snapshot.queue);
  const phases = $derived(snapshot.phases);
  const isPrimary = $derived(snapshot.isPrimary);
  const activeFeature = $derived(snapshot.activeFeature);
  const activePipeline = $derived(snapshot.activePipeline ?? null);
  const manualPauseAt = $derived(snapshot.manualPauseAt ?? null);
  const manualPauseCause = $derived(snapshot.manualPauseCause ?? null);
  const phaseOverrides = $derived(snapshot.phaseOverrides ?? []);
  const availablePipelines = $derived(snapshot.availablePipelines ?? []);
  const defaultPipelineId = $derived(snapshot.generalSettings?.defaultPipelineId ?? '');
  const activeTaskId = $derived(queue.inFlight?.id ?? null);

  let activityFeedSelection = $state<ActivityFeedSelection>(EMPTY_ACTIVITY_FEED_SELECTION);
  const activityFeedStore = createPhaseLogStore();

  const selectedFeedTaskId = $derived(activityFeedSelection.taskId);
  const isShowingSelectedTask = $derived(
    selectedFeedTaskId !== null && selectedFeedTaskId !== activeTaskId
  );

  const effectivePhases = $derived.by((): readonly PhaseTile[] => {
    if (!isShowingSelectedTask || selectedFeedTaskId === null) return phases;
    const item =
      queue.pending.find((t) => t.id === selectedFeedTaskId) ??
      queue.recent.find((t) => t.id === selectedFeedTaskId);
    if (!item) return phases;
    const catalog = snapshot.availablePhases ?? [];
    if (catalog.length === 0) return phases;
    // Filter catalog phases to only those belonging to the task's pipeline.
    // Without this, ALL catalog phases (including phases from unrelated
    // pipelines like bugfix) would appear in the phase progression.
    let phaseDefs = catalog;
    if (item.currentPipelineId) {
      const pipeline = availablePipelines.find((p) => p.id === item.currentPipelineId);
      if (pipeline) {
        const catalogById = new Map(catalog.map((d) => [d.id, d]));
        // Preserve pipeline ordering rather than catalog ordering
        phaseDefs = pipeline.phases
          .map((phaseId) => catalogById.get(phaseId))
          .filter((d): d is typeof catalog[number] => d !== undefined);
      }
    }
    return phaseDefs.map((def, idx): PhaseTile => {
      let state: PhaseTile['state'] = 'not-started';
      if (item.status === 'completed') {
        state = 'completed';
      } else if (item.status === 'failed' || item.status === 'canceled') {
        const currentIdx = phaseDefs.findIndex((p) => p.id === item.currentPhase);
        if (currentIdx >= 0) {
          if (idx < currentIdx) state = 'completed';
          else if (idx === currentIdx) state = 'active';
        }
      } else if (item.status === 'in-flight') {
        const currentIdx = phaseDefs.findIndex((p) => p.id === item.currentPhase);
        if (currentIdx >= 0) {
          if (idx < currentIdx) state = 'completed';
          else if (idx === currentIdx) state = 'active';
        }
      }
      return {
        name: def.id,
        displayName: def.name,
        order: idx + 1,
        state,
        iteration: 0,
        lastResult: null,
        elapsedMs: 0,
        subProgress: null
      };
    });
  });

  const effectiveTaskId = $derived(selectedFeedTaskId ?? activeTaskId);

  const orderedItems = $derived<readonly QueueItem[]>([
    ...(queue.inFlight ? [queue.inFlight] : []),
    ...queue.pending,
    ...queue.recent
  ]);

  const completedCount = $derived(
    queue.recent.filter((r) => r.status === 'completed').length
  );
  const failedCount = $derived(queue.recent.filter((r) => r.status === 'failed').length);
  const canceledCount = $derived(
    queue.recent.filter((r) => r.status === 'canceled').length
  );

  // BUG-003 / FR-012a — tri-state props for the contextual button.
  const queuePaused = $derived(queue.paused);
  const pendingCount = $derived(queue.pending.length);
  const hasInFlight = $derived(queue.inFlight !== null);
  const hasActiveRun = $derived((snapshot.activeRunId ?? null) !== null);
  const clearDoneDisabled = $derived(completedCount === 0);
  // Feature 063 (T023) — Clean All gate: enabled iff ANY of the five reset
  // surfaces is non-empty. The four queue/run surfaces are visible from
  // the webview snapshot; watchdog backoff is host-only and is folded into
  // the host-side no-op guard inside `QueueManager.clearAll()` (T016).
  const cleanDisabled = $derived(
    pendingCount === 0 &&
      completedCount === 0 &&
      failedCount === 0 &&
      canceledCount === 0 &&
      !hasInFlight &&
      !queuePaused &&
      !hasActiveRun
  );

  function selectionsEqual(a: ActivityFeedSelection, b: ActivityFeedSelection): boolean {
    return (
      a.queueId === b.queueId &&
      a.taskId === b.taskId &&
      a.pipelineId === b.pipelineId &&
      a.phaseId === b.phaseId &&
      a.iterationN === b.iterationN &&
      a.followMode === b.followMode &&
      a.manualLevel === b.manualLevel
    );
  }

  function applyActivityFeedSelection(next: ActivityFeedSelection): void {
    activityFeedSelection = next;
    activityFeedStore.setSelection(toPhaseLogSelection(next));
  }

  $effect(() => {
    const next = reconcileActivityFeedSelection(snapshot, activityFeedSelection);
    if (!selectionsEqual(next, activityFeedSelection)) {
      applyActivityFeedSelection(next);
    }
  });

  // BUG-006 (063) — Activity Feed cold-start fallback. When the dashboard
  // mounts after a VS Code restart with no in-flight task and no prior
  // selection, the Activity Feed defaults to EMPTY_ACTIVITY_FEED_SELECTION
  // and renders the "No phase selected" empty state — operators read this
  // as "my logs disappeared." Wire Feature 021's resolveColdStartFallback
  // so the most-recently-updated recent task with on-disk logs auto-loads.
  //
  // Runs once at mount via a `coldStartApplied` latch; subsequent snapshot
  // updates flow through the reconcile `$effect` above.
  let coldStartApplied = $state(false);
  $effect(() => {
    if (coldStartApplied) return;
    if (activityFeedSelection.taskId !== null) {
      coldStartApplied = true;
      return;
    }
    if (snapshot.queue.inFlight !== null) {
      // Live selection covers this case; reconcile $effect above will
      // resolve it.
      coldStartApplied = true;
      return;
    }
    const fallback = resolveColdStartFallback(
      snapshot,
      (taskId) =>
        snapshot.queue.recent.find((item) => item.id === taskId)?.hasOnDiskLogs === true
    );
    coldStartApplied = true;
    if (fallback !== null) {
      applyActivityFeedSelection(fallback);
    }
  });

  function onActivityFeedQueueSelect(queueId: string | null): void {
    if (queueId === null) {
      applyActivityFeedSelection({
        ...EMPTY_ACTIVITY_FEED_SELECTION,
        followMode: 'manual',
        manualLevel: 'queue'
      });
      return;
    }
    applyActivityFeedSelection(selectActivityFeedQueue(snapshot, queueId));
  }

  function onActivityFeedTaskSelect(taskId: string | null): void {
    if (taskId === null) {
      applyActivityFeedSelection({
        ...activityFeedSelection,
        taskId: null,
        pipelineId: null,
        phaseId: null,
        iterationN: null,
        followMode: 'manual',
        manualLevel: 'task'
      });
      return;
    }
    applyActivityFeedSelection(selectActivityFeedTask(snapshot, taskId));
  }

  function onActivityFeedPhaseSelect(phaseId: string | null): void {
    if (phaseId === null) {
      applyActivityFeedSelection({
        ...activityFeedSelection,
        phaseId: null,
        iterationN: null,
        followMode: 'manual',
        manualLevel: 'phase'
      });
      return;
    }
    applyActivityFeedSelection(selectActivityFeedPhase(snapshot, activityFeedSelection, phaseId));
  }

  function onActivityFeedJumpToCurrent(): void {
    const next = jumpActivityFeedToCurrent(snapshot, activityFeedSelection);
    applyActivityFeedSelection(next);
  }

  async function onPause(event: MouseEvent): Promise<void> {
    // Feature 063 (T035) — gate Pause behind the universal confirmation.
    const ok = await useConfirm('queue.pause', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: {}
    });
    if (!ok) return;
    postCommand(CMD_PAUSE_QUEUE);
  }

  async function onResume(event: MouseEvent): Promise<void> {
    // Feature 063 (T035) — gate Resume behind the universal confirmation.
    const ok = await useConfirm('queue.resume', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: {}
    });
    if (!ok) return;
    postCommand(CMD_RESUME_QUEUE);
  }

  async function onClearDone(event: MouseEvent): Promise<void> {
    if (clearDoneDisabled) return;
    // Feature 063 (T035) — gate Clear Done behind the universal confirmation
    // with the impact count rendered inside the body.
    const ok = await useConfirm('queue.clear-done', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: { completedCount }
    });
    if (!ok) return;
    postCommand(CMD_CLEAR_COMPLETED);
  }

  async function onClean(event: MouseEvent): Promise<void> {
    if (cleanDisabled) return;
    // Feature 063 (US3, T048) — derive the impact inventory through the
    // shared helper so the same shape is unit-testable in isolation
    // (clean-all-context.test.ts). The body template inside
    // ACTION_COPY['queue.clean-all'] consumes every field via
    // renderActionBody().
    const ok = await useConfirm('queue.clean-all', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: deriveCleanAllContext(snapshot)
    });
    if (!ok) return;
    postCommand(CMD_CLEAR_ALL);
  }
</script>

<main class="dashboard" data-testid="dashboard-root">
  <div class="dashboard-header">
    <h1 class="dashboard-title">Schegent Orchestrator</h1>
  </div>

  <div class="dashboard-split" class:left-collapsed={leftPanelCollapsed}>
    <button
      type="button"
      class="panel-toggle"
      data-testid="dashboard-panel-toggle"
      title={leftPanelCollapsed ? 'Show queue panel' : 'Hide queue panel'}
      aria-label={leftPanelCollapsed ? 'Show queue panel' : 'Hide queue panel'}
      onclick={toggleLeftPanel}
    >
      <svg class="panel-toggle-icon" class:rotated={leftPanelCollapsed} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6"></polyline>
      </svg>
    </button>

    <div class="left-panel" data-testid="dashboard-left-panel">
      <div class="left-panel-scroll">
        <QueueInputForm
          {availablePipelines}
          {defaultPipelineId}
          pendingCount={queue.pending.length}
        />

        <section class="zone queue-management glass-card queue-list-section" data-testid="dashboard-queue-management">
          <h2 class="zone-h2">Active Queue</h2>
          <QueueControls
            {isPrimary}
            paused={queuePaused}
            {pendingCount}
            {hasInFlight}
            {clearDoneDisabled}
            {cleanDisabled}
            {onResume}
            {onPause}
            {onClearDone}
            {onClean}
          />
          <QueueListView
            {orderedItems}
            {isPrimary}
            selectedTaskId={activityFeedSelection.taskId}
            onTaskSelect={(taskId) => onActivityFeedTaskSelect(taskId)}
          />
        </section>
      </div>
    </div>

    <div class="right-panel" data-testid="dashboard-right-panel">
      <div class="glass-card phase-progression-card">
        <PhaseProgression
          phases={effectivePhases}
          {activeFeature}
          {activePipeline}
          activeTaskId={effectiveTaskId}
          activeRunId={snapshot.activeRunId ?? null}
          {isPrimary}
          {manualPauseAt}
          {manualPauseCause}
          {phaseOverrides}
          phaseBreakpoints={snapshot.phaseBreakpoints ?? []}
          resumeTargetPhaseId={snapshot.resumeTargetPhaseId ?? null}
          delayedRetry={snapshot.delayedRetry}
          selectedPhaseId={activityFeedSelection.phaseId}
          onSelectPhase={(phaseId) => onActivityFeedPhaseSelect(phaseId)}
        />
      </div>

      <section class="zone activity-audit glass-card activity-feed-card" data-testid="dashboard-activity-audit-feed">
        <header class="zone-title">Activity Feed</header>
        <PhaseLogFeed
          {snapshot}
          store={activityFeedStore}
          onSelectQueue={onActivityFeedQueueSelect}
          onSelectTask={(taskId) => onActivityFeedTaskSelect(taskId)}
          onSelectPhase={onActivityFeedPhaseSelect}
          onJumpToCurrent={onActivityFeedJumpToCurrent}
        />
      </section>
    </div>
  </div>
</main>

<style>
  .dashboard {
    display: flex;
    flex-direction: column;
    padding: var(--schegent-pad);
    color: var(--schegent-fg);
    background: transparent;
    flex: 1;
    min-height: 0;
    box-sizing: border-box;
    overflow: hidden;
  }
  .dashboard-header {
    flex-shrink: 0;
    margin-bottom: var(--schegent-pad);
  }
  .dashboard-title {
    font-size: 1.5em;
    font-weight: 600;
    margin: 0 0 8px 0;
    background: var(--sch-accent-gradient);
    background-clip: text;
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .dashboard-split {
    display: flex;
    flex: 1;
    min-height: 0;
    gap: var(--schegent-pad);
    overflow: hidden;
    position: relative;
  }

  .left-panel {
    width: 420px;
    min-width: 320px;
    max-width: 50%;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                min-width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                opacity 0.25s ease;
  }
  .left-collapsed .left-panel {
    width: 0;
    min-width: 0;
    opacity: 0;
    pointer-events: none;
    overflow: hidden;
  }

  .left-panel-scroll {
    display: flex;
    flex-direction: column;
    gap: var(--schegent-pad);
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .right-panel {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--schegent-pad);
    overflow: hidden;
    transition: flex 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .panel-toggle {
    position: absolute;
    left: 0;
    top: 8px;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 40px;
    border: 1px solid var(--sch-glass-border);
    border-left: none;
    border-radius: 0 var(--schegent-radius) var(--schegent-radius) 0;
    background: var(--sch-glass-bg);
    backdrop-filter: blur(12px);
    color: var(--schegent-muted-fg);
    cursor: pointer;
    transition: background 0.2s, color 0.2s, left 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .panel-toggle:hover {
    background: var(--vscode-list-hoverBackground);
    color: var(--schegent-fg);
  }
  .dashboard-split:not(.left-collapsed) .panel-toggle {
    left: 420px;
  }
  .panel-toggle-icon {
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .panel-toggle-icon.rotated {
    transform: rotate(180deg);
  }

  .queue-management {
    flex-shrink: 0;
  }
  .queue-list-section {
    flex: 1 1 auto;
    min-height: 60px;
    overflow: hidden;
  }
  .phase-progression-card {
    flex-shrink: 0;
  }
  .activity-feed-card {
    flex: 1 1 0;
    min-height: 120px;
    overflow: hidden;
  }
  .glass-card {
    background: var(--sch-glass-bg);
    border: 1px solid var(--sch-glass-border);
    border-radius: var(--schegent-radius);
    padding: var(--schegent-pad);
    box-shadow: var(--sch-card-shadow);
    backdrop-filter: blur(12px);
    display: flex;
    flex-direction: column;
  }
  .zone-title {
    font-size: 0.9em;
    font-weight: 600;
    color: var(--schegent-muted-fg);
    margin: 0 0 var(--schegent-gap) 0;
    letter-spacing: 0.05em;
  }
  .zone-h2 {
    font-size: 0.95em;
    font-weight: 600;
    color: var(--schegent-fg);
    margin: 0 0 var(--schegent-gap) 0;
    text-transform: none;
  }

  .activity-audit { min-height: 0; overflow: hidden; }
</style>
