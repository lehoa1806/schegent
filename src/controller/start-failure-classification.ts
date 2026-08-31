import { LockHeldError } from '../lib/errors';
import { isUncontainedBackendRefusal } from '../services/backend-containment-policy';
import { isCapabilityRefusal } from '../services/capability-refusal';
import { isConsentWriteFailure } from './uncontained-consent-gate';

// FR-R3-146 (FR-005) — how a start failure is REPORTED, decided in one place.
//
// WHY THIS IS A MODULE AND NOT THREE TERNARIES
//
// `handleUnexpectedStartFailure` had two shapes — a held lock, and everything
// else — spread across five expressions: the message, the error code, the log
// level and its wording, the status-bar detail, and the operator notification.
// Adding a third shape meant editing all five, and a report that got one of them
// wrong is exactly the defect this feature exists to fix: a fresh install's
// deliberate policy refusal reached the operator as `workflow … failed
// unexpectedly`, severed at 240 characters through the half that named the
// remedy. Five sites is five chances to disagree about what kind of event this is.
//
// So the classification is one total function of the thrown value, and the handler
// reads fields off it. `src/controller/` already keeps this shape for decisions
// that are pure — `sole-run-resolver.ts`, `resume-pause-fields.ts`,
// `manual-retry-override.ts` — and `source-loc-budget.test.ts` asked for it by
// name when the third branch put `workflow-controller.ts` over its ceiling.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It does not persist, notify, log, or decide whether a Run is failed. It maps a
// thrown value to what should be said about it. Everything with an effect stays in
// the handler, where the Run and the queue are in hand.

/** The shapes a start failure takes, named rather than implied by a boolean pair. */
export type StartFailureKind =
  | 'lock-held'
  | 'uncontained-backend-refused'
  | 'capability-not-enforceable'
  | 'consent-write-failed'
  | 'unexpected';

/**
 * The bound on an operator-visible message from an ARBITRARY throw.
 *
 * An unexpected error's message is whatever a dependency chose to put in it, of
 * whatever length; a status line and a notification toast are not sinks that can
 * absorb that. The classified shapes are not subject to it, because each is
 * built by this product from constants and each is cut mid-remedy by it.
 *
 * THAT SENTENCE IS THE MEMBERSHIP RULE, and it was written here before every
 * member satisfying it was in the set: `CapabilityNotEnforceableError` met it
 * word for word and was classified as `unexpected` anyway, which cost it its
 * whole remedy sentence and told the operator a deliberate refusal had "failed
 * unexpectedly". A rule stated in a docblock is not a rule anything checks —
 * `tests/lint/start-failure-classification-coverage.test.ts` now checks it.
 */
export const UNEXPECTED_MESSAGE_MAX = 240;

export interface StartFailureReport {
  readonly kind: StartFailureKind;
  /** The `SanitizedError.code` recorded on the Run and the queue row. */
  readonly code: string;
  /** The recorded message. Truncated for `unexpected` only. */
  readonly message: string;
  /** `warn` for an operator decision the host is reporting; `error` for a fault it is confessing. */
  readonly level: 'warn' | 'error';
  /** The log line, already assembled around the feature id. */
  readonly logLine: string;
  /** One line. The status bar is a summary surface and stays one. */
  readonly statusDetail: string;
  /** What the operator is told, in a notification. */
  readonly announcement: string;
}

/**
 * Classify a start failure.
 *
 * `sanitize` is injected rather than imported so this stays a pure function of its
 * inputs: it is the caller's `SanitizedLogger`, and redaction keeps its single
 * authority. It is applied to every message that leaves here, including the two
 * built from constants — an exemption for "this one is safe" is how the next
 * message that is not safe gets one too.
 */
