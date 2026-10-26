import type { SanitizedLogger } from '../lib/logger';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { WorkflowRun } from '../state/workflow-run';
import {
  resolveSessionDispatch,
  type SessionDispatchDecision
} from './session-dispatch-policy';

/** What a dispatch asked for, as opposed to what the persisted Run offers. */
export interface SessionRequestInputs {
  readonly requestedContinue: boolean;
  readonly pendingSessionReuse: boolean;
}

/**
 * FR-R3-175 (FR-033, FR-034, SC-010, SC-011) — the sentence a dispatch's session
 * decision makes, in the vocabulary the decision itself uses.
 *
 * The cause is READ FROM the decision, never re-derived from the same inputs
 * here. `session-dispatch-policy.ts` folds two of the three causes into one
 * ownership boolean on the way out, so anything reconstructing them downstream is
 * a second copy of that rule and is free to disagree with the decision it claims
 * to describe (FR-034). The Run's `status` is not consulted either, which keeps
 * this file clear of the in-flight status literal that `docs/hard-rules.md` pins
 * to the projection paths, and which a gate under `tests/lint/` enforces by
 * scanning for the bare word — comments included, which is why this paragraph
 * describes it rather than quoting it.
 *
 * NO SESSION ID REACHES THIS STRING, by construction rather than by care (FR-035,
 * SC-011). The only value interpolated is `FreshSessionCause`, a closed union of
 * three string literals with no member an id, a fragment or a hash could arrive
 * in. V13 measured the convention this follows: nine sites log a session-related
 * line naming no id, zero truncate or hash one, and `../audit/audit-payload.ts`
 * drops all three id-bearing keys while keeping the disposition as booleans.
 * There is no positive marker to extend — the convention is what every site
 * declines to do, so conformance shows as an absence.
 */
export function sessionDispositionLine(decision: SessionDispatchDecision): string {
  const disposition =
    decision.freshSessionCause !== undefined
      ? `fresh backend session (${decision.freshSessionCause})`
      : decision.isContinue
        ? 'continued backend session'
        : 'reused backend session';
  return `session disposition: ${disposition}`;
}

/**
 * FR-R3-175 (FR-034a) — resolves a dispatch's session and, once per drive, says
 * what it did with it.
 *
 * WHY THE REPORTING LIVES AT THE CONSUMING SITE. FR-R3-175's filing asked for the
 * line at `resumeExistingOnQueue()` in `../controller/workflow-controller.ts`,
 * where the resume is triggered. R3 measured that site to hold the ingredients
 * but not the answer: the resolution runs one or more ticks later, and the
 * effective runner kind is recomputed PER PHASE, so a phase pinning its own
 * backend falsifies whatever the trigger predicted. A line there would be a claim
 * a later tick can falsify — a new one of exactly the thing this feature exists
 * to end — so it is emitted where the decision is made instead.
 *
 * WHY ONCE PER DRIVE, not once per dispatch. SC-010 counts: an activation resume
 * emits EXACTLY ONE such line, and the drive it starts is that resume. Later
 * phases in the same drive attach by construction — `pendingSessionReuse` carries
 * the id the previous phase returned — so repeating the line for each of them
 * would restate a settled fact until it read as noise, and would break the count
 * the success criterion is written as.
 *
 * WHY A SMALL OBJECT RATHER THAN A FLAG ON `RunDriver`. The bit and the rule for
 * spending it are one thing, and `drive()` is under a shrink-only budget
 * (`tests/lint/drive-loop-loc-budget.test.ts`) that a local `let` would spend for
 * no gain. The owner clears it through `reset()` from `endOfDriveReset()`, the
 * one funnel every `drive()` exit already passes.
 */
export class SessionDispositionReporter {
  private reported = false;

  constructor(private readonly logger: SanitizedLogger) {}

  /** Clear the per-drive bit. Called from the owner's end-of-drive funnel. */
  public reset(): void {
    this.reported = false;
  }

  public resolve(
    run: WorkflowRun,
    effectiveRunnerKind: BackendRunnerKind,
    requested: SessionRequestInputs
  ): SessionDispatchDecision {
    const decision = resolveSessionDispatch({
      requestedContinue: requested.requestedContinue,
      pendingSessionReuse: requested.pendingSessionReuse,
      resumePrompt: run.resumePrompt,
      persistedSessionId: run.lastCliSessionId,
      persistedSessionRunnerKind: run.lastCliSessionRunnerKind,
      persistedSessionCostUsd: run.lastCliSessionCostUsd,
      effectiveRunnerKind
    });
    if (this.reported) return decision;
    this.reported = true;
    this.logger.info(sessionDispositionLine(decision));
    return decision;
  }
}
