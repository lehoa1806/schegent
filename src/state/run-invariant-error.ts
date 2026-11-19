import type { WorkflowRunStatus } from './workflow-run';
import type { RunTransitionActor, RunTransitionRefusalReason } from './run-transition-decision';

/**
 * FR-R7-01 — closed vocabulary naming every field-combination invariant enforced by
 * `validateRunInvariants` and its pure helpers (`assertPendingRetryShape`,
 * `assertCreditPauseShape`). Callers can branch on `error.code` instead of
 * parsing `error.message`.
 */
export type RunFieldInvariantCode =
  | 'invalid-admission-status'
  | 'invalid-raw-transcript-mode'
  | 'one-sided-pending-retry'
  | 'pending-retry-requires-paused'
  | 'delayed-retry-cap-status'
  | 'delayed-retry-count-range'
  | 'one-sided-manual-pause'
  | 'invalid-credit-pause-shape'
  | 'failure-cause-requires-failed'
  | 'invalid-phase-breakpoints'
  | 'duplicate-phase-breakpoint'
  | 'unknown-breakpoint-phase'
  | 'breakpoint-override-conflict'
  | 'resume-target-phase-mismatch';

/**
 * FR-R7-01 — base class for all structural WorkflowRun invariant errors
 * (both illegal status transitions and invalid field combinations).
 */
export class RunInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunInvariantError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * FR-R7-01 — thrown when `decideRunTransition` refuses a `(from, to)` status
 * transition for a given `actor`. Callers read `from`, `to`, `actor`, and
 * `reasonCode` directly without parsing error text.
 */
export class RunTransitionError extends RunInvariantError {
  public readonly from: WorkflowRunStatus;
  public readonly to: WorkflowRunStatus;
  public readonly actor: RunTransitionActor;
  public readonly reasonCode: RunTransitionRefusalReason;

  constructor(
    from: WorkflowRunStatus,
    to: WorkflowRunStatus,
    actor: RunTransitionActor,
    reasonCode: RunTransitionRefusalReason,
    message?: string
  ) {
    super(
      message ??
        `WorkflowRun invariant violation: illegal status transition '${from}' -> '${to}' for actor '${actor}' (${reasonCode})`
    );
    this.name = 'RunTransitionError';
    this.from = from;
    this.to = to;
    this.actor = actor;
    this.reasonCode = reasonCode;
  }
}

/**
 * FR-R7-01 — thrown when a WorkflowRun fails a field-combination invariant check
 * (e.g. one-sided manual pause pair, `failureCause` beside a non-`failed` status).
 * Preserves the exact `WorkflowRun invariant violation: ...` message text.
 */
export class RunFieldInvariantError extends RunInvariantError {
  public readonly code: RunFieldInvariantCode;

  constructor(code: RunFieldInvariantCode, message: string) {
    super(message);
    this.name = 'RunFieldInvariantError';
    this.code = code;
  }
}
