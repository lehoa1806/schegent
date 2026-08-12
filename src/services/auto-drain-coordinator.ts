// Feature 013 — Wave 7 (US7 / T099): auto-drain orchestration extracted
// from `WorkflowController`. Called from the `finally` block of
// `driveRun()`. Decides whether the next queued feature should be
// promoted to in-flight when a run terminates.
//
// Feature 092 (T051–T053, T066, US2) made the decision per queue. Three things
// changed and each is load-bearing:
//
//   - `drainIfIdle` is addressed: it takes a `queueId` and consults *that*
//     queue's state, capacity, pending head and execution lease. The gate chain
//     is the seven ordered steps of
//     contracts/concurrent-drain-and-leases.md §1.
//   - The exclusion step moved from the workspace lock to the per-queue
//     execution lease. Losing it means "another window is already draining this
//     queue", not "this window is no longer primary" — window primacy stays
//     with `WorkspaceLockManager`, whose semantics and diff are untouched
//     because it feeds `WorkflowSnapshot.isPrimary` and every mutating IPC gate.
//   - `drainAll()` sweeps the registry, and it does so from a round-robin
//     cursor so a saturated ceiling does not let position 0 win every sweep.

import { DEFAULT_QUEUE_ID } from '../queue/queue-registry';
import type { QueueManager } from '../queue/queue-manager';
import type { WorkspaceStateStore } from '../state/workspace-state';
import type { SchegentWorkflowController } from '../controller/workflow-controller';
import type { SanitizedLogger } from '../lib/logger';

/**
 * The slice of `ExecutionLeaseManager` the drain needs. Structural on purpose:
 * the coordinator never reclaims, heartbeats or enumerates leases, and a
 * narrower port keeps that visible.
 */
export interface ExecutionLeasePort {
  tryAcquire(queueId: string): Promise<{ acquired: boolean; ownerId: string }>;
  release(queueId: string): Promise<void> | void;
}

/**
 * Feature 092 (T066) — the audit surface, narrowed to the single event this
 * coordinator emits. Naming the literal rather than reusing the general
 * `LifecycleAuditHook` keeps the port from becoming a second general-purpose
 * writer: nothing else can be appended through it.
 */
