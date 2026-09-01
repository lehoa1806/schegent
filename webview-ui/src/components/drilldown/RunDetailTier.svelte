<script lang="ts">
  // Feature 092 (T110, T111, FR-058, FR-062, FR-065, FR-066) — tier 3 of the
  // drill-down: one Run.
  //
  // One destination, two renderings, chosen by what backs the Run (FR-058). The
  // Workflow-backed rendering **relocates** feature 091's `WorkflowRun.svelte`
  // here rather than drawing a second topology (FR-066) — this file imports it
  // and passes it this queue's rows, and owns none of its behaviour. The
  // Pipeline-backed rendering reuses `PhaseProgression` and `QueueItemActions`
  // for the same reason.
  //
  // The live feed is read from `QueueRuntime.inFlightRun.liveActivity`, this
  // queue's own reading, and deliberately NOT from the global
  // `LiveActivityHeader`: that component reads the store's workspace-wide
  // activity, which under concurrent Runs is some other queue's feed. Reading it
  // here would be exactly the cross-queue bleed FR-051 and FR-052 forbid.
  //
  // Mockup: docs/mockup/schegent_mockup.html `view-run-detail`.

  import PhaseProgression from '../PhaseProgression.svelte';
  import QueueItemActions from '../QueueItemActions.svelte';
  import WorkflowRun from '../WorkflowRun/WorkflowRun.svelte';
  import PhaseLogFeed from '../PhaseLogFeed/PhaseLogFeed.svelte';
  import RunOutputs from '../RunOutputs.svelte';
  import { findQueueRuntime } from '../../lib/queue-runtime-view';
  import { formatDuration } from '../../lib/format-duration';
  import type { QueueItemStatus } from '../../lib/snapshot-types';
  import { resolveTaskPipelineName } from '../../lib/resolve-pipeline-name';
  import { createPhaseLogStore } from '../../lib/phase-log-store.svelte';
  import { deriveRunLivenessView, deriveRunProgressView } from '../../lib/run-liveness-view';
  import { nowCoarse } from '../../lib/tick-store';
  import type { WorkflowSnapshot } from '../../lib/snapshot-types';

  interface Props {
    snapshot: WorkflowSnapshot;
    /** The queue the Run is addressed within, as tier 3's location carries it. */
    queueId: string;
    /**
     * A connected run's `connectedRunId` or a Task's id — the two things a Run
     * can be addressed by. Which one it is decides the rendering, so the
     * destination needs no `kind` discriminator that could disagree with the
     * catalog.
     */
    runId: string;
    /** FR-065 — a non-primary window reads the Run but mutates nothing. */
    isPrimary: boolean;
    onBack: () => void;
  }

  const { snapshot, queueId, runId, isPrimary, onBack }: Props = $props();

  const runtime = $derived(findQueueRuntime(snapshot, queueId));
  const queueName = $derived(runtime?.name ?? queueId);
  const tasks = $derived(runtime?.tasks ?? []);

  const connectedRun = $derived(
    (snapshot.connectedRuns ?? []).find((run) => run.connectedRunId === runId) ?? null
  );
  const task = $derived(tasks.find((item) => item.id === runId) ?? null);
  // T010 (FR-010/SC-003) — the same resolver tier 2's row calls, so the two
  // tiers can never disagree about what a Task's Pipeline is named.
  const pipelineName = $derived(
    task !== null ? resolveTaskPipelineName(task, snapshot.availablePipelines ?? []) : ''
  );

  const inFlightRun = $derived(runtime?.inFlightRun ?? null);
  // The feed belongs to this Run only while this Run is the one executing. A
  // pending Task's detail view reports idle rather than borrowing the reading of
  // whichever Run the queue happens to be working.
  const isExecuting = $derived(
    inFlightRun !== null &&
    inFlightRun.feature?.id === runId &&
    (task?.status === 'in-flight')
  );
  const liveActivity = $derived(isExecuting ? inFlightRun?.liveActivity ?? null : null);
  const feedText = $derived(
    liveActivity === null
      ? 'idle'
      : `${liveActivity.summary ?? 'idle'} — ${liveActivity.freshness}`
  );
  // Same non-borrowing rule as `liveActivity` above: outputs belong to
  // whichever Run is executing, and a Task that isn't the one executing must
  // not show a sibling Run's recorded outputs.
  const outputs = $derived(isExecuting ? inFlightRun?.outputs ?? [] : []);

  // FR-R3-008 (T380) — the reload-durable pair, under the same non-borrowing
  // rule as everything above: a Task that is not the one executing reads
  // `null`, which renders as unknown rather than as a sibling Run's stamp.
  //
  // `$nowCoarse` is the shared 1-minute tick, not a second interval. A minute is
  // the right cadence for "how long has this been silent": the operator question
  // is whether a phase has stalled, and the host only writes the stamp every 15 s
  // anyway, so a per-second re-render would refresh a number that had not moved.
  const liveness = $derived(isExecuting ? inFlightRun?.liveness ?? null : null);
  const progress = $derived(isExecuting ? inFlightRun?.progress ?? null : null);
  const livenessView = $derived(deriveRunLivenessView(liveness, $nowCoarse));
  const progressView = $derived(deriveRunProgressView(progress));

  // ── Meta line derivations ──────────────────────────────────────────
  const STATUS_LABELS: Record<QueueItemStatus, string> = {
    'pending': 'Pending',
    'in-flight': 'Running',
    'paused': 'Paused',
    'completed': 'Completed',
    'canceled': 'Canceled',
    'failed': 'Failed'
  };
  function statusLabel(s: QueueItemStatus): string {
    return STATUS_LABELS[s] ?? s;
  }

  const elapsedLabel = $derived(
    inFlightRun?.elapsedMs != null && inFlightRun.elapsedMs > 0
      ? formatDuration(inFlightRun.elapsedMs)
      : null
  );

  const phases = $derived(runtime?.phases ?? []);
  const activePhaseIndex = $derived(
    phases.findIndex((p) => p.state === 'active')
  );
  const phaseOfTotal = $derived(
    phases.length > 0
      ? `phase ${(activePhaseIndex >= 0 ? activePhaseIndex + 1 : phases.length)} of ${phases.length}`
      : null
  );
  const currentIteration = $derived(
    activePhaseIndex >= 0 ? phases[activePhaseIndex].iteration : 1
  );

  // ── Tab state ──────────────────────────────────────────────────────
  let activeTab = $state<'log' | 'outputs' | 'context'>('log');

  // Feature 097 (T006) — a local PhaseLogStore pinned to this Run. Unlike the
  // removed Dashboard embed, this tier is about one Run, so the store lives
  // here rather than being shared workspace-wide.
  const phaseLogStore = createPhaseLogStore();
  let pinnedTaskKey: string | null = null;

  $effect(() => {
    if (task === null) return;
    const key = `${queueId}:${runId}:${task.currentPipelineId}:${task.currentPhase}`;
    if (key === pinnedTaskKey) return;
    // A re-pin follows the Run as it advances, which is right up until the
    // operator picks a phase tile themselves: `setPhase` records that as an
    // operator selection and turns Live Mode off (Feature 067), and the phase
    // they pinned has to survive the next transition. The first pin is
    // unconditional — it is what fills the feed on mount, and Live Mode is
    // persisted webview-wide, so reading it here would leave this tier empty
    // for an operator who had turned it off on some other surface.
    if (pinnedTaskKey !== null && !phaseLogStore.isLiveMode()) {
      pinnedTaskKey = key;
      return;
    }
    pinnedTaskKey = key;
    phaseLogStore.setSelection(
      {
        queueId,
        taskId: runId,
        pipelineId: task.currentPipelineId ?? null,
        phaseId: task.currentPhase ?? null,
        iterationN: null
      },
      { origin: 'cascade' }
    );
  });

  // The phase strip is this tier's navigation into the Activity Feed beside
  // it: the operator picks the phase whose log they want to read. Default
  // origin ('manual') on purpose — this is an operator selection, and the
  // Live button in the feed's own header is how they hand the follow back.
  const selectedPhaseId = $derived(phaseLogStore.state.selection.phaseId);

  function handleSelectPhase(phaseId: string): void {
    phaseLogStore.setPhase(phaseId);
  }

  // What "currently executing" means on a surface about one Run: this Run,
  // while it is the one executing, and nothing otherwise — the same
  // non-borrowing rule `liveActivity` and `outputs` above already apply. The
  // embed's own default is the workspace singular, which here is whatever the
  // *default* queue happens to be executing; see `liveTarget` on PhaseLogFeed
  // for both things that read wrong.
  //
  // `queueId` is overridden from this tier's own prop rather than trusted from
  // the projection: `QueueItem.queueId` is optional, and `jumpToCurrent`
  // returns null without it, which would leave Live silently doing nothing.
  const liveTarget = $derived({
    inFlight: isExecuting && task !== null ? { ...task, queueId } : null
  });

  function onBackKeyDown(event: KeyboardEvent): void {
    // jsdom does not synthesise click from Enter/Space on a button; FR-059's
    // keyboard path is handled explicitly, as it is on the tiers above.
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onBack();
  }
