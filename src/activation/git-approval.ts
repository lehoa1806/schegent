// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Returns a requester. The modal is shown and the decision recorded when a Run
// asks, and no Run starts in an untrusted window.

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

import { errorMessage } from '../lib/errors';
import type { SanitizedLogger } from '../lib/logger';
import type { MutationPlanSnapshot } from '../state/workflow-run';

/** The affirmative action. Anything else — including dismissal — denies. */
export const GIT_APPROVAL_APPROVE_LABEL = 'Approve This Run';

/**
 * FR-R3-146 (FR-007) — the durable affirmative action.
 *
 * The label says both things that bound the grant: *this plan* — the fingerprint,
 * so an edited pipeline asks again — and *here*, this workspace, so another
 * repository asks. A label reading "Don't Ask Again" would claim more than the
 * grant does, and a consent surface that overstates itself is the rubber stamp
 * this module was written to replace.
 */
export const GIT_APPROVAL_PERSIST_LABEL = 'Always Approve This Plan Here';

/**
 * What the operator decided. Three outcomes, not two: `'this-run'` and
 * `'persist'` both approve, and only the second is written anywhere.
 *
 * Returned instead of a boolean so this module stays a pure decision. It has no
 * store, no memento and no idea where a grant would be kept; the caller in
 * `run-safety-wiring.ts` owns that, and `workflow-run-factory.ts` still sees the
 * `Promise<boolean>` it always did.
 */
export type GitApprovalDecision = 'this-run' | 'persist' | 'denied';

/**
 * Shows a blocking modal and resolves to the chosen action label, or
 * `undefined` when the operator dismissed it without choosing.
 */
export type ModalConfirm = (
  message: string,
  detail: string,
  approveLabel: string
) => Promise<string | undefined>;

/**
 * The same seam with more than one affirmative action.
 *
 * The actions arrive as an array rather than as rest parameters so a caller
 * offering one action stays assignable to a caller offering two; a variadic
 * signature makes arity part of the contract, and it is not.
 */
export type ModalChoice = (
  message: string,
  detail: string,
  actions: readonly string[]
) => Promise<string | undefined>;

export function createGitApprovalRequester(deps: {
  readonly confirm: ModalChoice;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
}): (plan: MutationPlanSnapshot) => Promise<GitApprovalDecision> {
  return async (plan: MutationPlanSnapshot): Promise<GitApprovalDecision> => {
    const phaseCount = plan.gitCapablePhaseIds.length;
    const message =
      `Schegent can change Git state in ${phaseCount} phase(s) of this run.`;
    const detail = [
      `Phases: ${plan.gitCapablePhaseIds.join(', ')}`,
      `Mutation plan: ${plan.fingerprint}`,
      '',
      'These phases may stage, commit, or change branches in this workspace.',
      'Approval covers only this exact plan.',
      // FR-R3-146 (FR-007) — a modal offering a durable grant has to say what
      // durable means, in the same place the operator reads what they are
      // approving. Both bounds are named: the plan, and this workspace.
      `"${GIT_APPROVAL_PERSIST_LABEL}" remembers this plan for this workspace only. ` +
        'Editing the pipeline changes the plan and asks again.'
    ].join('\n');

    let choice: string | undefined;
    try {
      choice = await deps.confirm(message, detail, [
        GIT_APPROVAL_APPROVE_LABEL,
        GIT_APPROVAL_PERSIST_LABEL
      ]);
    } catch (error) {
      // No UI host, or the dialog failed. An unanswerable prompt is a denial:
      // the alternative is granting mutation rights because nobody could be
      // asked, which is the defect this module replaced.
      // Via `errorMessage`, not a cast to Error: a host that rejects with a string
      // or a plain object would otherwise put "undefined" in front of an operator
      // who has to tell a broken dialog apart from a refusal they made.
      deps.logger.warn(
        `pipeline.git-approval unavailable fingerprint=${plan.fingerprint} ` +
          `reason=${errorMessage(error)}`
      );
      return 'denied';
    }

    // Only the two explicit labels approve. Cancel, dismissal and any string the
    // host invents fall through to a denial — the property that makes closing
    // the dialog safe rather than silently permissive.
    const decision: GitApprovalDecision =
      choice === GIT_APPROVAL_PERSIST_LABEL
        ? 'persist'
        : choice === GIT_APPROVAL_APPROVE_LABEL
          ? 'this-run'
          : 'denied';
    deps.logger.info(
      `pipeline.git-approval ${decision === 'denied' ? 'denied' : 'granted'} ` +
        `scope=${decision} fingerprint=${plan.fingerprint} phases=${phaseCount}`
    );
    return decision;
  };
}

/**
 * FR-R3-146 (FR-006, FR-007) — the requester above, with the durable grant in
 * front of it and behind it.
 *
 * This is what `workflow-run-factory.ts` and `workflow-controller.ts` actually
 * call: they take `(plan) => Promise<boolean>` and are untouched by this feature
 * (plan A6). The three-way decision stays inside.
 *
 * The store arrives as two plain functions rather than as a `WorkspaceStateStore`,
 * for the reason this module's header gives about the dialog: the decision has to
 * be testable without a VS Code host, and a module that reached into a memento to
 * record its own answer would give that up. `run-safety-wiring.ts` owns both,
 * supplies both, and is where the record's identity lives (plan A7).
 *
 * `isGranted` is called **per consultation** — the caller passes a thunk over the
 * live store, not a captured map. An operator who clears state mid-session means
 * it, which is the rule `run-safety-wiring.ts:129-131` already states for the
 * spend bound.
 */
export function createPersistentGitApproval(deps: {
  readonly request: (plan: MutationPlanSnapshot) => Promise<GitApprovalDecision>;
  readonly isGranted: (fingerprint: string) => boolean;
  readonly persist: (plan: MutationPlanSnapshot) => Promise<void>;
  readonly logger: Pick<SanitizedLogger, 'info' | 'warn'>;
}): (plan: MutationPlanSnapshot) => Promise<boolean> {
  return async (plan: MutationPlanSnapshot): Promise<boolean> => {
    // The skip, and the whole point of the record: the second task of a drain
    // reaches this line and no modal is constructed. Consent was already given
    // for this exact plan, in this workspace, by this operator.
    if (deps.isGranted(plan.fingerprint)) {
      deps.logger.info(
        `pipeline.git-approval granted scope=stored fingerprint=${plan.fingerprint}`
      );
      return true;
    }

    const decision = await deps.request(plan);
    if (decision === 'denied') return false;
    if (decision === 'this-run') return true;

    try {
      await deps.persist(plan);
    } catch (error) {
      // A failed write does not deny an approved run. The operator answered, and
      // the answer covers this run whether or not it could be recorded; the next
      // run asks again, which is the fail-closed direction for a grant that was
      // never stored.
      deps.logger.warn(
        `pipeline.git-approval grant-not-recorded fingerprint=${plan.fingerprint} ` +
          `reason=${errorMessage(error)}`
      );
    }
    return true;
  };
}
