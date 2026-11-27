/**
 * Which phase controls are eligible, as one pure function of what the surface
 * knows.
 *
 * Extracted from `PhaseControlMenu.svelte` (FR-R3-154, T1646) when reading the
 * host's ACK pushed that component past the 500-line budget
 * `tests/lint/svelte-component-loc-budget.test.ts` enforces. The split is along
 * the seam the budget exists to expose: deciding whether a control may be
 * clicked is a question about props, while dispatching it and reporting what
 * came back is a question about IPC. Nothing here changed in the move — the
 * rationale comments are the originals, because they are the reason each
 * conjunct is present and the defects they name are the reason it must stay.
 *
 * The one thing the move buys beyond the line count: these predicates are now
 * assertable without rendering. `__tests__/phase-control-eligibility.test.ts`
 * pins the off-target guard and the `disabled`-vs-`skipped` distinction
 * directly, where the component test could only observe them through an
 * `aria-disabled` attribute.
 */

// Extension-bearing (Feature 201): the paired test at
// `tests/parity/phase-control-surface-classifier-parity.test.ts` imports this
// module from the HOST program, whose `node16` resolution requires the
// extension that the webview's bundler resolution merely tolerates. The
// sibling `snapshot-types.ts` already writes its cross-tree import this way.
import type { PhaseTile } from './snapshot-types.js';

/** A phase override or breakpoint record, narrowed to the field read here. */
interface PhaseIdentified {
  readonly phaseId: string;
}

export interface PhaseControlEligibilityInput {
  readonly isPrimary: boolean;
  /**
   * Whether the Run these controls address is the Run the surrounding surface
   * is *about*. See `PhaseControlMenu`'s prop doc for why it is required
   * rather than defaulted, and for the off-target defect it closes.
   */
  readonly targetsSubjectRun: boolean;
  readonly currentPhase: string | null;
  readonly activeTaskId: string | null;
  readonly activeRunId: string | null;
  readonly manualPauseAt: string | null;
  readonly selectedPhase: string | null;
  readonly selectedPhaseState: PhaseTile['state'] | null;
  /**
   * Feature 201 (FR-035) — whether the runner has yet to reach the selected
   * Phase, read off `PhaseTile.isFuture` rather than inferred here. See
   * `enableDisabled` below for what it closes.
   *
   * **Required, not optional with a default.** A caller that omits it must not
   * compile. The tile member it comes from is optional (a snapshot may predate
   * it), so the fail-closed `?? false` belongs at the one place that reads the
   * tile — the component — and not here, where a default would silently make
   * every caller look correct. This is the strongest fail-closed this boundary
   * allows: at the component boundary, where Svelte props cannot be made to
   * fail at compile time, the same guarantee is spelled as an explicit `false`
   * default instead.
   */
  readonly selectedPhaseIsFuture: boolean;
  readonly phaseOverrides: readonly PhaseIdentified[];
  readonly phaseBreakpoints: readonly PhaseIdentified[];
}

export interface PhaseControlEligibility {
  readonly isManuallyPaused: boolean;
  readonly pauseDisabled: boolean;
  readonly resumeDisabled: boolean;
  readonly restartDisabled: boolean;
  readonly skipDisabled: boolean;
  readonly retryNowDisabled: boolean;
  readonly disableDisabled: boolean;
  readonly enableDisabled: boolean;
  readonly deleteDisabled: boolean;
  readonly selectedHasOverride: boolean;
  readonly showSetBreakpoint: boolean;
  readonly showClearBreakpoint: boolean;
}

