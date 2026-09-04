// FR-R3-154 (T1645, T1646) — what a mutating host command reports, and how
// that reaches the webview.
//
// WHAT THIS REPLACES. Five sidebar routes — Pause Phase, Resume Phase, Restart
// Phase, Retry Phase Now, Start Queue — executed a VS Code command and then
// ACKed `accepted` unconditionally. They had no alternative: every registered
// command behind them returned `void`, having already warned the operator and
// swallowed the refusal. So three distinct host answers arrived at the webview
// as success — a structured refusal, a no-op, and a Workspace Trust refusal in
// which the handler never ran at all.
//
// WHY A FOURTH WORD. `status: 'accepted' | 'rejected'` is the wire's existing
// vocabulary and the webview's ack plumbing reads it, so it stays. But two
// rejections are not the same event: a refusal means the host declined, a
// no-op means the host had nothing to do, and an operator who asked to cancel
// an already-cancelled schedule should not be told they were refused. Hence
// `outcome`, carried alongside `status` rather than in place of it.
//
// WHY `accepted` IS THE NARROW WORD. FR-R3-154's acceptance boundary: "`accepted`
// means the host committed the mutation or explicitly accepted a documented
// asynchronous operation. A warning/toast is not evidence of acceptance." A
// no-op therefore maps to `status: 'rejected'`. That is deliberately
// conservative — nothing was committed, and the one reading this vocabulary
// must never make available again is "reported as committed when it wasn't".

/** The four answers an ACK may carry, in the order the filing names them. */
export const COMMAND_ACK_OUTCOMES = ['accepted', 'no-op', 'refused', 'failed'] as const;

export type CommandAckOutcome = (typeof COMMAND_ACK_OUTCOMES)[number];

/**
 * The result a mutating host command returns to its caller.
 *
 * Every non-accepted variant carries a `reason`, and the type is what enforces
 * it: an unexplained rejection is a rejection the webview cannot render and the
 * operator cannot act on.
 */
export type CommandOutcome =
  | { readonly outcome: 'accepted' }
  | { readonly outcome: 'no-op'; readonly reason: string }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'failed'; readonly reason: string };

/** The host committed the mutation. */
export const ACCEPTED: CommandOutcome = Object.freeze({ outcome: 'accepted' } as const);

/** Nothing to commit: the state was already what the operator asked for. */
export function noOp(reason: string): CommandOutcome {
  return { outcome: 'no-op', reason };
}

/** The host declined, for a reason from its own eligibility vocabulary. */
export function refused(reason: string): CommandOutcome {
  return { outcome: 'refused', reason };
}

/**
 * The host tried and something broke. `reason` is a code, never an error
 * message: it crosses the IPC boundary, and messages carry paths.
 */
export function failed(reason: string): CommandOutcome {
  return { outcome: 'failed', reason };
}

/**
 * `registerGuardedCommand` warns the operator and returns `undefined` — without
 * ever entering the handler — when a mutating command is invoked in an untrusted
 * workspace. `undefined` from one of these five ids therefore means exactly
 * this, and it is the shape whose old reading was false in the strongest way
 * available: `await exec(...)` resolved, so the route ACKed a mutation that had
 * never been attempted.
 */
export const WORKSPACE_NOT_TRUSTED_REASON = 'workspace-not-trusted';

/** A registered command answered with something no reading covers. */
export const UNRECOGNIZED_RESULT_REASON = 'command-result-unrecognized';

/** A rejection whose owner gave no reason of its own. */
export const UNEXPLAINED_REJECTION_REASON = 'operation-rejected';

const NON_ACCEPTED: ReadonlySet<string> = new Set(
  COMMAND_ACK_OUTCOMES.filter((o) => o !== 'accepted')
);

/**
 * Narrow an arbitrary value to a `CommandOutcome`, rebuilding it rather than
 * passing it through: an `accepted` carrying a stray `reason` would ACK a
 * committed mutation alongside an explanation of why it did not happen.
 */
function narrowOutcome(value: unknown): CommandOutcome | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { outcome?: unknown; reason?: unknown };
  if (candidate.outcome === 'accepted') return ACCEPTED;
  if (typeof candidate.outcome !== 'string' || !NON_ACCEPTED.has(candidate.outcome)) return null;
  if (typeof candidate.reason !== 'string' || candidate.reason.length === 0) return null;
  return {
    outcome: candidate.outcome as Exclude<CommandAckOutcome, 'accepted'>,
    reason: candidate.reason
  };
}

export function isCommandOutcome(value: unknown): value is CommandOutcome {
  return narrowOutcome(value) !== null;
}

/**
 * Convert the `MutationResult` shape the host's mutating services already
 * return. The reason travels verbatim: those vocabularies belong to FR-R3-151
 * (`resolveControlTarget`, `PhaseControlService`) and FR-R3-150/152 (Queue
 * starts), and translating them here would be the second eligibility oracle
 * FR-R3-154 forbids.
 */
export function fromMutationResult(result: {
  readonly ok: boolean;
  readonly reason?: string;
}): CommandOutcome {
  return result.ok ? ACCEPTED : refused(result.reason ?? UNEXPLAINED_REJECTION_REASON);
}

/**
 * Read whatever came back out of `executeCommand`.
 *
 * Fail-closed on an unrecognized shape, and the asymmetry is the point: an
 * unrecognized result is a wiring defect, and reporting a defect as `accepted`
 * is the exact class of bug this module exists to remove. Reporting a
 * successful mutation as failed is wrong and recoverable — the operator looks
 * again. The reverse is neither.
 */
export function normalizeCommandResult(value: unknown): CommandOutcome {
  if (value === undefined || value === null) return refused(WORKSPACE_NOT_TRUSTED_REASON);
  const outcome = narrowOutcome(value);
  if (outcome) return outcome;
  if (typeof value === 'object' && typeof (value as { ok?: unknown }).ok === 'boolean') {
    return fromMutationResult(value as { ok: boolean; reason?: string });
  }
  return failed(UNRECOGNIZED_RESULT_REASON);
}

/** The ACK fields an outcome produces. `accepted` never carries a reason. */
export function ackFieldsFor(outcome: CommandOutcome): {
  readonly status: 'accepted' | 'rejected';
  readonly outcome: CommandAckOutcome;
  readonly reason?: string;
} {
  return outcome.outcome === 'accepted'
    ? { status: 'accepted', outcome: 'accepted' }
    : { status: 'rejected', outcome: outcome.outcome, reason: outcome.reason };
}
