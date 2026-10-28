/**
 * FR-R4-F14 (feature 242, contract V2, D2) — which failure cause a `fail` decision carries.
 *
 * Pure module. No `vscode` import, no I/O. It takes closed facts only: the transition's halt cause
 * (compared by identity, never parsed), whether a fatal signature matched (a boolean: the signature's
 * text stays where it is, and never reaches a record through here), the phase outcome and the
 * termination reason. It never sees a message, a warning or an audit block, so nothing the agent wrote
 * can become a cause.
 *
 * PRECEDENCE, first match wins (D2):
 *   1. the transition's own halt cause, when it is one of the three the vocabulary names;
 *   2. a matched fatal signature;
 *   3. a timeout, or the absolute invocation deadline (P1: the runner reports the deadline as a
 *      `failed` outcome with `terminationReason: 'deadline'`, and an operator reads it as a timeout);
 *   4. otherwise `phase_failed`.
 *
 * A transition cause beats a fatal match because the transition has already decided the Run's fate
 * for a reason the operator can act on (the cap, the last phase's open issues); the fatal match is
 * still in the row's last error. A fatal match beats a timeout because the signature names the
 * failure and the timeout is only how it ended. A halt cause from another vocabulary (a `phase-end`
 * cause such as `pre_spawn_refusal`, or a pause cause such as `rate_limit`) is not a member, so it
 * falls through to `phase_failed`.
 */
import { CAP_EXHAUSTED_CAUSE } from '../audit/audit-payload';
import type { FailureCause } from '../contracts/failure-cause';
import type { TerminationReason } from '../state/workflow-run';
import {
  INCOMPLETE_TURN_UNRESOLVED_CAUSE,
  LAST_PHASE_ISSUES_REMAIN_CAUSE,
  type PhaseOutcome
} from './phase';

/**
 * The six members this module can return: the ones decided at the sequencer's `fail` arm. The other
 * three are written where they are decided (the probe branch, the evidence branch and the
 * start-failure handler), so a notice for a sequencer failure never has to consider them.
 */
export type SequencerFailureCause = Extract<
  FailureCause,
  | 'cap_exhausted'
  | 'last_phase_issues_remain'
  | 'incomplete_turn_unresolved'
  | 'fatal_signature'
  | 'phase_failed'
  | 'phase_timeout'
>;

export interface FailDecisionFacts {
  /** The transition's halt cause; compared by identity with the three transition causes. */
  readonly decisionCause: string | undefined;
  /** `fatalCause !== undefined`. The signature text is never an input. */
  readonly fatalMatched: boolean;
  readonly outcome: PhaseOutcome;
  readonly terminationReason: TerminationReason;
}

export function failureCauseOf(facts: FailDecisionFacts): SequencerFailureCause {
  // Returned as the exported constants, typed as members: a drift in either spelling fails to compile.
  if (facts.decisionCause === CAP_EXHAUSTED_CAUSE) return CAP_EXHAUSTED_CAUSE;
  if (facts.decisionCause === LAST_PHASE_ISSUES_REMAIN_CAUSE) return LAST_PHASE_ISSUES_REMAIN_CAUSE;
  if (facts.decisionCause === INCOMPLETE_TURN_UNRESOLVED_CAUSE) return INCOMPLETE_TURN_UNRESOLVED_CAUSE;
  if (facts.fatalMatched) return 'fatal_signature';
  if (facts.outcome === 'timeout' || facts.terminationReason === 'deadline') return 'phase_timeout';
  return 'phase_failed';
}
