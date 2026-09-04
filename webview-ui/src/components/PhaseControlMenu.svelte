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
  import { phaseControlEligibility } from '../lib/phase-control-eligibility';
  import { useConfirm } from '../lib/use-confirm';
  import { correlatedLifecycle, lifecycleMessage } from '../lib/lifecycle-control-ipc';
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

  /**
   * Every "may this control be clicked" question, answered in one place.
   *
   * The predicates and their rationale live in
   * `lib/phase-control-eligibility.ts`: they are a pure function of these
   * props, and FR-R3-154's ACK reporting took this component past the
   * 500-line component budget, which is the seam that budget exists to find.
   * Reading them through one `$derived` also means the off-target guard is
   * applied by construction rather than restated per control — the shape the
   * off-target defect hid in.
   */
  const gate = $derived(
    phaseControlEligibility({
      isPrimary,
      targetsSubjectRun,
      currentPhase,
      activeTaskId,
      activeRunId,
      manualPauseAt,
      selectedPhase,
      selectedPhaseState,
      phaseOverrides,
      phaseBreakpoints
    })
  );

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

  function onSetBreakpoint(): void {
    if (!gate.showSetBreakpoint || activeRunId === null || selectedPhase === null) return;
    controlMessage = null;
    void setPhaseBreakpoint(activeRunId, selectedPhase, queueId);
  }

  function onClearBreakpoint(): void {
    if (!gate.showClearBreakpoint || activeRunId === null || selectedPhase === null) return;
    controlMessage = null;
    void clearPhaseBreakpoint(activeRunId, selectedPhase, queueId);
  }

  function aria(disabled: boolean): 'true' | 'false' {
    return disabled ? 'true' : 'false';
  }

  // FR-R3-154 (T1646) — what the host answered about the last control, as one
  // sentence, or `null` when it committed. Same shape and same `role="alert"`
  // treatment as `QueueDetailTier`'s refusal line, so a refused Pause reads the
  // way a refused Clear already does. Cleared before each dispatch: a stale
  // sentence beside a control that has since succeeded is its own lie.
  //
  // Code-review finding (iteration 5) — "each dispatch" now means each, which
  // it did not. Only the four controls that can WRITE this line cleared it, so
  // the six that cannot — Skip, Disable, Enable, Delete, and the two
  // breakpoint actions — left the previous control's answer standing. A Pause
  // refused `run-already-paused` followed by a Disable that committed rendered
  // "This Run is already paused." in a `role="alert"` beside the control that
  // had just worked, attributing one control's refusal to another's success.
  // Every dispatch below therefore clears it, whether or not it can set it.
  let controlMessage = $state<string | null>(null);

  async function onPause(): Promise<void> {
    if (gate.pauseDisabled) return;
    controlMessage = null;
    controlMessage = lifecycleMessage(await pausePhase(queueId));
  }

  let resumePromptStr = $state('');

  async function onResume(): Promise<void> {
    if (gate.resumeDisabled) return;
    controlMessage = null;
    // Captured before the `await`: `$props()` bindings are live, and the input
    // is cleared as soon as the post goes out so the operator is not left
    // looking at a prompt that has already been sent.
    const prompt = resumePromptStr.trim() || undefined;
    resumePromptStr = '';
    controlMessage = lifecycleMessage(await resumePhase(queueId, prompt));
  }

  async function onRestart(): Promise<void> {
    if (gate.restartDisabled || currentPhase === null) return;
    controlMessage = null;
    const targetPhase = currentPhase; // live-binding capture, as in `onSkip`
    controlMessage = lifecycleMessage(await restartPhase(targetPhase, queueId));
  }

  async function onSkip(event: MouseEvent): Promise<void> {
    if (gate.skipDisabled || currentPhase === null) return;
    // `$props()` bindings are live: capture before the confirm's `await`, so
    // Confirm dispatches what the dialog named, not whatever is current later.
    const targetPhase = currentPhase;
    const targetQueueId = queueId;
    const confirmed = await useConfirm('run.skip-phase', {
      originatingElement: event.currentTarget as HTMLElement,
      context: { phaseName: targetPhase }
    });
    if (!confirmed) return;
    // Cleared here rather than before the confirm: a cancelled dialog is not a
    // dispatch, and wiping the previous answer for it would hide a refusal the
    // operator had not finished reading.
    controlMessage = null;
    skipPhase(targetPhase, targetQueueId);
  }

  /**
   * The `postCommand` sits here, beside its `useConfirm`, because
   * `tests/lint/destructive-actions.lint.test.ts` requires it to — which is
   * also why retry-now is the one control absent from `lib/phase-control.ts`.
   * That module records the reason; this is the scope it was waiting for.
   */
  async function onRetryNow(event: MouseEvent): Promise<void> {
    if (gate.retryNowDisabled || !isWaitingRetry || currentPhase === null) return;
    const targetQueueId = queueId; // live-binding capture, as in `onSkip`
    const confirmed = await useConfirm('run.retry-phase-now', {
      originatingElement: event.currentTarget as HTMLElement,
      context: { phaseName: currentPhase }
    });
    if (!confirmed) return;
    controlMessage = null;
    // FR-R3-154 (T1646) — the `postCommand` stays in this scope, beside its
    // `useConfirm`, exactly as the comment above requires; it is now passed to
    // `correlatedLifecycle` as the `post` callback so the ACK is read instead
    // of discarded. `no-active-run`, `not-pending-retry` and `already-retrying`
    // are the three refusals this reached no listener for.
    controlMessage = lifecycleMessage(
      await correlatedLifecycle(
        () => postCommand(CMD_RETRY_PHASE_NOW, { queueId: targetQueueId }).correlationId
      )
    );
  }

  // FR-R3-151 (FR-010) — Disable, Enable, and Delete all target
  // `selectedPhase`, the tile the operator selected, never `currentPhase`.
  function onDisable(): void {
    if (gate.disableDisabled || selectedPhase === null) return;
    controlMessage = null;
    disablePhase(selectedPhase, queueId);
  }

  function onEnable(): void {
    if (gate.enableDisabled || selectedPhase === null) return;
    controlMessage = null;
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
    if (gate.deleteDisabled || selectedPhase === null || activeTaskId === null) return;
    // Same live-binding hazard as `onSkip`, sharper here: `onConfirm` below
    // doesn't run until the operator acts on the dialog, by which a re-render
    // could change the selection/task. Capturing both ties Confirm to what
    // the dialog described, and lets TypeScript narrow away the `!`s below.
    const targetPhase = selectedPhase;
    const targetTaskId = activeTaskId;
    const copy = phaseDeleteConfirmation(targetPhase, toDeleteConfirmationStatus(selectedPhaseState));
    if (onRequestConfirm) {
      // Cleared inside the callback, for `onSkip`'s reason: the dispatch is the
      // confirm, not the click.
      onRequestConfirm(copy, () => {
        controlMessage = null;
        removeTaskPhase(targetTaskId, targetPhase);
      });
    }
  }
