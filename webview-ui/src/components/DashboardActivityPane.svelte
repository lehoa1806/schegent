<script lang="ts">
  import type { PhaseTile, WorkflowSnapshot } from '../lib/snapshot-types';
  import type { PhaseLogStore } from '../lib/phase-log-store.svelte';
  import { formatDuration } from '../lib/format-duration';
  import { formatPhaseLabel, formatRelativeTime, formatStatus } from '../lib/format';
  import PhaseProgression from './PhaseProgression.svelte';
  import PhaseLogFeed from './PhaseLogFeed/PhaseLogFeed.svelte';
  import RunOutputs from './RunOutputs.svelte';
  import { defaultQueueId, runtimeForTask } from '../lib/queue-runtime-view';

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

  const visiblePhases = $derived(phases ?? []);
  const selectedTask = $derived(
    activeTaskId === null
      ? null
      : snapshot.queue.orderedItems?.find((item) => item.id === activeTaskId)
        ?? (snapshot.queue.inFlight?.id === activeTaskId ? snapshot.queue.inFlight : null)
        ?? snapshot.queue.pending?.find((item) => item.id === activeTaskId)
        ?? snapshot.queue.recent?.find((item) => item.id === activeTaskId)
        ?? null
  );
  const runtime = $derived(runtimeForTask(snapshot, activeTaskId, selectedTask?.queueId));
  const inFlightRun = $derived(runtime?.inFlightRun ?? null);
  const runOutputs = $derived(inFlightRun?.outputs ?? []);
  const activePhase = $derived(visiblePhases.find((phase) => phase.state === 'active') ?? null);
  const focusedPhase = $derived(
    visiblePhases.find((phase) => phase.name === selectedPhaseId) ?? activePhase ?? visiblePhases[0] ?? null
  );
  const runTitle = $derived(selectedTask?.label ?? inFlightRun?.feature?.label ?? 'No active run');
  const runIdentity = $derived(inFlightRun?.runId ?? activeTaskId);
  const pipelineLabel = $derived(
    selectedTask?.currentPipelineId ?? inFlightRun?.pipeline?.name ?? 'Default pipeline'
  );
  const isActiveSelection = $derived(
    activeTaskId !== null && activeTaskId === snapshot.queue.inFlight?.id
  );
  const elapsedLabel = $derived(
    !isActiveSelection || (inFlightRun?.elapsedMs ?? null) === null
      ? null
      : formatDuration(inFlightRun!.elapsedMs!)
  );
  const startedAt = $derived(selectedTask?.startedAt ?? inFlightRun?.feature?.startedAt ?? null);
  const startedLabel = $derived(startedAt === null ? null : formatRelativeTime(startedAt));
  const runStatus = $derived(inFlightRun?.status ?? 'idle');
  const statusClass = $derived(selectedTask?.status ?? runStatus);
  const statusLabel = $derived(
    selectedTask?.status === 'in-flight'
      ? 'In progress'
      : selectedTask?.status === 'pending'
        ? 'Queued'
        : selectedTask?.status
          ? selectedTask.status.charAt(0).toUpperCase() + selectedTask.status.slice(1)
          : formatStatus(runStatus)
  );

  type DetailSection = 'overview' | 'activity' | 'outputs';
  let detailSection = $state<DetailSection>('overview');

  function moveToSection(section: DetailSection, id: string): void {
    detailSection = section;
    document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  }

  function phaseStateLabel(state: PhaseTile['state']): string {
    switch (state) {
      case 'completed': return 'Passed';
      case 'active': return 'In progress';
      case 'not-started': return 'Pending';
      case 'skipped': return 'Skipped';
      case 'disabled': return 'Disabled';
    }
  }
</script>