export function classifyStartFailure(
  err: unknown,
  featureId: string,
  sanitize: (raw: string) => string
): StartFailureReport {
  if (err instanceof LockHeldError) {
    const message = 'Another VS Code window holds the workspace lock';
    return {
      kind: 'lock-held',
      code: 'lock-held',
      message,
      level: 'warn',
      logLine: `workflow ${featureId} rejected: workspace lock held by ${sanitize(err.ownerId)}`,
      statusDetail: message,
      announcement: `Schegent: workflow failed unexpectedly — ${message}.`
    };
  }

  if (isUncontainedBackendRefusal(err)) {
    // A policy DECISION, not a fault. `judgeBackendContainment` refused, and every
    // route to a spawn passes through the construction point that raises this.
    //
    // NOT TRUNCATED. The message names the setting, the exact value to add, the
    // scope of the grant, and the alternative — and the 240-character cut lands in
    // the middle of the word "choose", which is what the operator report that
    // opened this feature actually received. A remedy an operator cannot read is
    // not a remedy.
    const message = sanitize(err.message);
    return {
      kind: 'uncontained-backend-refused',
      code: 'uncontained-backend-refused',
      message,
      // `warn`, like the held lock: `error` is what an operator filters for when
      // something is broken, and nothing here is.
      level: 'warn',
      logLine: `workflow ${featureId} refused: ${message}`,
      // The full text is on the Run record and in the log, which is where it is
      // readable. Five hundred characters in a status-bar tooltip would not make it
      // more readable — it would make the bar unusable.
      statusDetail: `backend '${err.kind}' refused: no OS-enforced bound`,
      announcement: `Schegent: backend '${err.kind}' was refused — ${message}`
    };
  }

  if (isCapabilityRefusal(err)) {
    // A phase REFUSED because the backend cannot withhold what the phase declared
    // — the same shape as the containment refusal above, and it was reaching the
    // operator as `workflow … failed unexpectedly`, cut at 240 characters through
    // the sentence naming the remedy.
    //
    // NOT TRUNCATED, for the reason `UNEXPECTED_MESSAGE_MAX` states: this message
    // is built here from constants, and the bound severs it mid-remedy. The
    // shortest one this error can raise — a single withheld capability — is 370
    // characters, so there is no input for which the cut was harmless.
    //
    // `warn`, like the two refusals above: nothing is broken. The product declined
    // to run a phase with a narrower capability set than the one it was given, and
    // reporting that as a fault sends an operator looking for a fault.
    const message = sanitize(err.message);
    return {
      kind: 'capability-not-enforceable',
      // The same string `capability-enforcement-plan.ts` already uses for this
      // refusal's `reason`, so the record and the plan name it identically.
      code: 'capability-not-enforceable',
      message,
      level: 'warn',
      logLine: `workflow ${featureId} refused: ${message}`,
      // One line, and a FIXED phrase rather than the withheld list: the status bar
      // is a summary surface, the list is unbounded as capabilities are added, and
      // a bound on this line is what the whole finding is about. The full text is
      // on the Run record and in the log.
      statusDetail: `backend '${err.kind}' cannot enforce the declared capabilities`,
      announcement: `Schegent: backend '${err.kind}' cannot enforce this phase's capabilities — ${message}`
    };
  }

  if (isConsentWriteFailure(err)) {
    // The operator SAID YES and the host could not write it down. Reporting this as
    // a refusal would tell them they declined something they accepted, and would
    // send them looking for a consent decision to change instead of a setting to
    // write by hand — which is the remedy the message carries.
    //
    // `error`, not `warn`: the two above are decisions this product is reporting.
    // This is a fault it is confessing.
    const message = sanitize(err.message);
    return {
      kind: 'consent-write-failed',
      code: 'uncontained-consent-write-failed',
      message,
      level: 'error',
      logLine: `workflow ${featureId} failed: ${message}`,
      statusDetail: `approval for '${err.kind}' could not be saved`,
      announcement: `Schegent: your approval could not be saved — ${message}`
    };
  }

  // Unchanged, on purpose. FR-R3-146 §2 puts the general case out of scope: an
  // arbitrary throw keeps its code, its `error` level, its wording, and its bound.
  const raw = err instanceof Error ? err.message : String(err);
  const message = sanitize(raw.length > 0 ? raw : 'unknown workflow error').slice(
    0,
    UNEXPECTED_MESSAGE_MAX
  );
  return {
    kind: 'unexpected',
    code: 'unexpected-controller-error',
    message,
    level: 'error',
    logLine: `workflow ${featureId} failed unexpectedly: ${message}`,
    statusDetail: message,
    announcement: `Schegent: workflow failed unexpectedly — ${message}.`
  };
}
