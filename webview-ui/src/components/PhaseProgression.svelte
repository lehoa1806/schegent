<script lang="ts">
  import type { ActivePipelineSummary, ActiveFeatureSummary, PhaseTile, DelayedRetryState } from '../lib/snapshot-types';
  import PhaseControlMenu from './PhaseControlMenu.svelte';
  // FR-R3-151 moved deletion to `PhaseControlMenu` (`selectedPhase`); only the copy type is used here.
  import type { DeleteConfirmationCopy } from '../lib/deletion-confirmation';
  import { formatDuration } from '../lib/format-duration';
  import { pauseBadgeLabel, type PauseBadgeCause } from '../lib/pause-labels';
  import { phaseProgressionHeader } from '../lib/phase-progression-header';

  interface Props {
    phases: readonly PhaseTile[];
    activeFeature?: ActiveFeatureSummary | null;
    activePipeline?: ActivePipelineSummary | null;
    activeTaskId?: string | null;
    activeRunId?: string | null;
    /** Feature 093 (FR-018 / T080) — the queue whose Run these phases belong to. */
    queueId: string;
    targetsSubjectRun: boolean; // Off-target guard — `PhaseControlMenu` documents it.
    subjectTaskFailed?: boolean; // FR-R4-F20 — passed to the menu, whose Skip tooltip reads it.
    isPrimary?: boolean;
    manualPauseAt?: string | null;
    // Verbatim from the host's `ManualPauseCause`; declared beside the label it drives.
    manualPauseCause?: PauseBadgeCause;
    phaseOverrides?: readonly { readonly phaseId: string; readonly action: 'skipped' | 'disabled' | 'removed' }[];
    phaseBreakpoints?: readonly { readonly phaseId: string; readonly setAt: string; readonly actor: 'operator' | 'system' }[];
    resumeTargetPhaseId?: string | null;
    delayedRetry?: DelayedRetryState;
    selectedPhaseId?: string | null;
    onSelectPhase?: (phaseId: string) => void;
    onRequestConfirm?: (copy: DeleteConfirmationCopy, onConfirm: () => void) => void;
  }

  // `activeFeature` is preserved on the Props surface for call-site
  // backward compatibility but is no longer read — feature 016 sources
  // the header parenthetical from `activeTaskId` (queue.inFlight?.id).
  const {
    phases, activeFeature: _activeFeature = null, // discarded; see note above
    activePipeline = null,
    activeTaskId = null,
    activeRunId = null,
    queueId,
    targetsSubjectRun,
    subjectTaskFailed = false,
    isPrimary = true,
    manualPauseAt = null,
    manualPauseCause = null,
    phaseOverrides = [],
    phaseBreakpoints = [],
    resumeTargetPhaseId = null,
    delayedRetry,
    selectedPhaseId = null,
    onSelectPhase,
    onRequestConfirm
  }: Props = $props();

  const LARGE_PIPELINE_THRESHOLD = 10;

  const pauseBadgeText = $derived(pauseBadgeLabel(manualPauseCause));

  const headerText = $derived(phaseProgressionHeader(activeTaskId, activePipeline));

  const isLargePipeline = $derived(phases.length >= LARGE_PIPELINE_THRESHOLD);
  // Resolved once, not re-found inline per field the header menu reads off it.
  const selectedTile = $derived(phases.find((p) => p.name === selectedPhaseId) ?? null);
  const activePhase = $derived(phases.find((phase) => phase.state === 'active')?.name ?? null);
  // Drives the countdown badge below and the header menu's Retry now control.
  const isWaitingRetry = $derived(delayedRetry?.pendingRetryAt != null);

  // Feature 028 US3 — set of phase ids carrying a future-phase
  // breakpoint. The dashboard renders an outlined-orange indicator on
  // each such pending tile.
  const breakpointPhaseIds = $derived(
    new Set(phaseBreakpoints.map((bp) => bp.phaseId))
  );

  // Feature 028 US3 — three-way indicator state per tile.
  //  - 'paused-active'        active phase, manualPauseCause === 'operator-paused'
  //  - 'breakpoint-fired'     active phase, manualPauseCause === 'breakpoint-paused' AND resumeTargetPhaseId matches
  //  - 'breakpoint-scheduled' pending tile with an entry in phaseBreakpoints
  //  - null                   no breakpoint-related indicator
  function indicatorState(
    phaseName: string,
    state: PhaseTile['state']
  ): 'paused-active' | 'breakpoint-fired' | 'breakpoint-scheduled' | null {
    if (state === 'active' && manualPauseAt !== null) {
      if (manualPauseCause === 'breakpoint-paused' && resumeTargetPhaseId === phaseName) {
        return 'breakpoint-fired';
      }
      if (manualPauseCause === 'operator-paused') return 'paused-active';
    }
    if (state !== 'active' && state !== 'completed' && breakpointPhaseIds.has(phaseName)) {
      return 'breakpoint-scheduled';
    }
    return null;
  }

  let nowMs = $state(Date.now());
  
  $effect(() => {
    if (!isWaitingRetry) return;
    const timer = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  const retryDeadlineMs = $derived(
    delayedRetry?.pendingRetryAt ? Date.parse(delayedRetry.pendingRetryAt) : null
  );
  
  const retryCountdownSec = $derived(
    retryDeadlineMs !== null
      ? Math.max(0, Math.floor((retryDeadlineMs - nowMs) / 1000))
      : 0
  );

</script>

<section
  class="phase-progression-zone"
  data-testid="dashboard-phase-progression"
  aria-label="Phase progression"
>
  <header class="phase-header">
    <div class="phase-title">
      <div class="zone-title" aria-hidden="true">Phases</div>
      <span class="visually-hidden" data-testid="dashboard-phase-progression-header">{headerText}</span>
      {#if manualPauseAt}
        <div class="chip s-warn" data-testid="phase-manual-pause-badge">
          <span class="dot" aria-hidden="true"></span>{pauseBadgeText}
        </div>
      {/if}
    </div>
    <PhaseControlMenu
      currentPhase={activePhase}
      {isPrimary}
      {activeTaskId}
      {activeRunId}
      {queueId}
      {targetsSubjectRun}
      {subjectTaskFailed}
      {manualPauseAt}
      {isWaitingRetry}
      {phaseOverrides}
      {phaseBreakpoints}
      selectedPhase={selectedPhaseId}
      selectedPhaseState={selectedTile?.state ?? null}
      selectedPhaseIsFuture={selectedTile?.isFuture ?? false}
      {onRequestConfirm}
    />
  </header>
  
  <!-- Drawn as the redesign's step list (run detail in `docs/mockup/schegent_redesign_surfaces.html`):
       a framed list, a ring in each step's status colour, the name, then its count and time. -->
  <div class="stepper-container" class:phase-progression-large={isLargePipeline} data-large-pipeline={isLargePipeline ? 'true' : 'false'} data-testid="phase-progression-list">
    {#each phases as phase, i (phase.name)}
      {@const bpState = indicatorState(phase.name, phase.state)}
      <button
        type="button"
        class="step state-{phase.state} {isWaitingRetry && phase.state === 'active' ? 'is-waiting-retry' : ''} {selectedPhaseId === phase.name ? 'selected' : ''} {bpState ? `bp-${bpState}` : ''}"
        data-testid="phase-progression-{phase.name}"
        data-state={bpState ?? phase.state}
        title="Phase: {phase.name} ({phase.state})"
        aria-current={phase.state === 'active' ? 'step' : undefined}
        aria-pressed={selectedPhaseId === phase.name ? 'true' : 'false'}
        onclick={() => onSelectPhase?.(phase.name)}
      >
        <div class="step-indicator">
          {#if bpState === 'paused-active'}
            <svg class="icon-pause" data-testid="phase-indicator-paused-active-{phase.name}" viewBox="0 0 24 24" fill="currentColor" aria-label="Phase paused"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
          {:else if bpState === 'breakpoint-fired'}
            <svg class="icon-breakpoint-fired" data-testid="phase-indicator-breakpoint-fired-{phase.name}" viewBox="0 0 24 24" fill="currentColor" aria-label="Halted at breakpoint"><circle cx="12" cy="12" r="6"/></svg>
          {:else if bpState === 'breakpoint-scheduled'}
            <svg class="icon-breakpoint-scheduled" data-testid="phase-indicator-breakpoint-scheduled-{phase.name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-label="Breakpoint armed"><circle cx="12" cy="12" r="6"/></svg>
          {:else if phase.state === 'completed'}
            <svg class="i" aria-hidden="true"><use href="#i-check"></use></svg>
          {:else if phase.state === 'active'}
            <svg class="i" aria-hidden="true"><use href="#i-dot"></use></svg>
          {:else if phase.state === 'disabled'}
            <svg class="icon-disabled" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
          {/if}
        </div>

        <div class="step-content">
          <span class="phase-name">{phase.name}</span>
          {#if phase.elapsedMs > 0}
            <span class="phase-elapsed">{formatDuration(phase.elapsedMs)}</span>
          {/if}
          {#if bpState === 'breakpoint-fired'}
            <span class="breakpoint-fired-badge" data-testid="phase-breakpoint-halted-{phase.name}">Halted</span>
          {/if}
          {#if isWaitingRetry && phase.state === 'active'}
            <span class="retry-badge" data-testid="phase-retry-badge-{phase.name}">Waiting to retry in {retryCountdownSec}s</span>
          {/if}
          {#if phase.subProgress}
            <span class="sub-progress">
              {phase.subProgress.current}/{phase.subProgress.total}
            </span>
          {/if}
          {#if phase.phaseMessage}
            <span class="phase-message-meta" data-testid="phase-message-meta-{phase.name}">
              {phase.phaseMessage.truncated
                ? `message truncated (${phase.phaseMessage.byteSize} bytes)`
                : phase.phaseMessage.invalidReason
                  ? `message invalid (${phase.phaseMessage.invalidReason})`
                  : `message ${phase.phaseMessage.entryCount} entries`}
            </span>
          {/if}
        </div>
      </button>
      
      {#if i < phases.length - 1}
        <div class="step-connector"></div>
      {/if}
    {/each}
  </div>
</section>

<style>
  .phase-progression-zone { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
  /* The title, then the controls under it: the column is too narrow to set them side by side. */
  .phase-header { display: flex; flex-direction: column; gap: var(--schegent-space-1-5); margin-bottom: var(--schegent-space-2); }
  .phase-title { display: flex; flex-wrap: wrap; align-items: center; gap: var(--schegent-space-2); }
  .zone-title { font-size: var(--schegent-text-secondary); font-weight: 600; color: var(--schegent-muted-fg); }

  /* The frame hugs its rows, so a short Workflow is not drawn in a tall empty box, and scrolls
     once the rows fill the column. */
  .stepper-container { display: flex; flex-direction: column; flex: 0 1 auto; min-height: 0; overflow-y: auto; border: 1px solid var(--schegent-border); border-radius: var(--schegent-radius); }
  .phase-progression-large { overflow-y: auto; }
  .step-connector { flex: 0 0 1px; background: var(--schegent-border); }

  .step { display: flex; align-items: center; gap: var(--schegent-space-2); flex: 0 0 auto; width: 100%; min-width: 0; min-height: 36px; padding: var(--schegent-space-2) var(--schegent-space-2-5); border: 0; border-radius: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background-color var(--schegent-duration-base) var(--schegent-ease-out); }
  .step:hover:not(.selected) { background: var(--schegent-list-hover); }
  .step:focus-visible { outline-offset: -2px; }
  .step.selected { background: var(--schegent-selection-bg); color: var(--schegent-selection-fg); box-shadow: inset 0 0 0 1px var(--schegent-selection-outline); }

  /* The ring and its glyph take the step's status colour; on the selected row, the row's text
     colour. A paused or waiting step reads as the Paused chip does. */
  .step-indicator { --sg-status-color: var(--schegent-muted-fg); display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 18px; height: 18px; border: 1.5px solid var(--sg-status-color); border-radius: 50%; color: var(--sg-status-color); }
  .state-completed .step-indicator { --sg-status-color: var(--schegent-color-completed); }
  .state-active .step-indicator, .bp-breakpoint-fired .step-indicator { --sg-status-color: var(--schegent-color-active); }
  .state-disabled .step-indicator { --sg-status-color: var(--schegent-color-disabled); }
  .bp-paused-active .step-indicator, .bp-breakpoint-scheduled .step-indicator, .is-waiting-retry .step-indicator { --sg-status-color: var(--schegent-color-warning); }
  .step.selected .step-indicator { --sg-status-color: currentColor; }
  .step-indicator svg { width: 12px; height: 12px; }
  .step-indicator svg.i { width: 11px; height: 11px; stroke-width: 2.2; }
  .icon-disabled circle { display: none; }

  .step-content { display: flex; flex: 1; flex-wrap: wrap; align-items: baseline; gap: 0 var(--schegent-space-2); min-width: 0; }
  .phase-name { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state-skipped .phase-name, .state-disabled .phase-name { color: var(--schegent-muted-fg); }
  .state-disabled .phase-name { text-decoration: line-through; }
  /* The count, then the time, at the row's end; each note takes its own line under the name. */
  .sub-progress, .phase-elapsed { order: 1; font-size: var(--schegent-text-caption); color: var(--schegent-muted-fg); font-variant-numeric: tabular-nums; }
  .phase-elapsed { order: 2; }
  .breakpoint-fired-badge, .retry-badge, .phase-message-meta { order: 3; flex-basis: 100%; font-size: var(--schegent-text-caption); color: var(--schegent-muted-fg); }
  .breakpoint-fired-badge { color: var(--schegent-status-active-text); }
  .retry-badge { color: var(--schegent-status-warning-text); }
  .step.selected .phase-name, .step.selected .sub-progress, .step.selected .phase-elapsed,
  .step.selected .breakpoint-fired-badge, .step.selected .retry-badge, .step.selected .phase-message-meta { color: inherit; }
</style>
