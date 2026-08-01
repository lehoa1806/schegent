<script lang="ts">
  import {
    disablePhase,
    enablePhase,
    pausePhase,
    restartPhase,
    resumePhase,
    skipPhase,
    removeTaskPhase
  } from '../lib/phase-control';
  import {
    setPhaseBreakpoint,
    clearPhaseBreakpoint
  } from '../lib/phase-breakpoint-ipc';
  import { phaseDeleteConfirmation, type DeleteConfirmationCopy } from '../lib/deletion-confirmation';
  import { useConfirm } from '../lib/use-confirm';
  import type { PhaseName, PhaseTile } from '../lib/snapshot-types';

  interface Props {
    currentPhase: PhaseName | null;
    isPrimary: boolean;
    activeTaskId?: string | null;
    activeRunId?: string | null;
    manualPauseAt?: string | null;
    phaseOverrides?: readonly { readonly phaseId: string; readonly action: 'skipped' | 'disabled' | 'removed' }[];
    /**
     * Feature 028 US3 — id of the currently-selected phase tile, used as
     * the target for the breakpoint actions. When non-null and the
     * selected phase is pending (not active, not completed, not
     * overridden), the menu surfaces "Pause when reached" /
     * "Cancel scheduled pause".
     */
    selectedPhase?: PhaseName | null;
    selectedPhaseState?: PhaseTile['state'] | null;
    phaseBreakpoints?: readonly { readonly phaseId: string }[];
    onRequestConfirm?: (copy: DeleteConfirmationCopy, onConfirm: () => void) => void;
  }

  const {
    currentPhase,
    isPrimary,
    activeTaskId = null,
    activeRunId = null,
    manualPauseAt = null,
    phaseOverrides = [],
    selectedPhase = null,
    selectedPhaseState = null,
    phaseBreakpoints = [],
    onRequestConfirm
  }: Props = $props();

  const hasActivePhase = $derived(currentPhase !== null);
  const isManuallyPaused = $derived(manualPauseAt !== null);
  const pauseDisabled = $derived(!isPrimary || !hasActivePhase || isManuallyPaused);
  const resumeDisabled = $derived(!isPrimary || !hasActivePhase || !isManuallyPaused);
  const restartDisabled = $derived(!isPrimary || !hasActivePhase);
  const hasOverride = $derived(
    currentPhase !== null && phaseOverrides.some((override) => override.phaseId === currentPhase)
  );
  const overrideDisabled = $derived(!isPrimary || !hasActivePhase);
  const enableDisabled = $derived(!isPrimary || !hasActivePhase || !hasOverride);
  const deleteDisabled = $derived(!isPrimary || !hasActivePhase || activeTaskId === null);

  // Feature 028 US3 — breakpoint action visibility.
  // "Pause when reached" surfaces when:
  //   - the operator is on the primary host (gates mutation IPC),
  //   - a phase tile is selected that is pending (not active/completed/disabled),
  //   - the selected phase has no skip/disable/remove override,
  //   - the selected phase has no breakpoint already armed,
  //   - the active run id is known so the IPC can target it.
  const selectedHasOverride = $derived(
    selectedPhase !== null &&
      phaseOverrides.some((override) => override.phaseId === selectedPhase)
  );
  const selectedHasBreakpoint = $derived(
    selectedPhase !== null &&
      phaseBreakpoints.some((bp) => bp.phaseId === selectedPhase)
  );
  const selectedIsPending = $derived(
    selectedPhase !== null && selectedPhaseState === 'not-started'
  );
  const showSetBreakpoint = $derived(
    isPrimary &&
      activeRunId !== null &&
      selectedIsPending &&
      !selectedHasOverride &&
      !selectedHasBreakpoint
  );
  const showClearBreakpoint = $derived(
    isPrimary && activeRunId !== null && selectedHasBreakpoint
  );

  function onSetBreakpoint(): void {
    if (!showSetBreakpoint || activeRunId === null || selectedPhase === null) return;
    void setPhaseBreakpoint(activeRunId, selectedPhase);
  }

  function onClearBreakpoint(): void {
    if (!showClearBreakpoint || activeRunId === null || selectedPhase === null) return;
    void clearPhaseBreakpoint(activeRunId, selectedPhase);
  }

  function aria(disabled: boolean): 'true' | 'false' {
    return disabled ? 'true' : 'false';
  }

  function onPause(): void {
    if (pauseDisabled) return;
    pausePhase();
  }

  let resumePromptStr = $state('');

  function onResume(): void {
    if (resumeDisabled) return;
    resumePhase(resumePromptStr.trim() || undefined);
    resumePromptStr = '';
  }

  function onRestart(): void {
    if (restartDisabled || currentPhase === null) return;
    restartPhase(currentPhase);
  }

  async function onSkip(event: MouseEvent): Promise<void> {
    if (overrideDisabled || currentPhase === null) return;
    const confirmed = await useConfirm('run.skip-phase', {
      originatingElement: event.currentTarget as HTMLElement,
      context: { phaseName: currentPhase }
    });
    if (!confirmed) return;
    skipPhase(currentPhase);
  }

  function onDisable(): void {
    if (overrideDisabled || currentPhase === null) return;
    disablePhase(currentPhase);
  }

  function onEnable(): void {
    if (enableDisabled || currentPhase === null) return;
    enablePhase(currentPhase);
  }

  function onDelete(): void {
    if (deleteDisabled || currentPhase === null || activeTaskId === null) return;
    const copy = phaseDeleteConfirmation(currentPhase, 'active');
    if (onRequestConfirm) {
      onRequestConfirm(copy, () => removeTaskPhase(activeTaskId!, currentPhase!));
    }
  }
