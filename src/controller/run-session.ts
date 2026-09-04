// Feature 093 (T041-T044) — the per-queue driving context (data-model §1.2).
//
// Before this feature the controller held one `RunDriver` and one
// `IsContinueGate` as fields, which was correct while a window could only ever
// advance one Run: "the driver" and "the Run" were the same thing said twice.
// With N Runs in flight the two pieces of per-Run mutable state below have to
// exist N times, and a `RunSession` is that N-times-over bundle. It is
// deliberately *not* a second controller: `SchegentWorkflowController` stays one
// per window because it constructs the `AutoDrainCoordinator`, and a second
// coordinator would be a second idle-pending enforcement site — a CLAUDE.md hard
// rule violation, not a design preference (T042).
//
// What a session owns, and why each is per-queue rather than shared:
//
//   - `driver` — `RunDriver` holds `cancellationController`, `isRunning`,
//     `carriedIssues`, `overriddenActivePhaseAborts`, and its `PhaseSequencer`.
//     Every one of those is state about *one* Run's advance. Sharing the
//     instance is what made `drive()`'s re-entrancy guard refuse the second Run
//     (T043): the guard is right, its scope was the window. One driver per
//     session leaves the guard byte-for-byte and narrows what it guards.
//   - `isContinueGate` — armed by an entry point and consumed by the first
//     runner call of the drive it precedes. A shared gate is armed by whichever
//     queue resumed last and consumed by whichever queue drives first, so a
//     window with two Runs could append `-c` to the wrong conversation. The
//     CLAUDE.md hard rule pins `-c` to `request.isContinue === true`; per-session
//     gates are what keep that boolean about the Run it was armed for.
//
// What is *not* in a session, and stays shared by reference: the state store,
// the audit and raw-transcript writers, the history recorder, the execution
// lease manager, the drain coordinator, the status bar, and the workspace lock
// manager. Each is either append-only, workspace-scoped, or already
// queue-addressed; duplicating one would fork a source of truth.
//
// The `PhaseBreakpointAccessor` that data-model §1.2 also lists is a recorded
// deviation — see the note in `breakpoint-accessor.ts` for why the session does
// not hold one.

import { IsContinueGate } from './is-continue-gate';
import type { RunDriver } from '../services/run-driver';
import { isTerminalRunStatus, type WorkflowRun } from '../state/workflow-run';

export interface RunSession {
  /** The queue this session drives. One session per *executing* queue. */
  readonly queueId: string;
  /** This queue's driver. Its re-entrancy guard is scoped to this session. */
  readonly driver: RunDriver;
  /** This queue's `-c` continuation gate. Armed and consumed within one drive. */
  readonly isContinueGate: IsContinueGate;
}

/**
 * Builds the driver for a new session. The gate is handed in rather than read
 * off the session so the driver can be constructed before the session literal
 * exists; the controller supplies the rest of `RunDriverDeps` by closure.
 */
export type RunDriverFactory = (isContinueGate: IsContinueGate) => RunDriver;

/**
 * The window's live sessions, keyed by queue.
 *
 * `size` is the count the concurrency cap measures (RS-1) — that is the whole
 * reason the map lives behind a named type instead of being a controller field:
 * the cap needs one number, and it should read it from the thing that defines
 * it rather than from a parallel counter that can drift.
 */
export class RunSessionRegistry {
  private readonly sessions = new Map<string, RunSession>();

  constructor(
    private readonly createDriver: RunDriverFactory,
    private readonly resolveRun: (queueId: string) => WorkflowRun | null
  ) {}

  /**
   * The session for `queueId`, creating one if this queue has none.
   *
   * Idempotent by design: re-acquiring a queue that is already driving returns
   * the *same* session, so a duplicate `drive()` meets the same driver and is
   * refused by its re-entrancy guard. Minting a second driver here would hand
   * the duplicate a fresh guard and let one queue advance itself twice.
   */
  public acquire(queueId: string): RunSession {
    const existing = this.sessions.get(queueId);
    if (existing !== undefined) return existing;
    const isContinueGate = new IsContinueGate();
    const session: RunSession = {
      queueId,
      driver: this.createDriver(isContinueGate),
      isContinueGate
    };
    this.sessions.set(queueId, session);
    return session;
  }

