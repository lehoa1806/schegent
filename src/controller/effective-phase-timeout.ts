// FR-R3-086 follow-up — the phase's timeout, resolved in ONE place.
//
// WHY THIS MODULE EXISTS. `timeoutSeconds` is an authored Phase field. It is
// validated (1..3600), persisted, snapshotted, carried through the portable
// exchange format, and reported as `timeoutMs` on the `phase-start` payload, on
// the invocation metric payload, and on the sidecar meta — four records, all of
// which said the phase ran under the authored bound.
//
// It never reached the subprocess. `phase-runner.ts` passed `inputs.timeoutMs`
// — the WORKSPACE SETTING, one value for the whole run — into `invoke()`, and
// every use of `phaseDef.timeoutSeconds` in the tree wrote a record rather than
// bounding anything. So an operator who authored a 45-second bound on a risky
// phase got evidence saying 45 seconds and a process bounded by the global
// default of 5400.
//
// That is worse than a control that does nothing: the record affirmatively
// claimed a bound that was never applied, which is the class `R-14`, `D2`,
// `F-08` and the envelope half all belong to. Found by
// `tests/lint/phase-field-forwarding-seam.test.ts` on its FIRST run — the gate
// the feature-155 security review asked for, closing the seam it had traced by
// hand three times.
//
// PRECEDENCE. The authored per-phase value wins outright when present; the
// workspace setting is the default it overrides. That is ordinary config
// precedence, and it is also what the four records were already claiming, so
// making the effect match them changes no record's meaning.
//
// ONE EXPRESSION, EVERY READER. The effect and the records now call this, so
// they cannot drift apart — the same lock-step discipline `phase-runner.ts`
// already states for `isContinue` and the `-c` argv append.

/** The inputs this resolution reads. Structural, so callers need no import. */
export interface PhaseTimeoutInputs {
  readonly timeoutMs: number;
  readonly phaseDef?: { readonly timeoutSeconds?: number } | undefined;
}

const MS_PER_SECOND = 1000;

/**
 * The idle-window bound this phase actually runs under, in milliseconds.
 *
 * A `timeoutSeconds` of 0 is not a bound of zero — the catalog's minimum is 1,
 * so 0 cannot be authored, and treating a falsy value as "not declared" keeps
 * this identical to the four record sites it replaces.
 */
export function effectivePhaseTimeoutMs(inputs: PhaseTimeoutInputs): number {
  return authoredPhaseTimeoutMs(inputs.phaseDef) ?? inputs.timeoutMs;
}

/**
 * The AUTHORED bound alone, or `undefined` when the phase declares none.
 *
 * For the two record sites that hold a Phase but not the workspace setting, and
 * so cannot know the effective value when nothing is declared. They keep omitting
 * the key in that case, exactly as before. What they must not do is convert
 * seconds to milliseconds a fifth time: the conversion and the precedence live
 * here, and a caller that only needs one of them still gets it from here.
 */
export function authoredPhaseTimeoutMs(
  phaseDef?: { readonly timeoutSeconds?: number } | undefined
): number | undefined {
  const authored = phaseDef?.timeoutSeconds;
  return authored ? authored * MS_PER_SECOND : undefined;
}