</script>

<div class="phase-control-menu" data-testid="phase-control-menu">
  {#if gate.isManuallyPaused}
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
        aria-disabled={aria(gate.resumeDisabled)}
        title={controlTitle('Resume active phase')}
        onclick={onResume}
      >Resume</button>
    </div>
  {:else}
    <button
      type="button"
      data-testid="phase-control-pause"
      aria-label="Pause active phase"
      aria-disabled={aria(gate.pauseDisabled)}
      title={controlTitle('Pause active phase')}
      onclick={onPause}
    >Pause</button>
  {/if}
  {#if isWaitingRetry}
    <button
      type="button"
      data-testid="phase-control-retry-now"
      aria-label="Retry the active phase now instead of waiting out the backoff"
      aria-disabled={aria(gate.retryNowDisabled)}
      title={controlTitle('Retry now instead of waiting out the backoff')}
      onclick={onRetryNow}
    >Retry now</button>
  {/if}
  <button
    type="button"
    data-testid="phase-control-restart"
    aria-label="Restart active phase"
    aria-disabled={aria(gate.restartDisabled)}
    title={controlTitle('Restart active phase')}
    onclick={onRestart}
  >Restart</button>
  <button
    type="button"
    data-testid="phase-control-skip"
    aria-label="Skip active phase"
    aria-disabled={aria(gate.skipDisabled)}
    title={controlTitle('Skip active phase')}
    onclick={onSkip}
  >Skip</button>
  {#if gate.selectedHasOverride}
    <button
      type="button"
      data-testid="phase-control-enable"
      aria-label="Enable selected phase"
      aria-disabled={aria(gate.enableDisabled)}
      title={controlTitle('Enable selected phase')}
      onclick={onEnable}
    >Enable</button>
  {:else}
    <button
      type="button"
      data-testid="phase-control-disable"
      aria-label="Disable selected phase"
      aria-disabled={aria(gate.disableDisabled)}
      title={controlTitle('Disable selected phase')}
      onclick={onDisable}
    >Disable</button>
  {/if}
  <button
    type="button"
    class="destructive"
    data-testid="phase-control-delete"
    aria-label="Delete selected phase from pipeline"
    aria-disabled={aria(gate.deleteDisabled)}
    title="Remove the selected phase from this task's pipeline (requires confirmation)"
    onclick={onDelete}
  >Delete</button>
  {#if gate.showSetBreakpoint}
    <button
      type="button"
      data-testid="phase-control-set-breakpoint"
      aria-label="Pause pipeline when this phase is reached"
      title="Pause pipeline when this phase is reached"
      onclick={onSetBreakpoint}
    >Pause when reached</button>
  {/if}
  {#if gate.showClearBreakpoint}
    <button
      type="button"
      data-testid="phase-control-clear-breakpoint"
      aria-label="Cancel scheduled pause for this phase"
      title="Cancel scheduled pause for this phase"
      onclick={onClearBreakpoint}
    >Cancel scheduled pause</button>
  {/if}
  {#if controlMessage !== null}
    <p class="control-message" role="alert" data-testid="phase-control-message">{controlMessage}</p>
  {/if}
</div>

<style>
  .phase-control-menu {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }

  /* FR-R3-154 (T1646) — takes the whole row rather than sitting between two
     buttons: the menu is a wrapping flex row, so an inline sentence would
     reflow the controls it is reporting on. Colour matches
     `QueueDetailTier`'s `.refusal`. */
  .control-message {
    flex-basis: 100%;
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--vscode-errorForeground);
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