<div class="right-panel" data-testid="dashboard-right-panel">
  <header class="run-shell-header" id="run-overview">
    <nav class="detail-tabs" aria-label="Run detail sections">
      <button
        type="button"
        class:active={detailSection === 'overview'}
        aria-pressed={detailSection === 'overview'}
        onclick={() => moveToSection('overview', 'run-overview')}
      >Run overview</button>
      <button
        type="button"
        class:active={detailSection === 'activity'}
        aria-pressed={detailSection === 'activity'}
        onclick={() => moveToSection('activity', 'activity-feed-panel')}
      >Activity</button>
      {#if runOutputs.length > 0}
        <button
          type="button"
          class:active={detailSection === 'outputs'}
          aria-pressed={detailSection === 'outputs'}
          onclick={() => moveToSection('outputs', 'run-outputs-panel')}
        >Outputs</button>
      {/if}
    </nav>

    <div class="run-summary">
      <div class="run-heading">
        <div class="run-title-row">
          <h1>{runTitle}</h1>
          <span class="run-status status-{statusClass}">{statusLabel}</span>
        </div>
        <div class="run-meta">
          {#if runIdentity}<code title={runIdentity}>{runIdentity}</code>{/if}
          <span>{pipelineLabel}</span>
          {#if startedLabel}<span>Started {startedLabel}</span>{/if}
        </div>
      </div>
      {#if elapsedLabel}
        <div class="elapsed-block">
          <span>Elapsed</span>
          <strong>{elapsedLabel}</strong>
        </div>
      {/if}
    </div>
  </header>

  <div class="workbench-overview">
    <div class="phase-progression-card">
      <PhaseProgression
        phases={visiblePhases}
        activeFeature={inFlightRun?.feature ?? null}
        activePipeline={inFlightRun?.pipeline ?? null}
        {activeTaskId}
        activeRunId={inFlightRun?.runId ?? null}
        queueId={runtime?.queueId ?? defaultQueueId(snapshot)}
        isPrimary={snapshot.isPrimary}
        manualPauseAt={runtime?.manualPause?.at ?? null}
        manualPauseCause={runtime?.manualPause?.cause ?? null}
        phaseOverrides={runtime?.phaseOverrides ?? []}
        phaseBreakpoints={runtime?.phaseBreakpoints ?? []}
        resumeTargetPhaseId={inFlightRun?.resumeTargetPhaseId ?? null}
        delayedRetry={inFlightRun?.delayedRetry}
        {selectedPhaseId}
        onSelectPhase={onSelectPhase}
      />
    </div>

    <section class="phase-context" aria-label="Selected phase details">
      <header class="context-header">
        <div>
          <span class="context-label">Current phase</span>
          <h2>{focusedPhase ? formatPhaseLabel(focusedPhase.name, focusedPhase.displayName) : 'Waiting for a phase'}</h2>
        </div>
        {#if focusedPhase}
          <span class="phase-state state-{focusedPhase.state}">{phaseStateLabel(focusedPhase.state)}</span>
        {/if}
      </header>

      {#if focusedPhase}
        <dl class="context-facts">
          <div>
            <dt>Iteration</dt>
            <dd>{focusedPhase.iteration > 0 ? focusedPhase.iteration : '—'}</dd>
          </div>
          <div>
            <dt>Phase time</dt>
            <dd>{formatDuration(focusedPhase.elapsedMs)}</dd>
          </div>
          <div>
            <dt>Result</dt>
            <dd>{focusedPhase.lastResult ?? 'Pending'}</dd>
          </div>
          {#if focusedPhase.subProgress}
            <div>
              <dt>{focusedPhase.subProgress.label}s</dt>
              <dd>{focusedPhase.subProgress.current}/{focusedPhase.subProgress.total}</dd>
            </div>
          {/if}
        </dl>
      {/if}

      <div class="activity-summary">
        <span>Latest activity</span>
        <p>{inFlightRun?.liveActivity?.summary ?? 'Waiting for the next run event.'}</p>
      </div>
    </section>
  </div>

  <!-- Recorded outputs remain part of Run details and stay visible beside the
       phase and evidence surfaces. The wrapper renders only when data exists. -->
  {#if runOutputs.length > 0}
    <div id="run-outputs-panel" class="run-outputs-card">
      <RunOutputs outputs={runOutputs} />
    </div>
  {/if}

  <section
    id="activity-feed-panel"
    class="zone activity-audit activity-feed-card"
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
    overflow: hidden;
    background: var(--schegent-pane-bg);
    transition: flex 220ms var(--schegent-ease-out);
  }
  .run-shell-header {
    flex: 0 0 auto;
    border-bottom: 1px solid var(--schegent-divider);
    background: var(--schegent-bg);
  }
  .detail-tabs {
    display: flex;
    min-height: 36px;
    align-items: stretch;
    gap: 2px;
    padding: 0 var(--schegent-space-3);
    border-bottom: 1px solid var(--schegent-divider);
  }
  .detail-tabs button {
    position: relative;
    min-height: 35px;
    padding: 0 10px;
    border: 0;
    background: transparent;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-secondary);
    cursor: pointer;
  }
  .detail-tabs button::after {
    position: absolute;
    right: 10px;
    bottom: -1px;
    left: 10px;
    height: 2px;
    background: transparent;
    content: '';
  }
  .detail-tabs button:hover {
    color: var(--schegent-fg);
    background: var(--schegent-surface-hover);
  }
  .detail-tabs button.active { color: var(--schegent-fg); }
  .detail-tabs button.active::after { background: var(--schegent-color-active); }
  .run-summary {
    display: flex;
    min-height: 76px;
    align-items: center;
    justify-content: space-between;
    gap: var(--schegent-space-4);
    padding: var(--schegent-space-3) var(--schegent-space-4);
  }
  .run-heading { min-width: 0; }
  .run-title-row {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--schegent-space-2);
  }
  .run-title-row h1 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--schegent-fg);
    font-size: var(--schegent-text-heading);
    font-weight: 650;
    letter-spacing: -0.02em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-status,
  .phase-state {
    display: inline-flex;
    min-height: 22px;
    align-items: center;
    border: 1px solid currentColor;
    border-radius: var(--schegent-radius-sm);
    padding: 0 7px;
    font-size: var(--schegent-text-caption);
    font-weight: 600;
    white-space: nowrap;
  }
  .run-status.status-in-flight,
  .phase-state.state-active {
    color: var(--schegent-color-active);
    background: color-mix(in srgb, var(--schegent-color-active) 10%, transparent);
  }
  .run-status.status-completed,
  .phase-state.state-completed {
    color: var(--schegent-color-completed);
  }
  .run-status.status-failed { color: var(--schegent-error-text); }
  .run-status.status-paused,
  .run-status.status-pending,
  .phase-state.state-not-started {
    color: var(--schegent-color-warning);
  }
  .run-status.status-idle,
  .run-status.status-canceled,
  .phase-state.state-skipped,
  .phase-state.state-disabled {
    color: var(--schegent-muted-fg);
  }
  .run-meta {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    gap: 4px 14px;
    margin-top: 5px;
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
  }
  .run-meta code {
    max-width: 28ch;
    overflow: hidden;
    color: var(--schegent-muted-fg);
    font-family: var(--schegent-mono-font);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .elapsed-block {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    font-variant-numeric: tabular-nums;
  }
  .elapsed-block span {
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
  }
  .elapsed-block strong {
    font-family: var(--schegent-mono-font);
    font-size: var(--schegent-text-body);
    font-weight: 600;
  }
  .workbench-overview {
    display: grid;
    min-height: 230px;
    max-height: 42%;
    grid-template-columns: minmax(220px, 0.8fr) minmax(280px, 1.2fr);
    flex: 0 1 42%;
    overflow: hidden;
    border-bottom: 1px solid var(--schegent-divider);
  }
  .phase-progression-card {
    min-width: 0;
    overflow: hidden;
    padding: var(--schegent-space-3);
    border-right: 1px solid var(--schegent-divider);
    background: var(--schegent-bg);
  }
  .phase-context {
    min-width: 0;
    overflow-y: auto;
    padding: var(--schegent-space-4);
    background: var(--schegent-pane-bg);
  }
  .context-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--schegent-space-3);
  }
  .context-label,
  .activity-summary > span {
    color: var(--schegent-color-active);
    font-size: var(--schegent-text-caption);
    font-weight: 650;
    letter-spacing: 0.045em;
    text-transform: uppercase;
  }
  .context-header h2 {
    margin: 4px 0 0;
    color: var(--schegent-fg);
    font-size: var(--schegent-text-subheading);
    font-weight: 650;
  }
  .context-facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--schegent-space-4);
    margin: var(--schegent-space-4) 0 0;
    padding: var(--schegent-space-3) 0;
    border-block: 1px solid var(--schegent-divider);
  }
  .context-facts div { min-width: 76px; }
  .context-facts dt {
    color: var(--schegent-muted-fg);
    font-size: var(--schegent-text-caption);
  }
  .context-facts dd {
    margin: 3px 0 0;
    color: var(--schegent-fg);
    font-family: var(--schegent-mono-font);
    font-size: var(--schegent-text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .activity-summary { margin-top: var(--schegent-space-4); }
  .activity-summary p {
    max-width: 68ch;
    margin: 7px 0 0;
    color: var(--schegent-fg);
    font-family: var(--schegent-mono-font);
    font-size: var(--schegent-text-secondary);
    line-height: 1.5;
  }
  .run-outputs-card {
    flex: 0 0 auto;
    max-height: 22%;
    overflow: auto;
    padding: var(--schegent-space-3) var(--schegent-space-4);
    border-bottom: 1px solid var(--schegent-divider);
    background: var(--schegent-bg);
  }
  .activity-feed-card {
    flex: 1 1 0;
    min-height: 180px;
    overflow: hidden;
    padding: var(--schegent-space-3) var(--schegent-space-4) var(--schegent-space-4);
    background: var(--schegent-bg);
    display: flex;
    flex-direction: column;
  }
  .zone-title {
    font-size: var(--schegent-text-caption);
    font-weight: 650;
    color: var(--schegent-fg);
    margin: 0 0 var(--schegent-space-2) 0;
    letter-spacing: 0.045em;
    text-transform: uppercase;
  }
  .activity-audit { min-height: 0; overflow: hidden; }

  @media (max-width: 900px) {
    .right-panel {
      min-height: 860px;
      overflow: visible;
    }
    .run-title-row h1 { white-space: normal; }
    .workbench-overview {
      max-height: none;
      grid-template-columns: 1fr;
      flex-basis: auto;
      overflow: visible;
    }
    .phase-progression-card {
      min-height: 260px;
      border-right: 0;
      border-bottom: 1px solid var(--schegent-divider);
    }
    .activity-feed-card { min-height: 440px; }
  }

  @media (max-width: 620px) {
    .run-summary {
      align-items: flex-start;
      flex-direction: column;
    }
    .elapsed-block { align-items: flex-start; }
    .detail-tabs { overflow-x: auto; }
  }
</style>
