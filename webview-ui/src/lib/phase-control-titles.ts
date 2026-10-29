/**
 * The tooltips a disabled phase control carries, as pure functions of what the surface knows.
 *
 * Extracted from `PhaseControlMenu.svelte` (FR-R4-F20) because the menu was at the 500-line budget
 * `tests/lint/svelte-component-loc-budget.test.ts` enforces and the change had no line to spend. The
 * split follows the same seam `phase-control-eligibility.ts` was cut along: deciding what a control
 * says about itself is a question about props, while dispatching it is a question about IPC. Nothing
 * here changed in the move; the off-target text and its comment are the originals.
 */

import { lifecycleRefusalText } from './lifecycle-control-ipc';

/**
 * Why a control is greyed out, when the reason is the address rather than the
 * phase. A control that fails closed without saying so reads as a broken
 * extension; this is the one state an operator cannot infer from the surface.
 */
export const OFF_TARGET_TITLE =
  'Unavailable while this view is showing a task other than the run executing on this queue.';

export function controlTitle(base: string, targetsSubjectRun: boolean): string {
  return targetsSubjectRun ? base : OFF_TARGET_TITLE;
}

/**
 * The Skip button's title (FR-R4-F20, FR-011). On a failed task's view the control is disabled because
 * Skip of a failed Run is refused, not because the view is off target, so it says that, in the sentence
 * the host's `run-failed` refusal renders. The title and the refusal read one entry of the lifecycle
 * refusal table, so they cannot disagree. Every other case is `controlTitle`'s.
 */
export function skipControlTitle(
  base: string,
  targetsSubjectRun: boolean,
  subjectTaskFailed: boolean
): string {
  return subjectTaskFailed
    ? lifecycleRefusalText('run-failed')
    : controlTitle(base, targetsSubjectRun);
}
