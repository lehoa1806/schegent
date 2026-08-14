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

  /** Live sessions. RS-1: this is the number the cap bounds. */
  public get size(): number {
    return this.sessions.size;
  }

  public all(): readonly RunSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Dispose the queue's session iff its Run has ended (RS-3, RS-4, RS-5).
   *
   * Three conditions, each load-bearing:
   *
   *   - The driver must be idle. A session whose driver is mid-drive is by
   *     definition not finished, and disposing it would let the next `acquire`
   *     mint a second driver for a queue that already has one in flight.
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
   */
  public disposeIfEnded(queueId: string): boolean {
    const session = this.sessions.get(queueId);
    if (session === undefined) return false;
    if (session.driver.running) return false;
    const run = this.resolveRun(queueId);
    if (run !== null && !isTerminalRunStatus(run.status)) return false;
    this.sessions.delete(queueId);
    return true;
  }
}