export interface OverlapAuditPort {
  append(entry: {
    runId: string;
    phase: string;
    iteration: number;
    eventType: 'runs-overlapped';
    outcome: 'info';
    payload: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface AutoDrainCoordinatorDeps {
  readonly store: Pick<WorkspaceStateStore, 'getQueue' | 'getQueueRegistry'>;
  readonly queue: Pick<
    QueueManager,
    'peekNextPending' | 'hasQueueCapacity' | 'hasWorkspaceCapacity' | 'inFlightCount'
  >;
  readonly executionLease: ExecutionLeasePort;
  readonly controller: Pick<SchegentWorkflowController, 'startNew' | 'resumeExisting' | 'running'>;
  /**
   * Feature 092 (T066) — optional because the overlap record is the only thing
   * it feeds. Absent, the coordinator does no overlap bookkeeping at all, which
   * is what keeps the gate-order unit tests honest: they assert that no
   * collaborator past the failing step was consulted, and an unconditional
   * `inFlightCount()` would make that assertion untrue for reasons unrelated to
   * the gate under test.
   */
  readonly auditWriter?: OverlapAuditPort | null;
  readonly logger?: SanitizedLogger;
}

/** Two or more Runs in flight at the same instant (FR-038). */
const OVERLAP_THRESHOLD = 2;

export class AutoDrainCoordinator {
  private readonly store: AutoDrainCoordinatorDeps['store'];
  private readonly queue: AutoDrainCoordinatorDeps['queue'];
  private readonly executionLease: ExecutionLeasePort;
  private readonly controller: AutoDrainCoordinatorDeps['controller'];
  private readonly auditWriter: OverlapAuditPort | null;
  private readonly logger: SanitizedLogger | null;

  /**
   * Feature 092 (T053, FR-028a) — where the next sweep starts, as the registry
   * `position` of the queue this session promoted most recently, or `null`
   * before any promotion.
   *
   * In memory and per session by design. It is a fairness aid, not state: a
   * reload legitimately restarts at position zero, and persisting it would add
   * a write on the hottest path in the drain to buy nothing an operator could
   * observe.
   */
  private lastPromotedPosition: number | null = null;

  /**
   * Feature 092 (T066, FR-038) — whether an overlap episode is currently open.
   * An overlap is an episode, not a sample: it opens when the workspace's
   * in-flight count first reaches two and closes when it falls back below two,
   * so widening it with a third Run records nothing.
   */
  private overlapEpisodeOpen = false;

  constructor(deps: AutoDrainCoordinatorDeps) {
    this.store = deps.store;
    this.queue = deps.queue;
    this.executionLease = deps.executionLease;
    this.controller = deps.controller;
    this.auditWriter = deps.auditWriter ?? null;
    this.logger = deps.logger ?? null;
  }

  /**
   * Drain one queue. Resolves whether or not anything was promoted — every step
   * below is a reason to wait, and none of them is an error.
   */
  public async drainIfIdle(queueId: string = DEFAULT_QUEUE_ID): Promise<void> {
    await this.drainQueue(queueId);
  }

  /**
   * Feature 092 (T052, FR-024) — one sweep of every queue in the registry.
   *
   * Deliberately reads no lifecycle value and applies no lifecycle pre-filter.
   * The `idle-pending` gate lives at step 1 of `drainQueue` and nowhere else; a
   * filter here would be a second enforcement site wearing different clothes,
   * and the two would drift the first time one of them learned a new case.
   * Every queue is visited; each decides for itself.
   */
  public async drainAll(): Promise<void> {
    const entries = [...this.store.getQueueRegistry().entries].sort(
      (a, b) => a.position - b.position
    );
    if (entries.length === 0) return;
    await this.closeOverlapEpisodeIfEnded();
    // Fixed for the whole sweep. Recomputing it per iteration would let a
    // promotion move the cursor mid-sweep and revisit a queue this sweep has
    // already offered work to, while skipping one it has not — the opposite of
    // "exactly once per queue".
    const start = this.sweepStartIndex(entries);
    for (let offset = 0; offset < entries.length; offset += 1) {
      const entry = entries[(start + offset) % entries.length];
      const promoted = await this.drainQueue(entry.id);
      if (promoted) this.lastPromotedPosition = entry.position;
    }
  }

  /**
   * The seven ordered steps of contracts/concurrent-drain-and-leases.md §1.
   *
   * The order is load-bearing, not cosmetic. Step 3 ("this queue is busy") and
   * step 4 ("the workspace is at its ceiling") are different limits with
   * different meanings to the operator, and a drain that consulted the ceiling
   * first would attribute the wait to the wrong one.
   *
   * Returns whether a Run was started, which is what moves the round-robin
   * cursor. `drainIfIdle` discards it: its contract is to resolve to `undefined`
   * on every path.
   */
  private async drainQueue(queueId: string): Promise<boolean> {
    // Step 1 — Feature 065 (T010 / FR-003): an `idle-pending` queue MUST NOT
    // auto-promote. The scheduler (or an explicit operator restart via
    // `CMD_START_QUEUE`) owns the transition out of `idle-pending`. This is the
    // single enforcement site.
    const queueState = this.store.getQueue(queueId);
    if (queueState.queueLifecycle === 'idle-pending') return false;
    // Step 2 — paused by the operator or by a system pause.
    if (queueState.paused) return false;
    // Step 3 — this queue already has its one Task in flight.
    if (!this.queue.hasQueueCapacity(queueId)) return false;
    // Step 4 — the workspace is at its concurrency ceiling. A wait, not an
    // error: nothing is written and nothing is signalled, and the next sweep
    // (from a different cursor position) will try again.
    if (!this.queue.hasWorkspaceCapacity()) return false;
    // Step 4b — the shared Run engine is already driving a Run.
    //
    // This step is a limit of the *engine*, not of the queue model, and it is
    // the one place the two disagree. `KEYS.run` holds a single `WorkflowRun`
    // (FR-008 guarantee 3 froze that on purpose) and `WorkflowController` owns
    // a single `RunDriver` whose `drive()` returns immediately when it is
    // already running. So a second concurrent `startNew` would persist its run
    // over the first one's record and then never spawn anything — leaving one
    // Task in flight with no process behind it and the other Run addressable
    // only through a record that no longer describes it.
    //
    // Waiting here is the same shape as step 4: nothing is written, nothing is
    // signalled, and the next sweep — from a different cursor position, so not
    // the same queue every time — tries again. It is deliberately a gate rather
    // than a lower `globalConcurrencyCap`, because the ceiling is an operator
    // setting about how many queues MAY run and this is a fact about what the
    // engine can currently drive. When the Run record becomes per queue, this
    // step is deleted and nothing above or below it changes.
    if (this.controller.running) return false;
    // Step 5 — this queue's pending head, in FIFO order.
    const next = this.queue.peekNextPending(queueId);
    if (!next) return false;
    // Step 6 — claim this queue's execution lease. Losing it means another
    // window is draining this queue right now.
    const acquired = await this.executionLease.tryAcquire(queueId);
    if (!acquired.acquired) return false;
    // Step 7 — start.
    try {
      // If the pending task still carries a runId (preserved by the
      // retry path when the active workspace run matches), try to resume
      // the existing run so the pipeline picks up from the failed phase
      // instead of restarting from scratch.
      if (next.runId) {
        const resumed = await this.controller.resumeExisting();
        if (resumed) {
          await this.openOverlapEpisodeIfStarted(queueId);
          return true;
        }
        // Fall through to startNew if the run cannot be resumed
        // (e.g. the persisted run no longer matches).
      }
      await this.controller.startNew(next, null);
      await this.openOverlapEpisodeIfStarted(queueId);
      return true;
    } catch (err) {
      // Release the lease we acquired — if startNew throws before
      // RunDriver.drive() enters its own scope, this queue would stay
      // claimed until STALENESS_THRESHOLD_MS (15s).
      await Promise.resolve(this.executionLease.release(queueId)).catch(() => undefined);
      this.logger?.warn(
        `auto-drain: controller.startNew failed: ${(err as Error).message}`
      );
      return false;
    }
  }

  /** Where this sweep begins: just past the queue promoted most recently. */
  private sweepStartIndex(entries: readonly { position: number }[]): number {
    if (this.lastPromotedPosition === null) return 0;
    const previous = entries.findIndex((e) => e.position === this.lastPromotedPosition);
    // A `-1` here means the queue we last promoted has since been deleted, and
    // `(-1 + 1) % n` restarts the sweep at the head — the same place a fresh
    // session starts, which is the right answer when the cursor's referent is
    // gone.
    return (previous + 1) % entries.length;
  }

  /**
   * Feature 092 (T066, FR-038) — open an overlap episode if this start is the
   * one that made the workspace concurrent, and record it exactly once.
   */
  private async openOverlapEpisodeIfStarted(queueId: string): Promise<void> {
    if (!this.auditWriter) return;
    if (this.overlapEpisodeOpen) return;
    const inFlight = this.queue.inFlightCount();
    if (inFlight < OVERLAP_THRESHOLD) return;
    this.overlapEpisodeOpen = true;
    await this.appendOverlapAudit(queueId);
  }

  /** The episode ends when the workspace falls back below two Runs in flight. */
  private async closeOverlapEpisodeIfEnded(): Promise<void> {
    if (!this.auditWriter) return;
    if (!this.overlapEpisodeOpen) return;
    if (this.queue.inFlightCount() < OVERLAP_THRESHOLD) this.overlapEpisodeOpen = false;
  }

  /**
   * FR-023a's core payload plus `queueIds`. Identifiers only — FR-038a: a queue
   * name is operator-authored content and never reaches the audit log, and
   * neither does a Task description. Best-effort: a failed append must not
   * unstart a Run that is already executing.
   */
  private async appendOverlapAudit(queueId: string): Promise<void> {
    const queueIds = [...this.store.getQueueRegistry().entries]
      .sort((a, b) => a.position - b.position)
      .map((entry) => entry.id)
      .filter((id) => this.queue.inFlightCount(id) > 0);
    try {
      await this.auditWriter?.append({
        runId: '',
        phase: 'concurrency',
        iteration: 0,
        eventType: 'runs-overlapped',
        outcome: 'info',
        payload: {
          queueId,
          eventType: 'runs-overlapped',
          occurredAt: Date.now(),
          transitionReason: 'concurrent-run-started',
          queueIds
        }
      });
    } catch (err) {
      this.logger?.warn(`overlap audit append failed: ${(err as Error).message}`);
    }
  }
}