export function phaseControlEligibility(
  input: PhaseControlEligibilityInput
): PhaseControlEligibility {
  const {
    isPrimary,
    targetsSubjectRun,
    currentPhase,
    activeTaskId,
    activeRunId,
    manualPauseAt,
    selectedPhase,
    selectedPhaseState,
    selectedPhaseIsFuture,
    phaseOverrides,
    phaseBreakpoints
  } = input;

  const hasActivePhase = currentPhase !== null;
  const isManuallyPaused = manualPauseAt !== null;

  /**
   * The conjunct every `queueId`-addressed, active-phase control shares
   * (Pause/Resume/Restart/Skip/Retry-now), spelled once rather than repeated
   * per control — the off-target defect was in part a shape where each
   * control restated its own precondition, so a missing conjunct was
   * invisible.
   */
  const canControlRun = isPrimary && targetsSubjectRun && hasActivePhase;

  /**
   * FR-R3-151 (FR-010) — Disable and Enable are queue-addressed the same way
   * Pause/Resume/Restart/Skip are (both post `queueId`), so they share the
   * same `isPrimary && targetsSubjectRun` off-target guard those controls
   * do — but they target the operator's *selected* tile, not the Run's
   * active Phase, so the third conjunct is `selectedPhase !== null` rather
   * than `hasActivePhase`. A `null` selection disables the control; it does
   * NOT fall back to `currentPhase` (that fallback was the defect FR-R3-151
   * closes).
   */
  const canControlSelected = isPrimary && targetsSubjectRun && selectedPhase !== null;

  // The button-label toggle in the template still asks "any override" — Enable
  // is still the right label for a `skipped` selection too, and
  // `showSetBreakpoint` wants "any override" as well; `enableDisabled` below is
  // the one that must be precise about which override.
  const selectedHasOverride =
    selectedPhase !== null && phaseOverrides.some((override) => override.phaseId === selectedPhase);

  // Feature 028 US3 — breakpoint action visibility.
  // "Pause when reached" surfaces when:
  //   - the operator is on the primary host (gates mutation IPC),
  //   - a phase tile is selected that is pending (not active/completed/disabled),
  //   - the selected phase has no skip/disable/remove override,
  //   - the selected phase has no breakpoint already armed,
  //   - the active run id is known so the IPC can target it.
  // (`selectedHasOverride` above already answers the third bullet.)
  const selectedHasBreakpoint =
    selectedPhase !== null && phaseBreakpoints.some((bp) => bp.phaseId === selectedPhase);
  const selectedIsPending = selectedPhase !== null && selectedPhaseState === 'not-started';

  return {
    isManuallyPaused,
    pauseDisabled: !canControlRun || isManuallyPaused,
    resumeDisabled: !canControlRun || !isManuallyPaused,
    restartDisabled: !canControlRun,
    skipDisabled: !canControlRun,
    /**
     * Shares `canControlRun` with its siblings rather than restating it. The
     * off-target conjunct is the load-bearing one: `isWaitingRetry` is read off
     * the displayed surface while `CMD_RETRY_PHASE_NOW` is addressed by
     * `queueId` alone, so without it a countdown shown for one Task would
     * shortcut the backoff of whichever Run the queue happens to be executing.
     */
    retryNowDisabled: !canControlRun,
    // FR-R3-151 (FR-005) — mirrors `decidePhaseControl`'s 'disable' branch:
    // eligible only when the selection is still future. `not-started` is the
    // projector's (T014) exact spelling of that same test.
    disableDisabled: !canControlSelected || selectedPhaseState !== 'not-started',
    // FR-R3-151 (FR-006) — mirrors `decidePhaseControl`'s 'enable' branch:
    // eligible only when future AND disabled-overridden. `disabled` is the
    // projector's exact spelling of both at once, closing the earlier "any
    // override" check that left Enable clickable — and silently refused —
    // for a stale `skipped` override.
    //
    // RESIDUAL CLOSED by Feature 201 (FR-006, FR-007) — kept here rather than
    // deleted, because the third conjunct below is unreadable without it.
    //
    // The finding (code-review, iteration 5): `state: 'disabled'` answers the
    // override half exactly but only MOSTLY answers the future half.
    // `src/ui/sidebar/phase-projector.ts` writes that word at two places: the
    // FR-012 pre-pass, for a Phase the runner has not reached, and the
    // completed-phase loop, for one it reached and bypassed (`result:
    // 'skipped'` with the override still set — that is how FR-014 tells a
    // disabled bypass from an ordinary skip). The host's `isPhaseFuture` is
    // membership in `phasesCompleted`, which the second case satisfies, so it
    // was rejected `phase-not-future` while Enable was still clickable.
    //
    // Nothing on `PhaseTile` distinguished the two: `lastResult` is
    // `mapPhaseOutcome('skipped')`, which is `null` — the same value a
    // never-reached tile carries — and comparing tile `order` against the
    // active Phase's would have made this file a second oracle for an ordering
    // the host resolves by membership, and would break outright on a pipeline
    // carrying the same Phase name at two positions. So closing it needed the
    // projection to carry the fact, a contract change rather than a predicate
    // change: `PhaseTile.isFuture` now echoes the host's `isPhaseFuture`
    // clause for clause, and `selectedPhaseIsFuture` is that fact arriving
    // here. This file still does not decide futureness; it reads it.
    //
    // The `!selectedPhaseIsFuture` conjunct is what the two `disabled` origins
    // now diverge on, and `tests/parity/phase-control-surface-classifier-parity.test.ts`
    // asks both deciders about all seven origins so the pair cannot drift apart
    // again silently.
    enableDisabled:
      !canControlSelected || selectedPhaseState !== 'disabled' || !selectedPhaseIsFuture,
    /**
     * Delete is deliberately NOT gated on `targetsSubjectRun`, and it is the
     * one control that is not: it posts
     * `removeTaskPhase(activeTaskId, selectedPhase)` — a Task id and a phase
     * drawn from the *displayed* set, both of which describe the surface's own
     * subject, and `removeTaskPhase` resolves its own queue from the Task id
     * rather than taking one, so there is no off-target Run to guard against
     * the way there is for `queueId`-addressed controls. The bug report
     * proposed conjoining the guard into every `*Disabled`; that over-applies,
     * and this is the exception. FR-R3-151 (FR-010) moves its target from
     * `currentPhase` to `selectedPhase`, unchanged otherwise.
     */
    deleteDisabled: !isPrimary || selectedPhase === null || activeTaskId === null,
    selectedHasOverride,
    showSetBreakpoint:
      isPrimary &&
      targetsSubjectRun &&
      activeRunId !== null &&
      selectedIsPending &&
      !selectedHasOverride &&
      !selectedHasBreakpoint,
    // Off-target — the surface's subject is the Run `activeRunId` names. Both
    // breakpoint actions post `activeRunId` (the executing Run) together with
    // `selectedPhase` (a tile from the displayed set), so on a mismatched
    // surface they arm a breakpoint on one Run at a phase named by another.
    // Hidden rather than disabled, matching how they already behave when there
    // is no pending phase to arm.
    showClearBreakpoint:
      isPrimary && targetsSubjectRun && activeRunId !== null && selectedHasBreakpoint
  };
}
