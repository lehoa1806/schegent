<script lang="ts">
  import type { ActivePipelineSummary, ActiveFeatureSummary, PhaseTile, DelayedRetryState } from '../lib/snapshot-types';
  import PhaseControlMenu from './PhaseControlMenu.svelte';
  import { phaseDeleteConfirmation, type DeleteConfirmationCopy } from '../lib/deletion-confirmation';
  import { removeTaskPhase } from '../lib/phase-control';

  interface Props {
    phases: readonly PhaseTile[];
    activeFeature?: ActiveFeatureSummary | null;
    activePipeline?: ActivePipelineSummary | null;
    activeTaskId?: string | null;
    activeRunId?: string | null;
    isPrimary?: boolean;
    manualPauseAt?: string | null;
    manualPauseCause?:
      | 'operator-paused'
      | 'queue-paused-mid-run'
      | 'breakpoint-paused'
      | null;
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
    phases,
    activePipeline = null,
    activeTaskId = null,
    activeRunId = null,
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

  const headerText = $derived(
    (() => {
      const pipelineSuffix =
        activePipeline && activePipeline.id !== 'standard'
          ? ` — Pipeline: ${activePipeline.name}`
          : '';
      const base = activeTaskId
        ? `Phase Progression (Active: ${activeTaskId})`
        : 'Phase Progression';
      return `${base}${pipelineSuffix}`;
    })()
  );

  const isLargePipeline = $derived(phases.length >= LARGE_PIPELINE_THRESHOLD);
  const activePhase = $derived(phases.find((phase) => phase.state === 'active')?.name ?? null);
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
    <div>
      <div class="zone-title" data-testid="dashboard-phase-progression-header">{headerText}</div>
      {#if manualPauseAt}
        <div class="manual-pause-badge" data-testid="phase-manual-pause-badge">
          {manualPauseCause === 'queue-paused-mid-run' ? 'Queue paused' : 'Phase paused'}
        </div>
      {/if}
    </div>
    <PhaseControlMenu
      currentPhase={activePhase}
      {isPrimary}
      {activeTaskId}
      {activeRunId}
      {manualPauseAt}
      {phaseOverrides}
      {phaseBreakpoints}
      selectedPhase={selectedPhaseId}
      selectedPhaseState={selectedPhaseId
        ? phases.find((p) => p.name === selectedPhaseId)?.state ?? null
        : null}
      {onRequestConfirm}
    />
  </header>
  
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
            <svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
          {:else if phase.state === 'active'}
            <div class="pulse-ring"></div>
            <div class="pulse-core"></div>
          {:else if phase.state === 'disabled'}
            <svg class="icon-disabled" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg>
          {:else}
            <div class="pending-dot"></div>
          {/if}
        </div>

        <div class="step-content">
          <span class="phase-name">{phase.name}</span>
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
  .phase-progression-zone {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .zone-title {
    font-size: 0.9em;
    font-weight: 600;
    color: var(--schegent-muted-fg);
    margin: 0 0 var(--schegent-gap) 0;
    letter-spacing: 0.05em;
  }
  .phase-header {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: flex-start;
    margin-bottom: var(--schegent-gap);
  }
  .phase-header .zone-title {
    margin-bottom: 4px;
  }
  .manual-pause-badge {
    display: inline-flex;
    align-items: center;
    min-height: 20px;
    padding: 0 6px;
    border: 1px solid var(--schegent-color-active);
    border-radius: 4px;
    color: var(--schegent-color-active);
    font-size: 0.72em;
    font-weight: 600;
  }
  .phase-message-meta {
    display: block;
    margin-top: 2px;
    color: var(--schegent-muted-fg);
    font-size: 0.72em;
  }
  
  .stepper-container {
    display: flex;
    align-items: flex-start;
    padding: 16px 8px;
    gap: 8px;
    overflow-x: auto;
  }
  .phase-progression-large {
    flex-wrap: wrap;
    overflow-y: auto;
  }
  
  .step {
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    font: inherit;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    min-width: 64px;
    position: relative;
    z-index: 1;
    cursor: pointer;
    border-radius: var(--schegent-radius);
    padding: 6px 4px 8px;
    transition: background 0.2s ease, border-color 0.2s ease;
  }
  .step:hover,
  .step:focus-visible {
    border-color: var(--schegent-border);
    outline: none;
    background: color-mix(in srgb, var(--vscode-list-hoverBackground) 50%, transparent);
  }
  .step.selected {
    border-color: transparent;
    background: color-mix(in srgb, var(--schegent-color-active) 12%, transparent);
  }
  .step.selected:hover,
  .step.selected:focus-visible {
    background: color-mix(in srgb, var(--schegent-color-active) 18%, transparent);
  }
  .step.selected .phase-name {
    color: var(--schegent-color-active);
    font-weight: 600;
  }
  
  .step-indicator {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--schegent-bg);
    border: 2px solid var(--schegent-border);
    position: relative;
    transition:
      background-color 180ms ease-out,
      border-color 180ms ease-out,
      color 180ms ease-out;
  }
  
  .state-completed .step-indicator {
    background: transparent;
    border-color: var(--schegent-color-completed);
    color: var(--schegent-color-completed);
  }
  .icon-check {
    width: 14px;
    height: 14px;
  }
  
  .state-active .step-indicator {
    border-color: var(--schegent-color-active);
    background: color-mix(in srgb, var(--schegent-color-active) 12%, var(--schegent-bg));
  }
  .pulse-ring {
    position: absolute;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    border: 2px solid var(--schegent-color-active);
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }
  .pulse-core {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--schegent-color-active);
  }
  
  .state-not-started .step-indicator,
  .state-skipped .step-indicator {
    border-color: var(--vscode-list-hoverBackground);
  }
  .pending-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--vscode-list-activeSelectionBackground);
    transition: background 0.3s ease;
  }
  .state-skipped {
    opacity: 0.4;
  }
  .state-disabled .step-indicator {
    border-color: var(--schegent-color-disabled);
    background: color-mix(in srgb, var(--schegent-color-disabled) 8%, transparent);
  }
  .icon-disabled {
    width: 14px;
    height: 14px;
    color: var(--schegent-color-disabled);
  }
  .state-disabled .phase-name {
    color: var(--schegent-color-disabled);
    text-decoration: line-through;
    opacity: 0.7;
  }
  .state-disabled {
    opacity: 0.65;
  }
  
  .step-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .phase-name {
    font-size: 0.8em;
    font-weight: 500;
    color: var(--schegent-muted-fg);
    white-space: nowrap;
    transition: color 0.3s;
  }
  .state-active .phase-name {
    color: var(--schegent-fg);
    font-weight: 600;
  }
  .state-completed .phase-name {
    color: var(--schegent-color-completed);
  }
  
  .step.bp-paused-active .step-indicator {
    border-color: var(--schegent-color-active);
    background: color-mix(in srgb, var(--schegent-color-active) 18%, transparent);
    color: var(--schegent-color-active);
  }
  .icon-pause {
    width: 14px;
    height: 14px;
  }
  .step.bp-breakpoint-scheduled .step-indicator {
    border-color: var(--schegent-color-warning);
    background: color-mix(in srgb, var(--schegent-color-warning) 10%, transparent);
    color: var(--schegent-color-warning);
  }
  .icon-breakpoint-scheduled {
    width: 16px;
    height: 16px;
  }
  .step.bp-breakpoint-fired .step-indicator {
    border-color: var(--schegent-color-active);
    background: color-mix(in srgb, var(--schegent-color-active) 25%, transparent);
    color: var(--schegent-color-active);
  }
  .icon-breakpoint-fired {
    width: 14px;
    height: 14px;
  }
  .breakpoint-fired-badge {
    font-size: 0.7em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-editor-background);
    background: var(--schegent-color-active);
    padding: 2px 6px;
    border-radius: 4px;
    margin-top: 4px;
  }

  .step.is-waiting-retry .step-indicator {
    border-color: var(--schegent-color-warning);
  }
  .step.is-waiting-retry .pulse-ring {
    border-color: var(--schegent-color-warning);
  }
  .step.is-waiting-retry .pulse-core {
    background: var(--schegent-color-warning);
  }
  .step.is-waiting-retry .phase-name {
    color: var(--schegent-color-warning);
  }
  .retry-badge {
    font-size: 0.7em;
    font-weight: 600;
    color: var(--vscode-editor-background);
    background: var(--schegent-color-warning);
    padding: 2px 6px;
    border-radius: 4px;
    margin-top: 4px;
  }
  
  .sub-progress {
    font-size: 0.7em;
    color: var(--schegent-color-active);
    background: var(--vscode-list-hoverBackground);
    padding: 2px 6px;
    border-radius: 4px;
    margin-top: 4px;
  }
  
  .step-connector {
    flex: 1;
    height: 2px;
    background: var(--schegent-divider);
    margin-top: 16px;
    min-width: 20px;
    border-radius: 1px;
  }
  
  @keyframes pulse {
    0% { transform: scale(1); opacity: 0.8; }
    100% { transform: scale(2); opacity: 0; }
  }
</style>
