// A non-terminal Run and its Task row are two halves of one fact. Neither may
// outlive the other, and this is the load-time check for the half nothing was
// checking.
//
// WHAT WAS ALREADY ENFORCED, AND WHAT WAS NOT. `run-state-migrator.ts` refuses
// to drop a Run whose Task cannot be placed, and says why: *"dropping the Run
// does not drop the Task that points at it, so the Task would keep its
// in-flight status with nothing left to advance or terminate it — a queue stuck
// forever on work nothing is running."* That argument is exactly right and
// covers exactly one direction. The mirror image — the Task row deleted, the
// Run kept — produces a Run that is neither addressable nor cancellable, and
// had no enforcement anywhere.
//
// It also had a repair vocabulary already: `RunStateRepairReason` carries
// `'task-not-in-any-queue'`. That code runs once, inside the v10 → v11
// migration, on a workspace at schema 10. Every workspace past it — which is
// every workspace — never sees it again.
//
// WHY IT DEADLOCKS RATHER THAN MERELY LITTERING. Drain step 3 reads the Run map
// directly and refuses to start anything on a queue holding a non-terminal Run
// (BUG-003 put it there, correctly). Every route that could END that Run —
// cancel by id, the palette's sole-run cancel, resume phase — resolves the Task
// by row identity first and refuses when the row is missing. So the orphan
// closes both of the exits step 3's own comment names, and the queue's pending
// rows never move again. Window restarts do not help: nothing on the load path
// looked.
//
// WHY IT IS A PURE FUNCTION. Same reason every migrator here is one. It runs
// inside `initialize()`, where there is no queue manager, no execution-lease
// manager and no audit writer, and a repair that can fail activation is worse
// than the state it repairs. It is handed a map and a predicate and returns a
// map and events; the store owns the single write, and the forwarder owns the
// audit append once a writer exists.
//
// WHAT IT DELIBERATELY DOES NOT DO: release the orphan's execution lease. It
// cannot — the lease manager does not exist this early — and it does not need
// to. The lease is fenced with a heartbeat, so an abandoned claim goes stale and
// the drain's own step 6 `tryAcquire` reclaims it. Guessing at a release here
// would also be the exact mistake hard rule 4 forbids, from the one place in the
// codebase with no way to check its guess.
//
// WHY THERE IS NO "THE QUEUE LOOKED EMPTY, SO SKIP" ESCAPE HATCH. The obvious
// safety valve is to decline when no queue registry was persisted, on the
// grounds that an empty registry answers "no such row" for every Task on earth
// and a repair should not act on absence of evidence. It was written that way
// first. It is not worth having, for two reasons that only show up on trying it.
//
// It does not hold. The migration ladder WRITES `KEYS.queue`, so a workspace
// that never had a queue comes out of its first open holding a born-empty one.
// The guard has to read the raw key before the ladder runs to mean anything at
// all, and even then it protects exactly one open: the second open finds a
// persisted empty queue and ends the same Run. A guard that defers a loss by one
// window is not a guard, it is a false sense of one.
//
// And there is nothing to protect. Ending a Run here is not destructive — the
// record stays in the map with its pipeline, its completed phases, its last
// error and its pause cause intact; only `status` moves and the retry
// bookkeeping clears. What the operator gives up is the ability to resume it,
// and that ability is already gone: every resume, cancel and retry route
// resolves the Task by row identity first and refuses when the row is missing.
// So the non-terminal status was never reachable, and holding onto it only holds
// the queue's occupancy gate shut. That is why the legacy "survives migration"
// fixtures changed with this module rather than being exempted from it: they
// were written before the occupancy gate existed to turn a stranded Run into a
// deadlock, and preserving one now preserves the deadlock with it.

import {
  isTerminalRunStatus,
  TERMINAL_RUN_STATUSES,
  type WorkflowRun,
  type WorkflowRunStatus
} from './workflow-run';
import type { RunStateMap } from './run-state-migrator';