</script>

<main class="run-detail-tier" data-testid="run-detail-tier" aria-label="Run detail">
  <header class="tier-header">
    <button
      type="button"
      class="back"
      data-testid="run-detail-back"
      onclick={onBack}
      onkeydown={onBackKeyDown}
    >
      &larr; {queueName}
    </button>
  </header>

  {#if connectedRun !== null}
    <!-- Workflow-backed: the relocated topology view, unchanged (FR-066). -->
    <WorkflowRun
      run={connectedRun}
      queueItems={tasks}
      pipelines={snapshot.availablePipelines ?? []}
    />
  {:else if task !== null}
    <!-- Header block: title + meta line + action buttons -->
    <div class="run-header-block">
      <div class="run-header-top">
        <h1
          class="run-prompt"
          data-testid="run-detail-prompt"
          title={task.label}
        >{task.label.length > 64 ? task.label.slice(0, 64) + '…' : task.label}</h1>
        {#if isPrimary}
          <div class="header-actions" data-testid="run-detail-controls">
            <QueueItemActions item={task} {isPrimary} />
          </div>
        {/if}
      </div>

      <p class="run-meta" data-testid="run-detail-meta">
        <span class="meta-id">{task.id.length > 10 ? task.id.slice(0, 10) : task.id}</span>
        <span class="meta-sep">&middot;</span>
        <span class="meta-pipeline" data-testid="run-detail-pipeline">{pipelineName}</span>
        <span class="meta-sep">&middot;</span>
        <span
          class="meta-status status-{task.status}"
          data-testid="run-detail-status"
        >{statusLabel(task.status)}</span>
        {#if elapsedLabel !== null}
          <span class="meta-sep">&middot;</span>
          <span class="meta-elapsed">{elapsedLabel}</span>
        {/if}
        {#if phaseOfTotal !== null}
          <span class="meta-sep">&middot;</span>
          <span class="meta-phase-of">{phaseOfTotal}</span>
        {/if}
        {#if currentIteration > 1}
          <span class="meta-sep">&middot;</span>
          <span class="meta-iteration">iteration {currentIteration}</span>
        {/if}
      </p>
    </div>

    <!-- Two-column body: phases left, content right -->
    <div class="run-columns">
      <!-- Left panel: Phase Progression -->
      <!--
        Lifecycle round-check finding C — `delayedRetry`. `PhaseProgression` has
        declared that prop since the delayed-retry badge was built, and this,
        its only wiring site, never passed it: `isWaitingRetry` was permanently
        false in the shipping build, so the countdown never rendered and the
        Retry now control it gates had nowhere to appear. Gated on `isExecuting`
        for the same reason as `activeRunId` — a countdown belonging to the
        queue's live Run must not be drawn on a surface showing another Task.
      -->
      <aside class="run-left-panel">
        <PhaseProgression
          phases={phases}
          activeTaskId={isExecuting ? runId : null}
          activeRunId={isExecuting ? inFlightRun?.runId ?? null : null}
          {queueId}
          targetsSubjectRun={isExecuting}
          {isPrimary}
          manualPauseAt={runtime?.manualPause?.at ?? null}
          manualPauseCause={runtime?.manualPause?.cause ?? null}
          phaseOverrides={runtime?.phaseOverrides ?? []}
          phaseBreakpoints={runtime?.phaseBreakpoints ?? []}
          resumeTargetPhaseId={inFlightRun?.resumeTargetPhaseId ?? null}
          delayedRetry={isExecuting ? inFlightRun?.delayedRetry : undefined}
          {selectedPhaseId}
          onSelectPhase={handleSelectPhase}
        />
      </aside>

      <!-- Right panel: Tabbed content -->
      <div class="run-right-panel">
        <div class="tab-bar" role="tablist">
          <button
            type="button"
            role="tab"
            class="tab-btn"
            class:active={activeTab === 'log'}
            aria-selected={activeTab === 'log'}
            data-testid="run-tab-log"
            onclick={() => activeTab = 'log'}
          >&Sigma; Phase log</button>
          <button
            type="button"
            role="tab"
            class="tab-btn"
            class:active={activeTab === 'outputs'}
            aria-selected={activeTab === 'outputs'}
            data-testid="run-tab-outputs"
            onclick={() => activeTab = 'outputs'}
          >&#128196; Run outputs</button>
          <button
            type="button"
            role="tab"
            class="tab-btn"
            class:active={activeTab === 'context'}
            aria-selected={activeTab === 'context'}
            data-testid="run-tab-context"
            onclick={() => activeTab = 'context'}
          >&#128196; Context</button>

          {#if isExecuting}
            <span class="streaming-badge" data-testid="run-streaming-badge">
              <span class="streaming-dot"></span>
              STREAMING
            </span>
          {/if}
        </div>

        <div class="tab-panel" role="tabpanel">
          {#if activeTab === 'log'}
            <!-- autoFollow={false}: this store is pinned to one Run (the $effect
                 above); PhaseLogFeed's own Live-Mode auto-follow must not
                 redirect it to the default queue's in-flight task. -->
            <PhaseLogFeed
              {snapshot}
              store={phaseLogStore}
              autoFollow={false}
              {liveTarget}
            />
          {:else if activeTab === 'outputs'}
            <RunOutputs {outputs} />
          {:else}
            <!-- FR-R3-008 (T380) — the same two questions the live feed answers from
                 memory, answered from the persisted record so they survive a window
                 reload. Both read `unknown` on a Run written before the feature; see
                 `run-liveness-view.ts` for why that is not zero. -->
            <dl class="run-liveness" data-testid="run-detail-liveness">
              <dt>Activity</dt>
              <dd data-testid="run-detail-last-activity" data-known={livenessView.known}>
                {livenessView.label}
                {#if livenessView.detail !== ''}
                  <span class="detail">{livenessView.detail}</span>
                {/if}
              </dd>
              <dt>Progress</dt>
              <dd data-testid="run-detail-progress" data-known={progressView.known}>
                {progressView.label}
                {#if progressView.detail !== ''}
                  <span class="detail">{progressView.detail}</span>
                {/if}
              </dd>
            </dl>
            <p class="live-feed" data-testid="run-detail-live-feed">{feedText}</p>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <!-- FR-062 — the destination resolved to nothing. Say so; the surface above
         decides whether to fall back, and this view must not look merely empty. -->
    <p class="missing" data-testid="run-detail-missing">
      This run no longer exists on {queueName}.
    </p>
  {/if}
</main>

<style>
  .run-detail-tier { display: flex; flex-direction: column; gap: 12px; padding: 16px 20px; height: 100%; min-height: 0; overflow: hidden; }
  .tier-header { display: flex; align-items: center; }
  .back { font: inherit; padding: 2px 0; border: 0; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; }
  .back:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }

  .run-header-block { display: flex; flex-direction: column; gap: 6px; }
  .run-header-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .run-prompt { margin: 0; font-size: 18px; font-weight: 600; color: var(--vscode-editor-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 0; }
  .header-actions { display: flex; gap: 6px; flex-shrink: 0; }

  .run-meta { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .meta-id { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; color: var(--vscode-descriptionForeground); }
  .meta-sep { color: var(--vscode-descriptionForeground); opacity: 0.5; }
  .meta-pipeline { font-size: 12px; padding: 1px 7px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-descriptionForeground) 12%, transparent); }
  .meta-status { font-size: 11px; font-weight: 600; text-transform: uppercase; padding: 1px 8px; border-radius: 4px; }
  /* Same status-to-token mapping the Queue Detail rows use, so one status
     reads the same colour in both tiers. FR-021 — theme variables only. */
  .meta-status.status-in-flight { background: color-mix(in srgb, var(--schegent-color-active) 18%, transparent); color: var(--schegent-color-active); }
  .meta-status.status-completed { background: color-mix(in srgb, var(--schegent-color-completed) 18%, transparent); color: var(--schegent-color-completed); }
  .meta-status.status-pending { background: transparent; color: var(--vscode-descriptionForeground); }
  .meta-status.status-paused { background: color-mix(in srgb, var(--schegent-color-warning) 18%, transparent); color: var(--schegent-color-warning); }
  .meta-status.status-failed { background: color-mix(in srgb, var(--schegent-color-error) 18%, transparent); color: var(--schegent-color-error); }
  .meta-status.status-canceled { background: transparent; color: var(--vscode-descriptionForeground); opacity: 0.7; }
  .meta-elapsed, .meta-phase-of, .meta-iteration { font-variant-numeric: tabular-nums; }

  .run-columns { display: flex; gap: 0; flex: 1 1 0; min-height: 0; overflow: hidden; }
  .run-left-panel { flex: 0 0 260px; border-right: 1px solid var(--schegent-divider, color-mix(in srgb, var(--vscode-descriptionForeground) 15%, transparent)); padding-right: 14px; overflow-y: auto; }
  .run-right-panel { flex: 1 1 0; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }

  .tab-bar { display: flex; align-items: center; gap: 0; border-bottom: 1px solid var(--schegent-divider, color-mix(in srgb, var(--vscode-descriptionForeground) 15%, transparent)); padding-left: 14px; flex-shrink: 0; }
  .tab-btn { font: inherit; font-size: 12px; padding: 8px 14px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; white-space: nowrap; }
  .tab-btn:hover { color: var(--vscode-editor-foreground); }
  .tab-btn.active { color: var(--vscode-editor-foreground); border-bottom-color: var(--vscode-focusBorder); }

  .streaming-badge { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; color: var(--schegent-color-active); padding-right: 8px; }
  .streaming-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--schegent-color-active); animation: pulse-stream 1.8s ease-in-out infinite; }
  @keyframes pulse-stream {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(1.3); }
  }

  .tab-panel { flex: 1 1 0; min-height: 0; overflow-y: auto; padding-left: 14px; padding-top: 8px; height: 100%; }

  .run-liveness { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 0; font-size: 12px; }
  .run-liveness dt { color: var(--vscode-descriptionForeground); text-transform: uppercase; font-size: 11px; }
  .run-liveness dd { margin: 0; color: var(--vscode-editor-foreground); overflow-wrap: anywhere; }
  .run-liveness dd[data-known='false'] { color: var(--vscode-descriptionForeground); font-style: italic; }
  .run-liveness .detail { color: var(--vscode-descriptionForeground); }
  .live-feed { margin: 12px 0 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .missing { margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
</style>
