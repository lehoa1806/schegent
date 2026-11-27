import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { CAP_EXHAUSTED_CAUSE, PhaseEndOutcome } from '../audit/audit-payload';
import type { TerminationReason } from '../state/workflow-run';
import type { PhaseDef } from '../config/pipeline-config';

/**
 * FR-R3-172 (FR-013, FR-015, T1744) — the one spelling of a termination reason
 * in this tree that is NOT a `TerminationReason`, written once so the divergence
 * has a single place to be read, cited and eventually retired.
 *
 * THE VALUE CANNOT BE RENAMED, which is why the exception exists rather than
 * being fixed. `cap-exhausted` is already on disk in every audit log that has
 * recorded a cap exhaustion, it is pinned in both directions by a unit test over
 * `PhaseRunner.appendCapExhaustedPhaseEnd()`, and an operator recipe greps for
 * it. Renaming it to `cap_exhausted` would make the two spellings in one record
 * agree and make every historical record unreadable by the recipe that reads
 * them — a worse trade than one named exception.
 *
 * WHY THIS IS A SEPARATE MODULE rather than two declarations in
 * `phase-runner.ts`, where its only consumer is: that file sits at its LoC
 * budget with the zero margin `tests/lint/phase-runner-loc-budget.test.ts` keeps
 * by convention, and the response that gate names is the one three recorder
 * modules already took out of the same file. The argument below is the point of
 * the change, so trimming it to fit would have spent the change to save it.
 */
export const CAP_EXHAUSTED_TERMINATION_REASON = 'cap-exhausted';

/**
 * FR-R3-172 (FR-013, T1744) — the closed payload for the cap-exhaustion
 * `phase-end`, replacing the `Record<string, unknown>` this value escaped
 * through.
 *
 * That seam is how a non-member reached a persisted row at all: nothing in the
 * type system could see that the string was not in the vocabulary, so the
 * divergence was discoverable only by reading the two spellings side by side in
 * one audit record. This type admits `TerminationReason` plus the constant above
 * and nothing else, so the NEXT non-member cannot leave the same way — it has to
 * be named here, in the open, where it can be argued about.
 *
 * FR-015 holds, and is the reason this is a union and not a widening:
 * `TerminationReason` itself is untouched and still closed, and
 * `CAP_EXHAUSTED_TERMINATION_REASON` is deliberately not a member of it. The
 * alternative — typing the field `string` so the seam compiles — is the
 * prohibited repair, because it readmits every future non-member silently.
 *
 * A type alias, not an interface, deliberately: `AuditEntry.payload` is
 * `Record<string, unknown>`, and only an alias picks up the implicit index
 * signature that makes this assignable to it. An interface here would compile
 * only by being cast at the call site, which is the seam again.
 */
export type CapExhaustedPhaseEndPayload = {
  readonly pipelineId?: string;
  readonly phaseId: string;
  readonly runner: BackendRunnerKind;
  readonly outcome: PhaseEndOutcome;
  readonly terminationReason: TerminationReason | typeof CAP_EXHAUSTED_TERMINATION_REASON;
  readonly cause: typeof CAP_EXHAUSTED_CAUSE;
  readonly exitCode: number | null;
  readonly model?: PhaseDef['model'];
  readonly effort?: PhaseDef['effort'];
  readonly timeoutMs?: number;
};
