# Recovery from an interrupted run

Restored under FR-R3-062, which recorded that the stuck-run, crash-restart, safe-reset and
checkpoint-recovery runbooks were deleted without replacement. Cited from
`src/services/run-checkpoint-retention.ts`.
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/state/workspace-state.ts -->

Read [Data retention and deletion](data-retention-and-deletion.md) first if the question is what is
kept and for how long; this page is about getting a workspace moving again.

## Before anything: what state is safe to touch

Two things hold a run's identity, and they are not the same:

- **The audit log** (`.schegent/audit.log`) is append-only evidence. Never delete it to clear a
  stuck run — a hard rule, not a preference. It is the only record of what happened, and a
  reset that erases it removes the evidence needed to explain the reset.
- **Workspace state** (VS Code `Memento`) holds the queue, run records and execution leases. This
  is what a reset touches.

## A run appears stuck

1. **Check whether the process is actually gone.** Cancel the phase from the sidebar. Cancellation
   signals the backend's whole process tree, not just the direct child (FR-R3-054); if the runtime
   log records *"process tree not confirmed gone after SIGKILL"*, a descendant may still be
   running and writing to the workspace. Deal with that before restarting anything, or the next
   phase races it.
2. **Check the lease.** A queue whose execution lease is held by a window that is gone will be
   reclaimed once its heartbeat goes stale (15 seconds — `STALENESS_THRESHOLD_MS` in
   `src/state/lock.ts`, which is the value this sentence is checked against). Waiting is correct;
   forcing it is not.
3. **Read the runtime log** rather than guessing:
   [Inspect the runtime log](runtime-log.md).

## The host crashed or was reloaded mid-run

On activation the extension reattaches: it claims the workspace lock, reattaches the credit
watchdog, and resumes a persisted run. Nothing needs doing by hand for the ordinary case.

If the run does **not** resume, the likely cause is that its lease is still held by the previous
session's owner id and has not yet gone stale. That resolves itself within the staleness threshold.

## Safe reset

`schegent.reset` clears workspace state — queue, run records, leases. It does **not** and must not
delete the audit log or raw transcripts. After a reset:

- The audit log still contains every event from the run that was reset, so the history remains
  explainable.
- Session artifacts follow their own retention policy; see
  [Data retention and deletion](data-retention-and-deletion.md).

Prefer cancelling the phase and letting the lease expire over a reset. A reset is the right tool
when state is *inconsistent*, not when a run is merely slow.

## Checkpoints

A run checkpoint captures the working tree's diff at the point a run reached. There is **no
in-product restore path**: nothing resumes from a checkpoint automatically, and a later resume does
not read one — a checkpoint is restored by an operator applying the patch file by hand.
Retention is bounded — checkpoints are pruned by age and count like other evidence, so an old
checkpoint is not a durable record and must not be treated as one. The audit log is the durable
record.

## What this page does not claim

None of the procedures here has an automated end-to-end test behind it. FR-R3-062 asks for tested
runbooks; this page restores the *content* that was deleted, and the tested-procedure half remains
outstanding and is recorded as such in that item.