/**
 * The statuses an orphan can be found in — every status that is not terminal.
 *
 * Derived from `TERMINAL_RUN_STATUSES` rather than written out, so a status
 * added to the vocabulary is admitted here by construction instead of silently
 * falling outside a hand-listed pair. It also keeps the pinned status literals
 * in the one file that owns them, which `no-running-state-literal.test.ts`
 * checks.
 */
type NonTerminalRunStatus = Exclude<WorkflowRunStatus, (typeof TERMINAL_RUN_STATUSES)[number]>;

/**
 * One Run ended because the Task row addressing it was gone.
 *
 * `priorStatus` is narrowed to the non-terminal statuses because a terminal Run
 * is never a subject here — it is the status the operator would need to see to
 * understand what was interrupted, and widening it would let a terminal value
 * into a payload that claims otherwise.
 */
export interface OrphanedRunCanceledAuditEvent {
  readonly type: 'run-canceled-task-row-removed';
  readonly occurredAt: number;
  readonly queueId: string;
  readonly runId: string;
  readonly priorStatus: NonTerminalRunStatus;
}

export interface ReconcileOrphanedRunsResult {
  readonly runs: RunStateMap;
  /** `false` ⇒ the caller performs no write at all. */
  readonly changed: boolean;
  readonly events: readonly OrphanedRunCanceledAuditEvent[];
}

/**
 * The terminal record an orphan is replaced by.
 *
 * `canceled` rather than `failed`: nothing failed, the work was removed. The
 * Run stays in the map rather than being deleted from it, which is both the
 * less destructive answer and the one the product already produces — an
 * ordinary `deleteTask` of an in-flight Task leaves exactly this, a `canceled`
 * Run whose Task row is gone, and every reader already handles it.
 *
 * The delayed-retry pair is cleared, and this is not tidying.
 * `validateRunInvariants` holds two rules over those fields: `pendingRetryAt`
 * and `pendingRetryCause` are both-null-or-both-non-null, and a
 * `delayedRetryCount` at the cap is legal only on `paused` or `failed`. A Run
 * paused at the cap is exactly the kind that gets abandoned, and this write goes
 * straight to the Memento — past the validator, like every migrator's write —
 * so leaving either field as it stands would persist a record the next `setRun`
 * refuses. A canceled Run has no armed retry and no budget left to spend, so
 * clearing them is also what the fields mean.
 *
 * The manual-pause pair is preserved: it is consistent as a pair, and it is the
 * evidence of why the Run was sitting there.
 */
function endedRun(run: WorkflowRun, now: number): WorkflowRun {
  return {
    ...run,
    status: 'canceled',
    lastTransitionAt: now,
    pendingRetryAt: null,
    pendingRetryCause: null,
    delayedRetryCount: 0
  };
}

/**
 * End every Run whose Task row no longer exists in any queue.
 *
 * @param runs          the Run map, already in v11 shape
 * @param taskRowExists whether some queue in the persisted registry still holds
 *                      a row with this id. Asked over ALL queues rather than
 *                      "is it on this Run's own queue", because a Task that
 *                      moved between queues is not an orphan and must not be
 *                      treated as one. A dangling `inFlightId` is not an answer
 *                      of `true` here — `queue-state-migrator.ts` drops a
 *                      pointer naming no row on sight, and this runs after it
 * @param now           injected clock, stamped on every emitted event
 */
export function reconcileOrphanedRuns(
  runs: RunStateMap,
  taskRowExists: (taskId: string) => boolean,
  now: number = Date.now()
): ReconcileOrphanedRunsResult {
  const next: RunStateMap = {};
  const events: OrphanedRunCanceledAuditEvent[] = [];

  for (const [queueId, run] of Object.entries(runs)) {
    if (isTerminalRunStatus(run.status) || taskRowExists(run.featureId)) {
      next[queueId] = run;
      continue;
    }
    next[queueId] = endedRun(run, now);
    events.push({
      type: 'run-canceled-task-row-removed',
      occurredAt: now,
      queueId,
      runId: run.id,
      // Narrowed by the guard above: every terminal status took the branch that
      // continues, so what reaches here is non-terminal by construction.
      priorStatus: run.status as NonTerminalRunStatus
    });
  }

  return { runs: next, changed: events.length > 0, events };
}
