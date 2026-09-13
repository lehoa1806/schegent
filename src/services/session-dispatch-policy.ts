import type { BackendRunnerKind } from '../contracts/backend-kinds';

export interface SessionDispatchInputs {
  readonly requestedContinue: boolean;
  readonly pendingSessionReuse: boolean;
  readonly resumePrompt?: string;
  readonly persistedSessionId?: string | null;
  readonly persistedSessionRunnerKind?: BackendRunnerKind;
  readonly effectiveRunnerKind: BackendRunnerKind;
}

/**
 * FR-R3-175 (FR-033, FR-034) — why a dispatch starts a fresh backend session.
 *
 * A closed union of three literals, deliberately: the type cannot carry a
 * session id, a fragment of one, or a hash of one, because there is no member
 * for a value to arrive in. V13 records that this tree logs no session ids at
 * all, and a cause that could hold one would be the first exception.
 *
 * The three members are the three different facts FR-034 names. They are not
 * three shades of one fact: `no-persisted-session-id` says the run never
 * recorded an id, `session-id-not-owned` says it recorded one that belongs to
 * another backend kind, and `continuation-not-requested` says a usable owned id
 * was sitting there and nothing asked for it.
 */
export type FreshSessionCause =
  | 'continuation-not-requested'
  | 'no-persisted-session-id'
  | 'session-id-not-owned';

export interface SessionDispatchDecision {
  readonly ownsResumeSession: boolean;
  readonly isContinue: boolean;
  readonly sessionReuse: boolean;
  readonly resumeSessionId?: string;
  readonly resumePrompt?: string;
  /**
   * FR-R3-175 (FR-034, FR-034b) — present exactly when no session is attached,
   * absent when one is. A dispatch that attaches has no fresh-session cause to
   * report, and its disposition is already on the record in `isContinue` /
   * `sessionReuse` / `resumeSessionId`; this field carries only what those three
   * lose. Optional and conditionally spread like the two fields above it, so a
   * caller asserting equality against an attaching decision sees no new key.
   */
  readonly freshSessionCause?: FreshSessionCause;
}

/*
 * FR-R3-175 (FR-032) — SHOULD AN ACTIVATION RESUME OF AN IN-FLIGHT RUN CONTINUE
 * THE CLI CONVERSATION? Recorded here because here is where the question is
 * answered; the controller holds the ingredients and the driver consumes the
 * verdict, but neither decides.
 *
 * **Decision.** It does not, and from now on it says so. A window that comes back
 * up and finds a Run that was mid-phase when the previous window died starts the
 * phase against a FRESH conversation, deliberately, and emits one line naming
 * that disposition and its cause. The behaviour is unchanged; what changes is
 * that the drop stops being silent.
 *
 * **Measurement.** `specs/213-claims-nothing-verifies/decisions.md` §M5 drove four
 * activation resumes of a persisted in-flight Run through a real store restart.
 * A Run that was mid-phase carries no pending-retry deadline (it was executing, not
 * waiting on a backoff) and no manual-pause cause (it was not paused), so both
 * triggers `shouldContinueConversation()` reads are structurally null: the
 * not-requested case is not one branch of four, it is the only branch an
 * activation resume can take. All four cases emitted the same two lines and none
 * named the session. Ownership folding and the id-logging convention are R3 /
 * V12 / V13 in that feature's `research.md`.
 *
 * **Reason.** The two costs are not the same kind of cost.
 *
 * Reusing the persisted id buys back the prior attempt's reasoning and pays for
 * it in correctness. The id names a transcript whose last turn was written by a
 * process that died mid-phase, and the resumed Run re-runs that same phase from
 * its start — so the model would meet its own truncated attempt as settled
 * history rather than as work to redo. And the precondition for reattaching
 * safely is exactly the one the liveness probe cannot establish: `RESUME_ON` in
 * `../contracts/spawn-identity.ts` admits `unrecorded` and `unanswerable`
 * alongside `dead`, on the stated grounds that refusing those would strand Runs
 * on the platforms where the mechanism is weakest. Two of the three verdicts that
 * permit a resume therefore do not establish that the previous process is gone,
 * and on those two a reattach makes this host a second writer to a transcript
 * something else may still hold.
 *
 * Dropping the conversation costs re-derivation, and that is all it costs. Every
 * artifact the dead attempt produced is on disk, the Run's `currentPhase` and
 * `currentIteration` are untouched, and each phase re-reads the feature directory
 * rather than the transcript. What is lost is tokens and wall-clock on a path
 * that has already survived a crash.
 *
 * The strongest counter-argument on record is the delayed-retry path's, and it is
 * granted rather than dismissed: a watchdog-fired retry DOES continue, because
 * there the previous invocation ended in a recorded transient failure with this
 * host still alive and still holding the session — the precondition that an
 * activation resume is missing. Same policy, different precondition, opposite
 * answer; that is the distinction the new cause field makes legible.
 *
 * **Revisit condition.** Reopen when BOTH hold: `RESUME_ON` narrows to verdicts
 * that prove the previous tree is gone, and the backend offers an attach that
 * starts from a known-complete turn rather than from whatever the transcript
 * happened to end on. Until both, continuing here would be trading a bounded cost
 * for an unbounded one.
 */

