// Refactor-only extraction from `components/PhaseControlMenu.svelte` (FR-R5-F19, task T029): the prop
// contract and the reasoning for each prop, moved here unchanged so the component stays under its 500-line
// budget while Disable/Enable acknowledgement state is added to it. No prop, type or default changed.
import type { DeleteConfirmationCopy } from './deletion-confirmation';
import type { PhaseName, PhaseTile } from './snapshot-types';

export interface PhaseControlMenuProps {
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
  /** FR-R4-F20 — the displayed task failed. Only Skip's tooltip reads it; a missing value is off-target text. */
  subjectTaskFailed?: boolean;
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
  /**
   * Feature 201 (FR-035) — whether the runner has yet to reach the selected
   * Phase. Fail-closed `false` default; `lib/phase-control-eligibility.ts`
   * says why it is required there and defaulted here.
   */
  selectedPhaseIsFuture?: boolean;
  phaseBreakpoints?: readonly { readonly phaseId: string }[];
  onRequestConfirm?: (copy: DeleteConfirmationCopy, onConfirm: () => void) => void;
}
