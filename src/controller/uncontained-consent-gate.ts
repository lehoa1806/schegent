import type { BackendRunnerKind } from '../contracts/backend-kinds';
import {
  ALLOW_UNCONTAINED_SETTING,
  isUncontainedBackendRefusal
} from '../services/backend-containment-policy';

// FR-R3-146 (FR-002, FR-003) — the recovery above the refusal, and its bound.
//
// `createBackendRunner` refuses synchronously, inside the constructor, before a
// runner object exists (plan A1). That is the bound and it does not move: making
// the enforcement point `async` so a dialog could be awaited one frame lower would
// put a UI await inside the function whose only job is to decide, and every caller
// that cannot show a dialog would then need an answer for what the absence of one
// means — at the one decision where the wrong answer is an unbounded spawn.
//
// So the consent is attached ABOVE the throw, where a frame can already await, and
// the retry constructs a second time only after the grant is written.
//
// WHY THE PORT IS DECLARED HERE AND NOT IN `activation/`
//
// The consumer owns the interface. `activation/uncontained-consent.ts` implements
// it — the modal, the settings write — and imports these types, so the dependency
// runs activation → controller, the direction the wiring already runs. Declaring
// them in `activation/` and importing them back would add a controller → activation
// edge to a graph `import-graph-acyclic.test.ts` keeps acyclic, for nothing.

/** What the controller was refused, reduced to the two facts the modal needs. */
export interface UncontainedRefusal {
  readonly kind: BackendRunnerKind;
  /** `judgeBackendContainment`'s message, already sanitized. Carried verbatim. */
  readonly message: string;
}

/**
 * The three ways the ask can end, named rather than squeezed into a boolean.
 *
 * `write-failed` is deliberately NOT a denial. The operator consented and the host
 * could not record it — a read-only profile, a rejected update — which is a
 * different fault from a refusal and must not be reported as one, or the operator
 * is told they declined something they accepted.
 */
export type UncontainedConsentOutcome =
  | { readonly decision: 'granted' }
  | { readonly decision: 'denied' }
  | { readonly decision: 'write-failed'; readonly reason: string };

/** Shows the consent modal and, on the affirmative action, records the grant. */
export type UncontainedConsentPort = (
  refusal: UncontainedRefusal
) => Promise<UncontainedConsentOutcome>;

/**
 * The operator consented and the host could not write it down.
 *
 * Its own type so the failure handler can say that, rather than reporting a
 * refusal the operator did not make. It carries the setting name because the
 * remedy — set it by hand — is the only one left when the host cannot.
 */
export class ConsentWriteFailedError extends Error {
  public constructor(
    public readonly kind: BackendRunnerKind,
    public readonly reason: string
  ) {
    super(
      `Your approval for the '${kind}' backend could not be saved to ` +
        `'${ALLOW_UNCONTAINED_SETTING}': ${reason}. The run did not start. Add '${kind}' to ` +
        'that setting in your user settings to grant it by hand.'
    );
    this.name = 'ConsentWriteFailedError';
  }
}

export function isConsentWriteFailure(error: unknown): error is ConsentWriteFailedError {
  return error instanceof ConsentWriteFailedError;
}

/** Retry the start, or report `err` as the failure it is. */
export type StartRecovery =
  | { readonly action: 'retry' }
  | { readonly action: 'report'; readonly err: unknown };

/**
 * Whether a start failure is one the operator can answer, and whether they did.
 *
 * Window-lived, because the bound it enforces is: **one grant per backend kind,
 * ever, per window.** That is a record of what was granted, not a retry counter.
 * The difference matters — a counter would let a second prompt through after some
 * unrelated failure reset it, and a grant that is present while the backend is
 * still refused is a REAL fault (a write that did not take effect, a profile that
 * silently discards it) which must fail rather than ask again. Asking twice for the
 * same answer is how a consent dialog becomes something an operator clicks through.
 */
export class UncontainedConsentGate {
  private readonly granted = new Set<BackendRunnerKind>();

  public constructor(
    private readonly request: UncontainedConsentPort | undefined,
    private readonly sanitize: (raw: string) => string
  ) {}

  public async decide(err: unknown): Promise<StartRecovery> {
    // Not a containment refusal, or no consent surface wired (a headless host, a
    // test): report it. An absent dialog never grants — same rule as a dialog that
    // throws, for the same reason.
    if (!isUncontainedBackendRefusal(err) || !this.request) return { action: 'report', err };
    if (this.granted.has(err.kind)) return { action: 'report', err };

    const outcome = await this.request({
      kind: err.kind,
      message: this.sanitize(err.message)
    });
    if (outcome.decision === 'granted') {
      this.granted.add(err.kind);
      return { action: 'retry' };
    }
    if (outcome.decision === 'write-failed') {
      return { action: 'report', err: new ConsentWriteFailedError(err.kind, outcome.reason) };
    }
    return { action: 'report', err };
  }
}

/**
 * Route one start failure: retry it once on a fresh grant, or report it.
 *
 * The retry's own failure goes straight to `report` and never back through the
 * gate. It cannot loop even if it did — the gate has recorded the grant by then —
 * but a recovery that re-enters its own recovery is a shape nobody should have to
 * reason about to be sure of that.
 */
export async function recoverOrReport(
  err: unknown,
  gate: UncontainedConsentGate,
  retry: () => Promise<void>,
  report: (failure: unknown) => Promise<void>
): Promise<void> {
  const next = await gate.decide(err);
  if (next.action === 'report') return report(next.err);
  await retry().catch(report);
}
