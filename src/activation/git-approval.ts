// Feature 098 (SEC-02) — operator consent for Git-mutating runs.
//
// This module exists because the production wiring used to show a warning
// toast, drop the promise, and `return true` unconditionally. That is not a
// gate: the pipeline recorded a `gitApprovalReceipt` naming a plan the operator
// had never agreed to, and both the Claude and Agy runners pass
// `--dangerously-skip-permissions`, so the backend would not stop to ask
// either. The documented safety gate has to be the thing that actually decides.
//
// Three properties matter and each is pinned by a test:
//
//   1. The decision is **awaited**. A fire-and-forget toast returns before the
//      operator has read it, which is what made the old code a rubber stamp.
//   2. Only the explicit approve action grants. Cancel and dismissal both deny,
//      so closing the dialog is safe rather than silently permissive.
//   3. The prompt names the **exact** mutation fingerprint and phase list it is
//      binding, because the receipt written on approval is scoped to that
//      fingerprint — consent for one plan must not read as consent for another.
//
// The dialog is injected rather than imported so the decision logic is testable
// without a VS Code host; `run-safety-wiring.ts` supplies the real modal.

import type { SanitizedLogger } from '../lib/logger';
import type { MutationPlanSnapshot } from '../state/workflow-run';

/** The affirmative action. Anything else — including dismissal — denies. */
export const GIT_APPROVAL_APPROVE_LABEL = 'Approve This Run';

/**
 * Shows a blocking modal and resolves to the chosen action label, or
 * `undefined` when the operator dismissed it without choosing.
 */
export type ModalConfirm = (
  message: string,
  detail: string,
  approveLabel: string
) => Promise<string | undefined>;

export function createGitApprovalRequester(deps: {
  readonly confirm: ModalConfirm;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
}): (plan: MutationPlanSnapshot) => Promise<boolean> {
  return async (plan: MutationPlanSnapshot): Promise<boolean> => {
    const phaseCount = plan.gitCapablePhaseIds.length;
    const message =
      `Schegent can change Git state in ${phaseCount} phase(s) of this run.`;
    const detail = [
      `Phases: ${plan.gitCapablePhaseIds.join(', ')}`,
      `Mutation plan: ${plan.fingerprint}`,
      '',
      'These phases may stage, commit, or change branches in this workspace.',
      'Approval covers only this exact plan.'
    ].join('\n');

    let choice: string | undefined;
    try {
      choice = await deps.confirm(message, detail, GIT_APPROVAL_APPROVE_LABEL);
    } catch (error) {
      // No UI host, or the dialog failed. An unanswerable prompt is a denial:
      // the alternative is granting mutation rights because nobody could be
      // asked, which is the defect this module replaced.
      deps.logger.warn(
        `pipeline.git-approval unavailable fingerprint=${plan.fingerprint} ` +
          `reason=${(error as Error).message}`
      );
      return false;
    }

    const approved = choice === GIT_APPROVAL_APPROVE_LABEL;
    deps.logger.info(
      `pipeline.git-approval ${approved ? 'granted' : 'denied'} ` +
        `fingerprint=${plan.fingerprint} phases=${phaseCount}`
    );
    return approved;
  };
}
