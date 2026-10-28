/**
 * FR-R4-F14 (feature 242) — the closed vocabulary of why a Run failed.
 *
 * A failed Run carries ONE of these nine codes, chosen where the failure is decided and copied from
 * the Run to every record that reads it: the terminal audit event, the metrics rollup, the History
 * run detail. A member is the whole record. No message, warning, fatal-signature text or task title
 * travels with it, so what an operator reads beside it is fixed host text (`FAILURE_CAUSE_LABELS`),
 * never anything the agent wrote.
 *
 * GROWTH RULE. Append only: no member is renamed, none is removed. A later feature adds a member
 * here, and a reader built before it exists reads the member as absent. That is why every reader
 * matches by identity (`isFailureCause`) and none trims, lowercases or prefix-matches, and why
 * `validateRunInvariants` checks only that a code sits beside `failed`, not that it is a member.
 *
 * WHY THIS SITS IN `contracts/`. The webview imports the labels as values, and
 * `webview-host-import-direction.test.ts` refuses a value import from anywhere else. The module has
 * no state, no dependency and no import from outside this directory, so the host and the webview
 * cannot disagree about what a code means.
 *
 * The first three members equal the transition causes the sequencer already names
 * (`CAP_EXHAUSTED_CAUSE`, `LAST_PHASE_ISSUES_REMAIN_CAUSE`, `INCOMPLETE_TURN_UNRESOLVED_CAUSE`); the
 * D2 mapping returns those constants typed as `FailureCause`, so a drift in either spelling fails to
 * compile. `pre_spawn_refusal` is a `phase-end` cause, not a failure cause, and is not a member.
 */
export const FAILURE_CAUSES = [
  'cap_exhausted',
  'last_phase_issues_remain',
  'incomplete_turn_unresolved',
  'fatal_signature',
  'phase_failed',
  'phase_timeout',
  'runner_probe_failed',
  'audit_evidence_unavailable',
  'start_failed'
] as const;

export type FailureCause = (typeof FAILURE_CAUSES)[number];

/**
 * Membership by identity: true only for a string equal to one of the nine members.
 *
 * A near miss (`'cap_exhausted '`, `'CAP_EXHAUSTED'`, `'phase_failed:x'`), a non-string and a cause
 * from another vocabulary are all refused, so a reader that meets a value it does not know treats
 * the cause as absent.
 */
export function isFailureCause(value: unknown): value is FailureCause {
  return typeof value === 'string' && (FAILURE_CAUSES as readonly string[]).includes(value);
}

/**
 * The fixed label of each member: what the status bar shows, and what History's run detail shows
 * beside the code as `{label} ({code})`. Host text only, and none contains its own code.
 */
export const FAILURE_CAUSE_LABELS: Readonly<Record<FailureCause, string>> = {
  cap_exhausted: 'Iteration cap reached',
  last_phase_issues_remain: 'Last phase ended with issues open',
  incomplete_turn_unresolved: 'Phase turn left unfinished',
  fatal_signature: 'Fatal error pattern matched',
  phase_failed: 'Phase failed',
  phase_timeout: 'Phase ran out of time',
  runner_probe_failed: 'Backend CLI unavailable',
  audit_evidence_unavailable: 'Audit evidence unavailable',
  start_failed: 'Host refusal or error'
};

/** What a failed run with no recorded code reads as: every Run that failed before this feature. */
export const FAILURE_CAUSE_NOT_RECORDED = 'Cause not recorded';