  /** The session for `queueId`, or `null`. Never creates one. */
  public peek(queueId: string): RunSession | null {
    return this.sessions.get(queueId) ?? null;
  }

  /**
   * Live sessions. RS-1: this is the number the cap bounds.
   *
   * REAPS BEFORE COUNTING (2026-09-02), because that sentence has to be true at
   * the moment the number is read rather than at the moment the last terminal
   * path remembered to tidy up. `disposeEnded` below carries the full account of
   * how a Run that has ended comes to still be counted here, and why the queue
   * that just finished is always the one that reads it stale.
   *
   * Counting is the right door for it because this getter has exactly one reader
   * — `SchegentWorkflowController.liveRunCount`, which is itself read by drain
   * step 4 — so settling the bookkeeping here is not a broadening. It is the
   * question and the answer meeting in one place, instead of every terminal path
   * being trusted to have finished first.
   *
   * Safe as a read because the reap is self-guarding rather than merely
   * idempotent: `disposeIfEnded` refuses a driver that is mid-drive, refuses a
   * non-terminal Run, and refuses a session whose continuation gate is still
   * armed — so it can only collect slots that are already owed.
   *
   * Code-review finding — that third guard is not decoration, and the claim it
   * replaced ("a gate is only ever armed for a Run about to be resumed, which is
   * by definition not terminal") was false in tree. `resumeExistingOnQueue`
   * refuses only `completed` and `canceled`, so a `failed` Run — terminal by
   * `isTerminalRunStatus` — reaches the arm, and the consent await that follows
   * holds the window open for as long as an operator takes to answer a modal.
   * See `disposeIfEnded` for what the reap used to cost there.
   */
  public get size(): number {
    this.disposeEnded();
    return this.sessions.size;
  }

