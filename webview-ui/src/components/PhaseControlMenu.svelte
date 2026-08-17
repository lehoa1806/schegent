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
    /**
     * Feature 093 (FR-018 / T080) — the queue whose Run this menu controls.
     * Every lifecycle command below is addressed with it; with N Runs in
     * flight the host has no ambient "the active Run" to fall back on and
     * refuses an unaddressed control at the IPC boundary.
     */
    queueId: string;
    /**
     * Whether the Run these controls address is the Run the surrounding
     * surface is *about*. Closes the off-target-phase-controls defect recorded
     * in `docs/features/bugs/`
     * `phase-controls-target-a-run-the-operator-is-not-viewing.md`.
     *
     * The two are not the same question, and every control below except Delete
     * is addressed by `queueId` — that is, at whichever Run the queue is
     * executing — while the phase tiles it reads (`currentPhase`,
     * `selectedPhase`) come from whatever the surface chose to display. A
     * surface showing a finished Task beside an executing one therefore had a
     * well-formed control menu pointed at a Run the operator was not looking
     * at, and the host could not refuse it: the command named a real queue with
     * a real Run on it.
     *
     * Required, not defaulted. A default of `true` is a guess that reads as
     * "correctly addressed", and the failure it admits is silent — the whole
     * defect was a surface that enabled controls it had no business enabling.
     *
     * The sole surviving wiring site, `RunDetailTier`, answers it this way,
     * at the point where it forms the address: `isExecuting`. (A second site,
     * `DashboardActivityPane`, answered it the same way via
     * `inFlightRun?.feature?.id === activeTaskId` before feature 097 removed
     * that component.) That is a comparison of two values already in
     * disagreement, not a third opinion about them — and it fails closed when
     * the queue holds no Run at all, which a display-side flag would not.
     */
    targetsSubjectRun: boolean;
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
    queueId,
    targetsSubjectRun,
    manualPauseAt = null,
    phaseOverrides = [],
    selectedPhase = null,
    selectedPhaseState = null,
    phaseBreakpoints = [],
    onRequestConfirm
  }: Props = $props();

  const hasActivePhase = $derived(currentPhase !== null);
  const isManuallyPaused = $derived(manualPauseAt !== null);
  /**
   * The conjunct every `queueId`-addressed control shares, spelled once rather
   * than repeated per control — the off-target defect was in part a shape where
   * each control restated its own precondition, so a missing conjunct was
   * invisible.
   */
  const canControlRun = $derived(isPrimary && targetsSubjectRun && hasActivePhase);
  const pauseDisabled = $derived(!canControlRun || isManuallyPaused);
  const resumeDisabled = $derived(!canControlRun || !isManuallyPaused);
  const restartDisabled = $derived(!canControlRun);
  const hasOverride = $derived(
    currentPhase !== null && phaseOverrides.some((override) => override.phaseId === currentPhase)
  );
  const overrideDisabled = $derived(!canControlRun);
  const enableDisabled = $derived(!canControlRun || !hasOverride);
  /**
   * Delete is deliberately NOT gated on `targetsSubjectRun`, and it is the one
   * control that is not: it posts `removeTaskPhase(activeTaskId, currentPhase)`
   * — a Task id and a phase drawn from the *displayed* set, both of which
   * describe the surface's own subject. It is already addressed correctly, so
   * disabling it here would remove a working capability to fix a defect it does
   * not have. The bug report proposed conjoining the guard into every
   * `*Disabled`; that over-applies, and this is the exception.
   */
  const deleteDisabled = $derived(!isPrimary || !hasActivePhase || activeTaskId === null);

  /**
   * Why a control is greyed out, when the reason is the address rather than the
   * phase. A control that fails closed without saying so reads as a broken
   * extension; this is the one state an operator cannot infer from the surface.
   */
  const OFF_TARGET_TITLE =
    'Unavailable while this view is showing a task other than the run executing on this queue.';

  function controlTitle(base: string): string {
    return targetsSubjectRun ? base : OFF_TARGET_TITLE;
  }

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
  //   - Off-target — the surface's subject is the Run `activeRunId` names. Both
  //     breakpoint actions post `activeRunId` (the executing Run) together with
  //     `selectedPhase` (a tile from the displayed set), so on a mismatched
  //     surface they arm a breakpoint on one Run at a phase named by another.
  //     Hidden rather than disabled, matching how they already behave when
  //     there is no pending phase to arm.
  const showSetBreakpoint = $derived(
    isPrimary &&
      targetsSubjectRun &&
      activeRunId !== null &&
      selectedIsPending &&
      !selectedHasOverride &&
      !selectedHasBreakpoint
  );
  const showClearBreakpoint = $derived(
    isPrimary && targetsSubjectRun && activeRunId !== null && selectedHasBreakpoint
  );

  function onSetBreakpoint(): void {
    if (!showSetBreakpoint || activeRunId === null || selectedPhase === null) return;
    void setPhaseBreakpoint(activeRunId, selectedPhase, queueId);
  }

  function onClearBreakpoint(): void {
    if (!showClearBreakpoint || activeRunId === null || selectedPhase === null) return;
    void clearPhaseBreakpoint(activeRunId, selectedPhase, queueId);
  }

  function aria(disabled: boolean): 'true' | 'false' {
    return disabled ? 'true' : 'false';
  }

  function onPause(): void {
    if (pauseDisabled) return;
    pausePhase(queueId);
  }

  let resumePromptStr = $state('');

  function onResume(): void {
    if (resumeDisabled) return;
    resumePhase(queueId, resumePromptStr.trim() || undefined);
    resumePromptStr = '';
  }

  function onRestart(): void {
    if (restartDisabled || currentPhase === null) return;
    restartPhase(currentPhase, queueId);
  }

  async function onSkip(event: MouseEvent): Promise<void> {
    if (overrideDisabled || currentPhase === null) return;
    const confirmed = await useConfirm('run.skip-phase', {
      originatingElement: event.currentTarget as HTMLElement,
      context: { phaseName: currentPhase }
    });
    if (!confirmed) return;
    skipPhase(currentPhase, queueId);
  }

  function onDisable(): void {
    if (overrideDisabled || currentPhase === null) return;
    disablePhase(currentPhase, queueId);
  }

  function onEnable(): void {
    if (enableDisabled || currentPhase === null) return;
    enablePhase(currentPhase, queueId);
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
        aria-label="Resume prompt"
        placeholder="Custom prompt... (optional)"
        bind:value={resumePromptStr}
        onkeydown={(e) => e.key === 'Enter' && onResume()}
      />
      <button
        type="button"
        data-testid="phase-control-resume"
        aria-label="Resume active phase"
        aria-disabled={aria(resumeDisabled)}
        title={controlTitle('Resume active phase')}
        onclick={onResume}
      >Resume</button>
    </div>
  {:else}
    <button
      type="button"
      data-testid="phase-control-pause"
      aria-label="Pause active phase"
      aria-disabled={aria(pauseDisabled)}
      title={controlTitle('Pause active phase')}
      onclick={onPause}
    >Pause</button>
  {/if}
  <button
    type="button"
    data-testid="phase-control-restart"
    aria-label="Restart active phase"
    aria-disabled={aria(restartDisabled)}
    title={controlTitle('Restart active phase')}
    onclick={onRestart}
  >Restart</button>
  <button
    type="button"
    data-testid="phase-control-skip"
    aria-label="Skip active phase"
    aria-disabled={aria(overrideDisabled)}
    title={controlTitle('Skip active phase')}
    onclick={onSkip}
  >Skip</button>
  {#if hasOverride}
    <button
      type="button"
      data-testid="phase-control-enable"
      aria-label="Enable active phase"
      aria-disabled={aria(enableDisabled)}
      title={controlTitle('Enable active phase')}
      onclick={onEnable}
    >Enable</button>
  {:else}
    <button
      type="button"
      data-testid="phase-control-disable"
      aria-label="Disable active phase"
      aria-disabled={aria(overrideDisabled)}
      title={controlTitle('Disable active phase')}
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
    color: var(--schegent-error-text);
  }

  button.destructive:hover:not([aria-disabled='true']) {
    color: var(--schegent-error-text);
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
