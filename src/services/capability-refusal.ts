// FR-R3-086 — a capability refusal is a Run-level outcome with a named cause,
// distinguishable from a phase failure.
//
// WHY A DISTINCT TYPE, and it is the same reasoning `UncontainedBackendRefusedError`
// already carries: there is no invocation to return, so the refusal is thrown —
// and a caller must be able to report the posture refusal as ITSELF rather than
// as a generic construction failure. A phase that failed because the model wrote
// bad code and a phase that never started because its declared capability set
// could not be enforced are different findings, and an operator who cannot tell
// them apart will debug the wrong one.
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { PhaseCapability } from '../contracts/phase-capabilities';

export class CapabilityNotEnforceableError extends Error {
  public constructor(
    public readonly kind: BackendRunnerKind,
    /** EVERY capability this backend cannot enforce, not the first. */
    public readonly unenforceable: readonly PhaseCapability[],
    /**
     * FR-R4-F06 (K3) -- the subset of `unenforceable` whose flag the planner declares and no capture has
     * confirmed the installed CLI lists. Empty when every refused capability simply has no flag. This is
     * FR-012's "specific reason": a refusal that says WHY the set cannot be enforced. Defaults to empty so
     * a caller that has no list (a test double, an older call site) still constructs the same error.
     */
    public readonly unqualified: readonly PhaseCapability[] = []
  ) {
    super(
      `backend '${kind}' cannot enforce the declared capability set: it has no way to withhold ` +
        `${unenforceable.join(', ')}. The phase is refused rather than run with the declared set ` +
        `ignored — an unbounded phase where a narrower set was approved is the failure this ` +
        `mechanism exists to prevent. Widen the phase's capability set, or run it on a backend ` +
        `whose CLI can express the withheld capability.` +
        (unqualified.length === 0
          ? ''
          : ` The flag for ${unqualified.join(', ')} could not be confirmed against the installed CLI.`)
    );
    this.name = 'CapabilityNotEnforceableError';
  }
}

/** Recognise the refusal across a module boundary without an instanceof trap. */
export function isCapabilityRefusal(error: unknown): error is CapabilityNotEnforceableError {
  return error instanceof CapabilityNotEnforceableError;
}