/**
 * Fail-closed session attachment policy shared by production dispatch and the
 * deterministic backend evaluation corpus. A persisted session may only be
 * attached to the backend kind that created it; the recovery prompt itself is
 * safe to send to a fresh session when ownership cannot be proven.
 */
export function resolveSessionDispatch(
  inputs: SessionDispatchInputs
): SessionDispatchDecision {
  const ownedResumeSessionId =
    inputs.persistedSessionRunnerKind === inputs.effectiveRunnerKind &&
    typeof inputs.persistedSessionId === 'string'
      ? inputs.persistedSessionId
      : undefined;
  const ownsResumeSession = ownedResumeSessionId !== undefined;
  const isContinue = inputs.requestedContinue && ownsResumeSession;
  const shouldResumeSession = isContinue || inputs.pendingSessionReuse;
  const resumeSessionId =
    shouldResumeSession && ownsResumeSession ? ownedResumeSessionId : undefined;
  const sessionReuse = inputs.pendingSessionReuse && !isContinue;
  const resumePrompt = inputs.requestedContinue ? inputs.resumePrompt : undefined;

  // FR-R3-175 (FR-034) — the cause is decided here because here is the last
  // place the three facts still exist separately. `ownsResumeSession` above
  // `&&`-folds two of them, so a caller reconstructing the cause from the same
  // inputs would be evaluating a second copy of this rule, free to disagree with
  // the decision it claims to describe.
  //
  // The condition is `resumeSessionId`, not `isContinue`: a reuse dispatch
  // attaches by id without continuing a conversation, and one that found no
  // usable id starts fresh even though `sessionReuse` stays true (see
  // `../controller/phase-runner`'s `resumeSessionId` contract).
  //
  // The id facts are tested before the request fact because they are
  // unconditional properties of the persisted run, while "not requested" is
  // only true relative to one request. Asking the request first would label a
  // reuse dispatch that had no usable id as a continuation nobody asked for.
  const freshSessionCause: FreshSessionCause | undefined =
    resumeSessionId !== undefined
      ? undefined
      : typeof inputs.persistedSessionId !== 'string'
        ? 'no-persisted-session-id'
        : ownsResumeSession
          ? 'continuation-not-requested'
          : 'session-id-not-owned';

  return {
    ownsResumeSession,
    isContinue,
    sessionReuse,
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    ...(resumePrompt === undefined ? {} : { resumePrompt }),
    ...(freshSessionCause === undefined ? {} : { freshSessionCause })
  };
}
