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
  import {
    phaseDeleteConfirmation,
    type DeleteConfirmationCopy,
    type DeleteConfirmationStatus
  } from '../lib/deletion-confirmation';
  import { useConfirm } from '../lib/use-confirm';
  import { postCommand } from '../lib/vscode-api';
  import { CMD_RETRY_PHASE_NOW } from '../lib/messages';
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
    /**
     * Whether the Run this menu addresses is counting down a delayed retry —
     * `delayedRetry.pendingRetryAt !== null`, the same fact `PhaseProgression`
     * renders as the "Waiting to retry in Ns" badge.
     *
     * It gates the *visibility* of Retry now rather than its enabled state,
     * unlike every other control here. The host answers `not-pending-retry`
     * when no backoff is armed, so a permanently-present button would be an
     * affordance whose only effect is a rejection toast; and unlike Pause or
     * Skip there is no phase for it to act on out of that window. Surfacing it
     * beside the countdown is what makes it legible: the badge says the run is
     * waiting, the button says the operator need not.
     *
     * Defaulted to `false`, and this is the one prop here that may be: absent
     * means "no countdown to shortcut", which hides the control. A missing
     * `targetsSubjectRun` defaults to nothing because its failure is silent and
     * enabling; this one fails closed by omission.
     */
    isWaitingRetry?: boolean;
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
    isWaitingRetry = false,
    phaseOverrides = [],
    selectedPhase = null,
    selectedPhaseState = null,
    phaseBreakpoints = [],
    onRequestConfirm
  }: Props = $props();

  const hasActivePhase = $derived(currentPhase !== null);
  const isManuallyPaused = $derived(manualPauseAt !== null);
  /**
   * The conjunct every `queueId`-addressed, active-phase control shares
   * (Pause/Resume/Restart/Skip/Retry-now), spelled once rather than repeated
   * per control — the off-target defect was in part a shape where each
   * control restated its own precondition, so a missing conjunct was
   * invisible.
   */
  const canControlRun = $derived(isPrimary && targetsSubjectRun && hasActivePhase);
  const pauseDisabled = $derived(!canControlRun || isManuallyPaused);
  const resumeDisabled = $derived(!canControlRun || !isManuallyPaused);
  const restartDisabled = $derived(!canControlRun);
  const skipDisabled = $derived(!canControlRun);
  /**
   * Shares `canControlRun` with its siblings rather than restating it. The
   * off-target conjunct is the load-bearing one: `isWaitingRetry` is read off
   * the displayed surface while `CMD_RETRY_PHASE_NOW` is addressed by `queueId`
   * alone, so without it a countdown shown for one Task would shortcut the
   * backoff of whichever Run the queue happens to be executing.
   */
  const retryNowDisabled = $derived(!canControlRun);

  /**
   * FR-R3-151 (FR-010) — Disable and Enable are queue-addressed the same way
   * Pause/Resume/Restart/Skip are (both post `queueId`), so they share the
   * same `isPrimary && targetsSubjectRun` off-target guard those controls
   * do — but they target the operator's *selected* tile, not the Run's
   * active Phase, so the third conjunct is `selectedPhase !== null` rather
   * than `hasActivePhase`. A `null` selection disables the control; it does
   * NOT fall back to `currentPhase` (that fallback was the defect this
   * feature closes).
   */
  const canControlSelected = $derived(isPrimary && targetsSubjectRun && selectedPhase !== null);
  // FR-R3-151 (FR-005) — mirrors `decidePhaseControl`'s 'disable' branch:
  // eligible only when the selection is still future. `not-started` is the
  // projector's (T014) exact spelling of that same test.
  const disableDisabled = $derived(!canControlSelected || selectedPhaseState !== 'not-started');
  // The button-label toggle below still asks "any override" — Enable is
  // still the right label for a `skipped` selection too, and
  // `showSetBreakpoint` wants "any override" as well; `enableDisabled` below
  // is the one that must be precise about which override.
  const selectedHasOverride = $derived(
    selectedPhase !== null && phaseOverrides.some((override) => override.phaseId === selectedPhase)
  );
  // FR-R3-151 (FR-006) — mirrors `decidePhaseControl`'s 'enable' branch:
  // eligible only when future AND disabled-overridden. `disabled` is the
  // projector's exact spelling of both at once, closing the earlier "any
  // override" check that left Enable clickable — and silently refused —
  // for a stale `skipped` override.
  const enableDisabled = $derived(!canControlSelected || selectedPhaseState !== 'disabled');
  /**
   * Delete is deliberately NOT gated on `targetsSubjectRun`, and it is the one
   * control that is not: it posts `removeTaskPhase(activeTaskId, selectedPhase)`
   * — a Task id and a phase drawn from the *displayed* set, both of which
   * describe the surface's own subject, and `removeTaskPhase` resolves its own
   * queue from the Task id rather than taking one, so there is no off-target
   * Run to guard against the way there is for `queueId`-addressed controls.
   * The bug report proposed conjoining the guard into every `*Disabled`; that
   * over-applies, and this is the exception. FR-R3-151 (FR-010) moves its
   * target from `currentPhase` to `selectedPhase`, unchanged otherwise.
   */
  const deleteDisabled = $derived(!isPrimary || selectedPhase === null || activeTaskId === null);

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
  // (`selectedHasOverride` above already answers the second bullet.)
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
    if (skipDisabled || currentPhase === null) return;
    // `$props()` bindings are live: capture before the confirm's `await`, so
    // Confirm dispatches what the dialog named, not whatever is current later.
    const targetPhase = currentPhase;
    const targetQueueId = queueId;
    const confirmed = await useConfirm('run.skip-phase', {
      originatingElement: event.currentTarget as HTMLElement,
      context: { phaseName: targetPhase }
    });
    if (!confirmed) return;
    skipPhase(targetPhase, targetQueueId);
  }

  /**
   * The `postCommand` sits here, beside its `useConfirm`, because
   * `tests/lint/destructive-actions.lint.test.ts` requires it to — which is
   * also why retry-now is the one control absent from `lib/phase-control.ts`.
   * That module records the reason; this is the scope it was waiting for.
   */
  async function onRetryNow(event: MouseEvent): Promise<void> {
    if (retryNowDisabled || !isWaitingRetry || currentPhase === null) return;
    const targetQueueId = queueId; // live-binding capture, as in `onSkip`
    const confirmed = await useConfirm('run.retry-phase-now', {
      originatingElement: event.currentTarget as HTMLElement,
      context: { phaseName: currentPhase }
    });
    if (!confirmed) return;
    postCommand(CMD_RETRY_PHASE_NOW, { queueId: targetQueueId });
  }

  // FR-R3-151 (FR-010) — Disable, Enable, and Delete all target
  // `selectedPhase`, the tile the operator selected, never `currentPhase`.
  function onDisable(): void {
    if (disableDisabled || selectedPhase === null) return;
    disablePhase(selectedPhase, queueId);
  }

  function onEnable(): void {
    if (enableDisabled || selectedPhase === null) return;
    enablePhase(selectedPhase, queueId);
  }

  /**
   * `PhaseTile['state']`'s `'not-started'` is `DeleteConfirmationStatus`'s
   * `'future'` (shared vocabulary with Task deletion); every other tile
   * state literal passes through unchanged. `null` means `PhaseProgression`
   * could not find the selected id in its current tile list (for example, a
   * stale selection surviving past its own deletion) — `'stale'` falls
   * through to the generic copy rather than misleadingly claiming "active".
   */
  function toDeleteConfirmationStatus(state: PhaseTile['state'] | null): DeleteConfirmationStatus {
    if (state === null) return 'stale';
    return state === 'not-started' ? 'future' : state;
  }

  function onDelete(): void {
    if (deleteDisabled || selectedPhase === null || activeTaskId === null) return;
    // Same live-binding hazard as `onSkip`, sharper here: `onConfirm` below
    // doesn't run until the operator acts on the dialog, by which a re-render
    // could change the selection/task. Capturing both ties Confirm to what
    // the dialog described, and lets TypeScript narrow away the `!`s below.
    const targetPhase = selectedPhase;
    const targetTaskId = activeTaskId;
    const copy = phaseDeleteConfirmation(targetPhase, toDeleteConfirmationStatus(selectedPhaseState));
    if (onRequestConfirm) {
      onRequestConfirm(copy, () => removeTaskPhase(targetTaskId, targetPhase));
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
  {#if isWaitingRetry}
    <button
      type="button"
      data-testid="phase-control-retry-now"
      aria-label="Retry the active phase now instead of waiting out the backoff"
      aria-disabled={aria(retryNowDisabled)}
      title={controlTitle('Retry now instead of waiting out the backoff')}
      onclick={onRetryNow}
    >Retry now</button>
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
    aria-disabled={aria(skipDisabled)}
    title={controlTitle('Skip active phase')}
    onclick={onSkip}
  >Skip</button>
  {#if selectedHasOverride}
    <button
      type="button"
      data-testid="phase-control-enable"
      aria-label="Enable selected phase"
      aria-disabled={aria(enableDisabled)}
      title={controlTitle('Enable selected phase')}
      onclick={onEnable}
    >Enable</button>
  {:else}
    <button
      type="button"
      data-testid="phase-control-disable"
      aria-label="Disable selected phase"
      aria-disabled={aria(disableDisabled)}
      title={controlTitle('Disable selected phase')}
      onclick={onDisable}
    >Disable</button>
  {/if}
  <button
    type="button"
    class="destructive"
    data-testid="phase-control-delete"
    aria-label="Delete selected phase from pipeline"
    aria-disabled={aria(deleteDisabled)}
    title="Remove the selected phase from this task's pipeline (requires confirmation)"
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
