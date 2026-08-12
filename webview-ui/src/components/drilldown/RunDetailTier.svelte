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
  import { findQueueRuntime } from '../../lib/queue-runtime-view';
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

  const inFlightRun = $derived(runtime?.inFlightRun ?? null);
  // The feed belongs to this Run only while this Run is the one executing. A
  // pending Task's detail view reports idle rather than borrowing the reading of
  // whichever Run the queue happens to be working.
  const isExecuting = $derived(inFlightRun !== null && inFlightRun.feature?.id === runId);
  const liveActivity = $derived(isExecuting ? inFlightRun?.liveActivity ?? null : null);
  const feedText = $derived(
    liveActivity === null
      ? 'idle'
      : `${liveActivity.summary ?? 'idle'} — ${liveActivity.freshness}`
  );

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
    <section class="run-body">
      <h1 class="run-prompt" data-testid="run-detail-prompt">{task.label}</h1>
      <p class="live-feed" data-testid="run-detail-live-feed">{feedText}</p>

      {#if isPrimary}
        <div class="controls" data-testid="run-detail-controls">
          <QueueItemActions item={task} {isPrimary} />
        </div>
      {/if}

      <PhaseProgression
        phases={runtime?.phases ?? []}
        activeTaskId={isExecuting ? runId : null}
        activeRunId={isExecuting ? inFlightRun?.runId ?? null : null}
        {isPrimary}
        manualPauseAt={runtime?.manualPause?.at ?? null}
        manualPauseCause={runtime?.manualPause?.cause ?? null}
        phaseOverrides={runtime?.phaseOverrides ?? []}
        phaseBreakpoints={runtime?.phaseBreakpoints ?? []}
        resumeTargetPhaseId={inFlightRun?.resumeTargetPhaseId ?? null}
      />
    </section>
  {:else}
    <!-- FR-062 — the destination resolved to nothing. Say so; the surface above
         decides whether to fall back, and this view must not look merely empty. -->
    <p class="missing" data-testid="run-detail-missing">
      This run no longer exists on {queueName}.
    </p>
  {/if}
</main>

<style>
  .run-detail-tier {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px 20px;
    min-height: 0;
    overflow-y: auto;
  }

  .tier-header {
    display: flex;
    align-items: center;
  }

  .back {
    font: inherit;
    padding: 2px 0;
    border: 0;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
  }

  .back:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }

  .run-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }

  .run-prompt {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: var(--vscode-editor-foreground);
    overflow-wrap: anywhere;
  }

  .live-feed {
    margin: 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .controls {
    display: flex;
  }

  .missing {
    margin: 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }
</style>