</script>

<div class="phase-control-menu" data-testid="phase-control-menu">
  {#if isManuallyPaused}
    <div class="resume-group">
      <input
        type="text"
        class="resume-prompt-input"
        placeholder="Custom prompt... (optional)"
        bind:value={resumePromptStr}
        onkeydown={(e) => e.key === 'Enter' && onResume()}
      />
      <button
        type="button"
        data-testid="phase-control-resume"
        aria-label="Resume active phase"
        aria-disabled={aria(resumeDisabled)}
        title="Resume active phase"
        onclick={onResume}
      >Resume</button>
    </div>
  {:else}
    <button
      type="button"
      data-testid="phase-control-pause"
      aria-label="Pause active phase"
      aria-disabled={aria(pauseDisabled)}
      title="Pause active phase"
      onclick={onPause}
    >Pause</button>
  {/if}
  <button
    type="button"
    data-testid="phase-control-restart"
    aria-label="Restart active phase"
    aria-disabled={aria(restartDisabled)}
    title="Restart active phase"
    onclick={onRestart}
  >Restart</button>
  <button
    type="button"
    data-testid="phase-control-skip"
    aria-label="Skip active phase"
    aria-disabled={aria(overrideDisabled)}
    title="Skip active phase"
    onclick={onSkip}
  >Skip</button>
  {#if hasOverride}
    <button
      type="button"
      data-testid="phase-control-enable"
      aria-label="Enable active phase"
      aria-disabled={aria(enableDisabled)}
      title="Enable active phase"
      onclick={onEnable}
    >Enable</button>
  {:else}
    <button
      type="button"
      data-testid="phase-control-disable"
      aria-label="Disable active phase"
      aria-disabled={aria(overrideDisabled)}
      title="Disable active phase"
      onclick={onDisable}
    >Disable</button>
  {/if}
  <button
    type="button"
    class="destructive"
    data-testid="phase-control-delete"
    aria-label="Delete active phase from pipeline"
    aria-disabled={aria(deleteDisabled)}
    title="Remove the active phase from this task's pipeline (requires confirmation)"
    onclick={onDelete}
  >Delete</button>
  {#if showSetBreakpoint}
    <button
      type="button"
      data-testid="phase-control-set-breakpoint"
      aria-label="Pause pipeline when this phase is reached"
      title="Pause pipeline when this phase is reached"
      onclick={onSetBreakpoint}
    >Pause when reached</button>
  {/if}
  {#if showClearBreakpoint}
    <button
      type="button"
      data-testid="phase-control-clear-breakpoint"
      aria-label="Cancel scheduled pause for this phase"
      title="Cancel scheduled pause for this phase"
      onclick={onClearBreakpoint}
    >Cancel scheduled pause</button>
  {/if}
</div>

<style>
  .phase-control-menu {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }

  button {
    min-height: 24px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: transparent;
    color: var(--schegent-muted-fg);
    font: inherit;
    padding: 0 8px;
    cursor: pointer;
    transition: transform 0.1s ease, opacity 0.1s ease;
  }

  button:active:not([aria-disabled='true']) {
    transform: scale(0.93);
    opacity: 0.8;
  }

  button:hover:not([aria-disabled='true']) {
    color: var(--schegent-fg);
    border-color: var(--schegent-color-active);
  }

  button[aria-disabled='true'] {
    opacity: 0.55;
    cursor: not-allowed;
  }

  button.destructive {
    border-color: var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-errorForeground);
  }

  button.destructive:hover:not([aria-disabled='true']) {
    color: var(--vscode-errorForeground);
    border-color: var(--vscode-inputValidation-errorBorder);
    background: color-mix(in srgb, var(--vscode-inputValidation-errorBorder) 15%, transparent);
  }

  .resume-group {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .resume-prompt-input {
    min-height: 24px;
    border: 1px solid var(--schegent-border);
    border-radius: var(--schegent-radius);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    padding: 0 8px;
    font: inherit;
    width: 200px;
    outline: none;
    transition: border-color 0.2s ease;
  }

  .resume-prompt-input:focus {
    border-color: var(--vscode-focusBorder);
  }
</style>
