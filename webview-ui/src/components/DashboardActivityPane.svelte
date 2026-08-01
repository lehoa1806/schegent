<script lang="ts">
  import type { PhaseTile, WorkflowSnapshot } from '../lib/snapshot-types';
  import type { PhaseLogStore } from '../lib/phase-log-store.svelte';
  import PhaseProgression from './PhaseProgression.svelte';
  import PhaseLogFeed from './PhaseLogFeed/PhaseLogFeed.svelte';

  interface Props {
    snapshot: WorkflowSnapshot;
    phases: readonly PhaseTile[];
    activeTaskId: string | null;
    selectedPhaseId: string | null;
    store: PhaseLogStore;
    onSelectQueue: (queueId: string | null) => void;
    onSelectTask: (taskId: string | null) => void;
    onSelectPhase: (phaseId: string | null) => void;
    onJumpToCurrent: () => void;
  }

  const {
    snapshot,
    phases,
    activeTaskId,
    selectedPhaseId,
    store,
    onSelectQueue,
    onSelectTask,
    onSelectPhase,
    onJumpToCurrent
  }: Props = $props();
</script>

<div class="right-panel" data-testid="dashboard-right-panel">
  <div class="glass-card phase-progression-card">
    <PhaseProgression
      {phases}
      activeFeature={snapshot.activeFeature}
      activePipeline={snapshot.activePipeline ?? null}
      {activeTaskId}
      activeRunId={snapshot.activeRunId ?? null}
      isPrimary={snapshot.isPrimary}
      manualPauseAt={snapshot.manualPauseAt ?? null}
      manualPauseCause={snapshot.manualPauseCause ?? null}
      phaseOverrides={snapshot.phaseOverrides ?? []}
      phaseBreakpoints={snapshot.phaseBreakpoints ?? []}
      resumeTargetPhaseId={snapshot.resumeTargetPhaseId ?? null}
      delayedRetry={snapshot.delayedRetry}
      {selectedPhaseId}
      onSelectPhase={onSelectPhase}
    />
  </div>

  <section
    class="zone activity-audit glass-card activity-feed-card"
    data-testid="dashboard-activity-audit-feed"
  >
    <header class="zone-title">Activity Feed</header>
    <PhaseLogFeed
      {snapshot}
      {store}
      onSelectQueue={onSelectQueue}
      onSelectTask={onSelectTask}
      onSelectPhase={onSelectPhase}
      onJumpToCurrent={onJumpToCurrent}
    />
  </section>
</div>

<style>
  .right-panel {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--schegent-pad);
    overflow: hidden;
    transition: flex 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .phase-progression-card { flex-shrink: 0; }
  .activity-feed-card {
    flex: 1 1 0;
    min-height: 120px;
    overflow: hidden;
  }
  .glass-card {
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 0;
    box-shadow: none;
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
  .activity-audit { min-height: 0; overflow: hidden; }
</style>
