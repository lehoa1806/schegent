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
  import DashboardQueuePane from './DashboardQueuePane.svelte';
  import DashboardActivityPane from './DashboardActivityPane.svelte';
  import { useConfirm } from '../lib/use-confirm';
  import { deriveCleanAllContext } from '../lib/queue-derived';
  import { defaultQueueRuntime, findQueueRuntime } from '../lib/queue-runtime-view';
  import { scopeQueueProjection } from '../lib/scope-queue-projection';

  let leftPanelCollapsed = $state(false);
  let queueTab = $state<'queue' | 'history'>('queue');

  function toggleLeftPanel(): void {
    leftPanelCollapsed = !leftPanelCollapsed;
  }

  interface Props {
    snapshot: WorkflowSnapshot;
    /**
     * Feature 092 (T108) — the queue this pane is showing. Absent on the Queues
     * tier's own reading, where every surface means the default queue exactly as
     * it did before the drill-down existed; present on the Queue Detail tier,
     * where the operator named a queue. The `undefined` branch below is
     * deliberately the untouched pre-feature expression, so the unscoped path
     * cannot drift as the scoped one grows.
     */
    queueId?: string;
  }

  const { snapshot, queueId }: Props = $props();

  const queue = $derived(
    queueId === undefined ? snapshot.queue : scopeQueueProjection(snapshot, queueId)
  );
  // Feature 092 — the phase strip belongs to a queue; with no explicit
  // selection that is the default queue.
  const queueRuntime = $derived(
    queueId === undefined ? defaultQueueRuntime(snapshot) : findQueueRuntime(snapshot, queueId)
  );
  const phases = $derived(queueRuntime?.phases ?? []);
  const isPrimary = $derived(snapshot.isPrimary);
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
      } else if (item.status === 'in-flight' || item.status === 'paused') {
        const currentIdx = phaseDefs.findIndex((p) => p.id === item.currentPhase);
        if (currentIdx >= 0) {
          if (idx < currentIdx) state = 'completed';
          else if (idx === currentIdx) state = 'active';
        }
      }
      return {
        name: def.id,
        displayName: def.name,
        ...(def.isRequired !== undefined ? { isRequired: def.isRequired } : {}),
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

  const orderedItems = $derived<readonly QueueItem[]>(queue.orderedItems ?? []);

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
  const hasActiveRun = $derived((queueRuntime?.inFlightRun ?? null) !== null);
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

  // Named `selectedQueueId` rather than `queueId`: the prop of that name is the
  // queue this whole pane is scoped to, and shadowing it here would read as if
  // the feed selection could retarget the pane.
  function onActivityFeedQueueSelect(selectedQueueId: string | null): void {
    if (selectedQueueId === null) {
      applyActivityFeedSelection({
        ...EMPTY_ACTIVITY_FEED_SELECTION,
        followMode: 'manual',
        manualLevel: 'queue'
      });
      return;
    }
    applyActivityFeedSelection(selectActivityFeedQueue(snapshot, selectedQueueId));
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

  /**
   * Feature 092 (T108, FR-057) — address the queue the tier is showing. The
   * unscoped reading posts the command with **no** second argument at all, not
   * with an `undefined` one: that is the call the host has always received and
   * always defaulted to the default queue, and keeping it argument-identical is
   * what lets the pre-feature assertions stand unedited.
   */
  function postQueueCommand(command: typeof CMD_PAUSE_QUEUE | typeof CMD_RESUME_QUEUE): void {
    if (queueId === undefined) {
      postCommand(command);
      return;
    }
    postCommand(command, { queueId });
  }

  async function onPause(event: MouseEvent): Promise<void> {
    // Feature 063 (T035) — gate Pause behind the universal confirmation.
    const ok = await useConfirm('queue.pause', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: {}
    });
    if (!ok) return;
    postQueueCommand(CMD_PAUSE_QUEUE);
  }

  async function onResume(event: MouseEvent): Promise<void> {
    // Feature 063 (T035) — gate Resume behind the universal confirmation.
    const ok = await useConfirm('queue.resume', {
      originatingElement: event.currentTarget as HTMLElement | null,
      context: {}
    });
    if (!ok) return;
    postQueueCommand(CMD_RESUME_QUEUE);
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

<main class="dashboard" data-testid="dashboard-root" aria-label="Operations">
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

    <DashboardQueuePane
      collapsed={leftPanelCollapsed}
      {availablePipelines}
      {defaultPipelineId}
      {queueId}
      {pendingCount}
      {queueTab}
      {isPrimary}
      paused={queuePaused}
      {hasInFlight}
      {clearDoneDisabled}
      {cleanDisabled}
      queueLifecycle={queue.lifecycle ?? null}
      {orderedItems}
      selectedTaskId={activityFeedSelection.taskId}
      history={snapshot.history}
      onQueueTabChange={(tab) => (queueTab = tab)}
      onTaskSelect={onActivityFeedTaskSelect}
      {onResume}
      {onPause}
      {onClearDone}
      {onClean}
    />

    <DashboardActivityPane
      {snapshot}
      phases={effectivePhases}
      activeTaskId={effectiveTaskId}
      selectedPhaseId={activityFeedSelection.phaseId}
      store={activityFeedStore}
      onSelectQueue={onActivityFeedQueueSelect}
      onSelectTask={onActivityFeedTaskSelect}
      onSelectPhase={onActivityFeedPhaseSelect}
      onJumpToCurrent={onActivityFeedJumpToCurrent}
    />
  </div>
</main>

<style>
  .dashboard {
    display: flex;
    flex-direction: column;
    color: var(--schegent-fg);
    background: var(--schegent-pane-bg);
    flex: 1;
    min-height: 0;
    box-sizing: border-box;
    overflow: hidden;
  }

  .dashboard-split {
    display: flex;
    flex: 1;
    min-height: 0;
    gap: 0;
    overflow: hidden;
    position: relative;
  }

  .panel-toggle {
    position: absolute;
    left: 0;
    top: 10px;
    z-index: var(--schegent-z-popover);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 32px;
    border: 1px solid var(--schegent-border);
    border-left: none;
    border-radius: 0 5px 5px 0;
    background: var(--schegent-shell-bg);
    color: var(--schegent-muted-fg);
    cursor: pointer;
    transition:
      background-color 160ms cubic-bezier(0.16, 1, 0.3, 1),
      color 160ms cubic-bezier(0.16, 1, 0.3, 1),
      transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .panel-toggle:hover {
    background: var(--vscode-list-hoverBackground);
    color: var(--schegent-fg);
  }
  .dashboard-split:not(.left-collapsed) .panel-toggle {
    transform: translateX(336px);
  }
  .panel-toggle-icon {
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .panel-toggle-icon.rotated {
    transform: rotate(180deg);
  }

  @media (max-width: 900px) {
    .dashboard {
      overflow-y: auto;
    }
    .dashboard-split {
      display: grid;
      flex: none;
      min-height: auto;
      overflow: visible;
    }
    .panel-toggle {
      display: none;
    }
  }

</style>
