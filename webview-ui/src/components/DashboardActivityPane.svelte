<script lang="ts">
  import type { PhaseTile, WorkflowSnapshot } from '../lib/snapshot-types';
  import type { PhaseLogStore } from '../lib/phase-log-store.svelte';
  import PhaseProgression from './PhaseProgression.svelte';
  import PhaseLogFeed from './PhaseLogFeed/PhaseLogFeed.svelte';
  import RunOutputs from './RunOutputs.svelte';

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

  const runOutputs = $derived(snapshot.runOutputs ?? []);
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

  <!-- Feature 087 (T064, FR-043) — recorded named outputs sit between the Phase
       progression and the activity feed, so Run details reads as one surface.
       The component renders nothing when the Run recorded none, and neither does
       this wrapper: `.right-panel` is a gapped flex column, so an empty card is
       not free — it still costs one `--schegent-pad` of column height and
       shrinks the activity feed, which is `flex: 1 1 0`. Gate the wrapper on the
       same condition the component gates itself on. -->
  {#if runOutputs.length > 0}
    <div class="glass-card run-outputs-card">
      <RunOutputs outputs={runOutputs} />
    </div>
  {/if}

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
  .run-outputs-card {
    flex-shrink: 0;
    max-height: 25%;
    overflow: hidden;
  }
  .activity-feed-card {
    flex: 1 1 0;
    min-height: 120px;
    overflow: hidden;
  }
  .glass-card {
    background: var(--schegent-surface);
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    padding: 14px;
    box-shadow: none;
    display: flex;
    flex-direction: column;
  }
  .zone-title {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--schegent-fg);
    margin: 0 0 var(--schegent-gap) 0;
    letter-spacing: 0.02em;
  }
  .activity-audit { min-height: 0; overflow: hidden; }

  @media (max-width: 900px) {
    .right-panel {
      min-height: 720px;
      overflow: visible;
    }
    .activity-feed-card {
      min-height: 440px;
    }
  }
</style>