  public all(): readonly RunSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Dispose the queue's session iff its Run has ended (RS-3, RS-4, RS-5).
   *
   * Four conditions, each load-bearing:
   *
   *   - The driver must be idle. A session whose driver is mid-drive is by
   *     definition not finished, and disposing it would let the next `acquire`
   *     mint a second driver for a queue that already has one in flight.
   *   - The continuation gate must not be armed. An armed gate is a drive that
   *     has been committed to and has not started yet, and the gate is the only
   *     copy of that fact: disposal destroys the session, so the `acquire` in
   *     `driveSession` mints a FRESH gate and `consume()` returns `false`. The
   *     Claude CLI is then invoked without `-c` for a Run that was resuming a
   *     conversation, which starts a new one — the exact outcome the hard rule
   *     pinning `-c` to `request.isContinue === true` exists to prevent, and it
   *     is silent: nothing distinguishes a dropped continuation from a Run that
   *     never had one. The window is not a narrow race. `resumeExistingOnQueue`
   *     arms before its consent check, and refuses only `completed`/`canceled`,
   *     so a `failed` Run being retried sits armed-with-terminal-status for as
   *     long as the operator leaves the consent modal open, during which any
   *     drain sweep reading `size` above reaps it.
   *   - A queue with no Run record has nothing left to drive, so its session
   *     goes.
   *   - Otherwise the Run's status must be one of the three enumerated terminal
   *     statuses. **Never** `status !== 'running'`: that negation also admits
   *     `paused`, and RS-3 says a paused Run keeps its session, its execution
   *     lease, and its cap slot — a later resume continues on all three, and a
   *     resume that had to re-acquire a slot could be refused once the cap
   *     refilled. `isTerminalRunStatus` is the same oracle
   *     `execution-lease-release.ts` reads, so session disposal and lease
   *     release cannot come to disagree about which transitions end a Run.
   *
   * Removing exactly one entry is the bulkhead (RS-5): a Run that fails takes
   * its own session down and no sibling's.
   *
   * ASK TWICE, BECAUSE THE ANSWER CHANGES (2026-09-01)
   *
   * The three conditions are read at the moment of the call, and on one route
   * the call arrived before the answer existed. `driveSession`'s `finally` was
   * the only caller for a Run started by `admitNew`, and an exception escaping
   * `RunDriver.drive()` — `checkpoint-unavailable` was the reported one — runs
   * that `finally` while the persisted record still reads `running`: the
   * `failed` write belongs to `handleUnexpectedStartFailure`, which
   * `driveUnderConsent` only reaches once `drive()` has already rejected. So
   * condition three refused, the session stayed, and nothing asked again.
   *
   * That leak is not a leaked object; it is a leaked *slot*. `size` below is
   * `liveRunCount`, and drain step 4 is `liveRunCount < cap` against a default
   * cap of one — so one unexpectedly-failed start put the window permanently at
   * its ceiling, and every drain after it returned at step 4 in silence. An
   * operator saw Retry and Start Queue do nothing at all, with no refusal in the
   * log and no audit event, until the window was reloaded.
   *
   * Hence the second caller, in `handleUnexpectedStartFailure` beside the
   * execution-lease release: the lease and the session are the two things a
   * terminal Run gives back, they are owed at the same moment, and they are both
   * owed before `scheduleAutoDrain()` so the sweep can see the slot. Being
   * idempotent and self-guarding is what makes asking twice the fix — a caller
   * that asks too early is told no and costs nothing, and the one that asks
   * after the terminal write is the one that gets an answer.
   *
   * The armed-gate guard does not strand the slot of a resume that was refused
   * after arming: the seam that refuses it (`admitResume`'s `finally`) disarms
   * the gate before asking, because a continuation no drive will consume is
   * spent. So every caller that legitimately wants an armed session gone says
   * so, rather than the reap guessing on their behalf.
   */
  public disposeIfEnded(queueId: string): boolean {
    const session = this.sessions.get(queueId);
    if (session === undefined) return false;
    if (session.driver.running) return false;
    if (session.isContinueGate.isArmed()) return false;
    const run = this.resolveRun(queueId);
    if (run !== null && !isTerminalRunStatus(run.status)) return false;
    this.sessions.delete(queueId);
    return true;
  }

  /**
   * The same question, asked of every queue at once: give back the slot of any
   * Run that has ended. Returns how many sessions went.
   *
   * ASK BEFORE COUNTING, NOT ONLY AFTER ENDING (2026-09-02)
   *
   * The note above records who owes a slot back and when. This one is the other
   * half — who is owed it, and how they came to read the count one Run early.
   *
   * `RunDriver.drive()` calls `scheduleAutoDrain()` from its own `finally`, and
   * the disposal for that Run is in `driveSession`'s `finally`, which is one
   * `await` further out: the drain is therefore *always* scheduled before the
   * Run that scheduled it has given its session back. `AutoDrainCoordinator`'s
   * steps 1 through 4 are synchronous, so the sweep's very first queue is
   * evaluated against a count that still includes the finished Run. Against the
   * default cap of one, step 4 reads `hasExecutionCapacity(1)` and refuses — in
   * silence, since a full ceiling is a wait rather than a fault — and nothing
   * re-triggers the sweep, because the trigger *was* the Run that just ended.
   *
   * A window with several queues hid it: the sweep awaits each queue in turn, and
   * those awaits are when the pending disposal lands, so a queue visited later in
   * the round-robin saw the freed slot and started. The queue that just finished
   * is the one visited with the count at its stalest, and a window holding one
   * queue has no later visit at all. So the shipped single-queue configuration —
   * `default`, cap 1 — stopped dead after every Task and waited for an operator
   * to press Start Queue, while `concurrency-cap.test.ts` T070 went on passing
   * because its terminating Run and its waiting Run are on different queues three
   * registry positions apart.
   *
   * Hence: reap where the count is taken rather than trusting each terminal path
   * to have finished its bookkeeping first. `size` above is that place and its
   * only caller — the cap asks how many Runs are live, and the honest answer
   * settles the sessions that have ended before it counts. Self-guarding is what
   * makes that safe: a driver mid-drive and a non-terminal (in particular
   * `paused`, RS-3) Run are both refused above, so this can only collect slots
   * that are already owed, and a caller that reaps too early is told no and costs
   * nothing.
   *
   * The terminal paths still dispose eagerly, and should. Giving a slot back at
   * the moment it stops being used is what keeps the window's accounting legible
   * in a log; this is the backstop for the one ordering they cannot fix from
   * where they stand.
   */
  public disposeEnded(): number {
    let disposed = 0;
    for (const queueId of [...this.sessions.keys()]) {
      if (this.disposeIfEnded(queueId)) disposed += 1;
    }
    return disposed;
  }
}
