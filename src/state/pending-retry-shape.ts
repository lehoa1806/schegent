// FR-R5-F19 (spec 278, FR-010; data-model §3) — the standing rule for where a delayed-retry countdown may
// sit: on a `paused` Run, and on no other.
//
// `pendingRetryAt` / `pendingRetryCause` are written once, by the delayed-retry scheduler, on a Run it has
// just paused. Every clearing site (resume, cancel, the driver's terminal writes) nulls them. A write that
// leaves them set beside any other status is a clearing site that forgot, and it persists a record every
// reader of "is a retry armed" answers wrongly: a row that reads as counting down while nothing runs.
//
// The rule applies to NEW writes only. A record stored before the rule can already hold the combination, so
// a write is accepted when the Run on disk is itself not paused and carries exactly the same countdown (same
// deadline and cause): a later patch of that Run, one that changes neither field, must not strand it. A Run
// leaving `paused` with its countdown still armed is the new write the rule exists to refuse. Loading never calls this, and
// `decideUnattendedEligibility` reads `status` before the fields, so a legacy combination is never woken.
import type { WorkflowRun } from './workflow-run';

const isSet = (value: unknown): boolean => value !== null && value !== undefined;

/**
 * Refuse `next` when it holds a retry countdown beside a status other than `paused`, unless `previous`
 * (the Run being replaced or patched) already held the identical countdown.
 */
export function assertPendingRetryShape(next: WorkflowRun, previous: WorkflowRun | null): void {
  if (!isSet(next.pendingRetryAt) && !isSet(next.pendingRetryCause)) return;
  if (next.status === 'paused') return;
  if (
    previous !== null &&
    previous.id === next.id &&
    previous.status !== 'paused' &&
    previous.pendingRetryAt === next.pendingRetryAt &&
    previous.pendingRetryCause === next.pendingRetryCause
  ) {
    return;
  }
  throw new Error(
    `WorkflowRun invariant violation: pendingRetryAt (${next.pendingRetryAt}) and pendingRetryCause (${next.pendingRetryCause}) require status 'paused' (got '${next.status}')`
  );
}
