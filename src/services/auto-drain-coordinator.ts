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
import type { FeatureRequest } from '../queue/feature-request';
import type { QueueManager } from '../queue/queue-manager';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { isTerminalRunStatus } from '../state/workflow-run';
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
  /**
   * Feature FR-R3-003 (T301) — the point-of-effect check on the fencing token
   * step 6 was granted, read from the arbitrated record rather than the mirror.
   *
   * Optional so the doubles that predate the feature keep working; when it is
   * absent the drain admits on step 6's outcome alone, which is what it did
   * before. When it is present and answers `false`, the queue is given back and
   * nothing starts — a claim that cannot be proved at the moment of effect is not
   * a claim, and on a shared working tree the cost of admitting anyway is two
   * windows' Runs in one tree.
   */
  hasLease?(queueId: string): Promise<boolean>;
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
  readonly store: Pick<WorkspaceStateStore, 'getQueue' | 'getQueueRegistry' | 'getRun'>;
  readonly queue: Pick<
    QueueManager,
    | 'peekNextPending'
    | 'hasQueueCapacity'
    | 'hasWorkspaceCapacity'
    | 'hasExecutionCapacity'
    | 'inFlightCount'
  >;
  readonly executionLease: ExecutionLeasePort;
  /**
   * Feature 093 (T049a) — the drain names the *admission* pair, not `startNew` /
   * `resumeExisting`. Narrowing the port this way is the enforcement: a future
   * edit cannot reintroduce the completion-awaiting call here without widening
   * this type first, which is a visible decision rather than a one-word slip.
   *
   * (T081) `running` left this list with step 4b. The same enforcement now
   * covers the deleted gate: reintroducing "the engine is busy, so wait" means
   * widening this type first. What replaced it is `liveRunCount` — the count
   * step 4 measures the cap against, which is a different question from whether
   * any driver is mid-phase (a paused Run holds its slot and is not running).
   */
  readonly controller: Pick<
    SchegentWorkflowController,
    'admitNew' | 'admitResume' | 'liveRunCount'
  >;
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

  /**
   * Feature 093 (T049) — the sweep guard.
   *
   * `drainAll()` is triggered fire-and-forget from `scheduleAutoDrain()`, once
   * per terminating Run, so with N Runs in flight N sweeps can be asked for at
   * once. Both mutable fields above survive an await inside the loop —
   * `lastPromotedPosition` is written after each promotion and read once per
   * sweep to fix `start`, and `overlapEpisodeOpen` is closed at the top of a
   * sweep and opened inside it. Two interleaved sweeps would therefore move the
   * cursor under each other's fixed `start`, revisiting one queue while skipping
   * another, and would close an episode the other sweep is still inside.
   *
   * So a second sweep does not run concurrently: it records that a sweep was
   * asked for and joins the one in progress, which repeats until no request is
   * outstanding. Coalescing rather than dropping, because the request is a real
   * signal — a Run terminated and freed a slot — and a queue the current sweep
   * has already passed may have become eligible since. Coalescing rather than
   * queueing, because N simultaneous terminations warrant one further round of
   * offers, not N identical ones.
   *
   * This is only correct because step 7 no longer awaits the Run it starts
   * (T049a). Held across a Run's execution, the guard would serialize precisely
   * what this feature exists to parallelize.
   */
  private sweepInFlight: Promise<void> | null = null;
  private sweepRequested = false;

  /**
   * Feature 093 (T049) — the per-queue half of the same guard: which queues have
   * a drain in progress right now.
   *
   * `drainIfIdle(queueId)` is addressed and must stay concurrent with a sweep of
   * the *other* queues, so it does not join `sweepInFlight`. But the two can
   * both be draining the same queue, and every gate between step 1 and step 7 is
   * read before the admission that would close them: two drains of one queue can
   * both see capacity, both peek the same pending head, and both start it. Step
   * 4b masked that while it existed, by refusing every second start for an
   * unrelated reason; T081 deleted it, so this set is now the only thing
   * standing between two drains of one queue and a double start.
   */
  private readonly drainingQueues = new Set<string>();

  /**
   * Feature 093 (T049a) — the Runs this coordinator started that have not yet
   * reached a terminal status. See `detach` and `settled` below.
   */
  private readonly detachedDrives = new Set<Promise<unknown>>();

  /**
   * Feature 093 (bulk review) — starts this coordinator has committed to but
   * that no capacity reading can see yet.
   *
   * Step 4 reads its counts synchronously; the admission it guards is several
   * awaits away — the lease acquire, then `admitNew`'s factory, `setRun` and
   * `markInFlight` before `sessions.size` grows. For that whole window both
   * readings of the ceiling are stale, and neither is wrong in a way it can
   * detect: the Run genuinely does not exist yet.
   *
   * Within one sweep that is harmless, because the loop awaits each queue's
   * drain before starting the next. `drainIfIdle` is the case that is not: it
   * stays concurrent with a sweep by design, so an operator's Start Queue or a
   * scheduled start can pass step 4 on the strength of a slot a suspended sweep
   * has already spent. Both admit and the cap is exceeded by one.
   *
   * Step 4b hid this while it stood — it refused every second concurrent start
   * outright — so deleting it (T081) is what opened the window rather than what
   * created it. The counter closes it by making the gate count intent as well as
   * fact: incremented synchronously in the same continuation that read the
   * counts, so no drain can observe the pre-increment value, and released in a
   * `finally` so a drain that goes on to start nothing gives the slot back.
   *
   * Only the execution-capacity reading is adjusted. `hasWorkspaceCapacity` is
   * the cross-window count, and a rival window's admissions are bounded by the
   * per-queue execution lease, not by a counter local to this object.
   */
  private reservedStarts = 0;

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
    if (this.sweepInFlight !== null) {
      this.sweepRequested = true;
      await this.sweepInFlight;
      return;
    }
    this.sweepInFlight = this.sweepUntilNoneRequested();
    await this.sweepInFlight;
  }

  /** Sweep, then sweep again for whatever was asked for while we swept. */
  private async sweepUntilNoneRequested(): Promise<void> {
    try {
      do {
        this.sweepRequested = false;
        await this.sweep();
      } while (this.sweepRequested);
    } finally {
      // Cleared in the same synchronous continuation that read
      // `sweepRequested === false`. Clearing it from `drainAll`'s own `finally`
      // would put an await between the two, and a request arriving in that
      // window would join a sweep that had already decided not to run again —
      // a dropped trigger, which is the one thing coalescing must not do.
      this.sweepInFlight = null;
    }
  }

  private async sweep(): Promise<void> {
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
    // Step 0 — Feature 093 (T049): this queue already has a drain deciding for
    // it. A wait of the same shape as every step below: nothing is written,
    // nothing is signalled, and the Task stays pending for the next sweep.
    if (this.drainingQueues.has(queueId)) return false;
    this.drainingQueues.add(queueId);
    try {
      return await this.drainQueueOnce(queueId);
    } finally {
      this.drainingQueues.delete(queueId);
    }
  }

  private async drainQueueOnce(queueId: string): Promise<boolean> {
    // Step 1 — Feature 065 (T010 / FR-003): an `idle-pending` queue MUST NOT
    // auto-promote. The scheduler (or an explicit operator restart via
    // `CMD_START_QUEUE`) owns the transition out of `idle-pending`. This is the
    // single enforcement site.
    const queueState = this.store.getQueue(queueId);
    if (queueState.queueLifecycle === 'idle-pending') return false;
    // Step 2 — paused by the operator or by a system pause. FR-R3-011 — read
    // off the discriminator, the same field step 1 reads. This used to read the
    // legacy `paused` mirror, which the v13 collapse retired to migration input:
    // a record written after the collapse carries no `paused`, so the old read
    // was `undefined` on every queue and this step stopped refusing anything.
    if (queueState.queueLifecycle === 'operator-paused') return false;
    // Step 3 — this queue is busy. One limit, two readings, on the same terms as
    // step 4 below: neither subsumes the other, so a start needs both.
    //
    // `hasQueueCapacity` counts the queue's in-flight **Task rows**, which is the
    // reading that has always been here. BUG-003 — a Task row leaves that count
    // the moment its Run pauses, while the Run itself keeps the queue's one Run
    // slot, its session and its execution lease. So a paused Run was invisible to
    // every gate in this sequence, and step 7's `admitNew` overwrote its record
    // with the successor's: `setRun(queueId, run)` is a whole-map write and
    // `KEYS.run` holds one Run per queue, so the paused Run was simply gone. No
    // refusal, no audit event, and its Task row stranded at `paused` forever.
    //
    // The second reading asks the Run map directly, which is the authority on
    // whether this queue holds a Run — the Task rows are a projection of it that
    // a pause deliberately removes from the count. Terminal is
    // `isTerminalRunStatus`, the same enumeration `disposeIfEnded` and the
    // execution-lease release read, rather than a locally derived
    // `status !== 'running'` — which would also admit `paused` and reopen exactly
    // this hole.
    //
    // This is a wait of the same shape as every other step: nothing is written,
    // nothing is signalled, the Task stays pending, and the queue drains normally
    // once the operator resumes or cancels the Run that holds it. In particular
    // it sits **before** step 6's `tryAcquire`, so the paused Run's execution
    // lease is never touched — a refusal after the acquire would reach step 7's
    // release path and strip the lease out from under a Run that still owns it.
    if (!this.queue.hasQueueCapacity(queueId)) return false;
    const occupant = this.store.getRun(queueId);
    if (occupant !== null && !isTerminalRunStatus(occupant.status)) return false;
    // Step 4 — the workspace is at its concurrency ceiling. A wait, not an
    // error: nothing is written and nothing is signalled, and the next sweep
    // (from a different cursor position) will try again.
    //
    // Feature 093 (T072, FR-014, RS-1) — one gate, two readings of the same
    // operator setting, and a start needs both. `hasExecutionCapacity` measures
    // the Runs this window is actually driving (`sessions.size`), which is what
    // FR-014 says the cap is for and what the pre-feature reading could not see;
    // `hasWorkspaceCapacity` keeps counting persisted in-flight Task rows, which
    // is the workspace-wide reading a second window's Runs also land in. Neither
    // subsumes the other, so dropping either would widen the ceiling somewhere.
    // This stays a single conjunctive predicate at the one existing gate — T074
    // and CLAUDE.md's "no second enforcement site" rule are about *where* the
    // decision is made, and it is made here.
    //
    // `reservedStarts` is added to the driven-Run count so the gate counts the
    // starts already committed to but not yet observable. See the field's own
    // note: without it a concurrent addressed drain spends a slot a suspended
    // sweep has already claimed.
    if (
      !this.queue.hasExecutionCapacity(this.controller.liveRunCount + this.reservedStarts)
    ) {
      return false;
    }
    if (!this.queue.hasWorkspaceCapacity()) return false;
    // Feature 093 (T081, FR-011) — step 4b stood here and is gone. It refused a
    // second concurrent start because `KEYS.run` held one `WorkflowRun` and the
    // controller owned one `RunDriver`, so a second `startNew` would have
    // persisted its run over the first one's record. The v10 → v11 migration
    // makes the record per queue and the controller keeps a `RunSession` per
    // queue, so the disagreement between the queue model and the engine that
    // step existed to absorb no longer exists. Nothing above or below it moved:
    // step 4's capacity check is still the one place the concurrency ceiling is
    // enforced, and it now bounds Runs that genuinely execute at once.
    // Step 5 — this queue's pending head, in FIFO order.
    const next = this.queue.peekNextPending(queueId);
    if (!next) return false;
    // Everything from step 1 to here has been synchronous, so this is the first
    // point at which another drain could interleave — and the last at which this
    // one can still take the slot it was just granted. Reserved here rather than
    // at the gate so a drain that stops at step 5 never holds one.
    this.reservedStarts += 1;
    try {
      return await this.startPendingHead(queueId, next);
    } finally {
      this.reservedStarts -= 1;
    }
  }

  /**
   * Steps 6 and 7 — claim the queue's lease and admit its head.
   *
   * Split out so the reservation above has an unmistakable scope: it is held for
   * exactly this call and released on every exit, including the throw the step-7
   * `catch` re-reports as a warning.
   */
  private async startPendingHead(
    queueId: string,
    next: FeatureRequest
  ): Promise<boolean> {
    // Step 6 — claim this queue's execution lease. Losing it means another
    // window is draining this queue right now.
    const acquired = await this.executionLease.tryAcquire(queueId);
    if (!acquired.acquired) return false;
    // Feature FR-R3-003 (T301) — re-check the token between the claim and the
    // start. Step 6 and step 7 are two awaits apart, and the interval is exactly
    // where a stalled window used to be reclaimed and then start anyway.
    if (this.executionLease.hasLease && !(await this.executionLease.hasLease(queueId))) {
      await Promise.resolve(this.executionLease.release(queueId)).catch(() => undefined);
      this.logger?.warn(
        `auto-drain: execution lease for queue ${queueId} could not be verified at start; not admitting`
      );
      return false;
    }
    // Step 7 — start.
    try {
      // If the pending task still carries a runId (preserved by the
      // retry path when the active workspace run matches), try to resume
      // the existing run so the pipeline picks up from the failed phase
      // instead of restarting from scratch.
      if (next.runId) {
        // Feature 093 (T039) — pattern A: the queue is already the subject of
        // this drain, so the resume names it rather than reaching for whatever
        // Run happened to be persisted.
        const resume = await this.controller.admitResume(queueId);
        if (resume.resumed) {
          this.detach(queueId, resume.completed);
          await this.openOverlapEpisodeIfStarted(queueId);
          return true;
        }
        // Fall through to a fresh start if the run cannot be resumed
        // (e.g. the persisted run no longer matches).
      }
      // Feature 093 (T049a) — awaited to admission, not to completion. The Task
      // is in flight by the time this resolves, so the rest of the sweep reads
      // current capacity; the Run itself proceeds alongside it.
      const admission = await this.controller.admitNew(next, null);
      this.detach(queueId, admission.completed);
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

  /**
   * Feature 093 (T049a) — let an admitted Run proceed without the drain.
   *
   * `completed` resolves at the Run's terminal transition, and the sweep has no
   * further interest in it: the terminal path owns the record write, the lease
   * release and the next sweep's trigger. What the drain must not do is drop the
   * promise on the floor — an unobserved rejection is a process-level warning in
   * the Extension Host, and this one would name a Run the operator can see.
   *
   * It is retained, not merely observed, because "the sweep finished" and "the
   * Runs it started finished" became two different moments the instant the drain
   * stopped awaiting completion. `settled()` below is how the second one is
   * asked for; without the retention there would be nothing left to ask.
   */
  private detach(queueId: string, completed: Promise<void>): void {
    const observed = completed
      .catch((err) =>
        this.logger?.warn(
          `auto-drain: run on queue ${queueId} ended abnormally: ${(err as Error).message}`
        )
      )
      .finally(() => {
        this.detachedDrives.delete(observed);
      });
    this.detachedDrives.add(observed);
  }

  /**
   * Feature 093 (T049a) — resolve once every Run this coordinator has started is
   * over.
   *
   * Deliberately not folded into `drainAll()`: awaiting there is the
   * serialization this feature removes. This is the separate question, for the
   * callers that genuinely have to know — an orderly disposal that must not tear
   * the host down mid-Run, and tests asserting on a Run's terminal state.
   *
   * The loop re-reads the set because a Run may start another sweep as it
   * terminates, and that sweep's Runs are new members. It converges when a pass
   * adds nothing, which is the same fixpoint `drainAll`'s own re-sweep uses.
   */
  public async settled(): Promise<void> {
    while (this.detachedDrives.size > 0) {
      await Promise.allSettled([...this.detachedDrives]);
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
