// QueueManager — the workspace's queues, up to `MAX_QUEUES` (FR-R3-145, T1569).
//
// `'default'` is the canonical queue defined in `queue-registry`, and the one a
// call that names no queue id lands on. The manager exposes pause/resume + task-level
// mutators (reorder, modify, remove, retry, clear) plus the helpers a
// drain pass calls (peekNextPending, hasCapacity, markInFlight, finish).
//
// Those four were called "pump helpers" until the lifecycle round-check of
// 2026-08-30. Nothing pumps. `AutoDrainCoordinator` is edge-triggered, and a
// caller that returns a row to `pending` and waits will wait forever — which is
// the bug that round-check was opened on. The word is avoided here because this
// header is where a reader forms the model.
//
// Feature 030 removed the multi-queue management surface and its v6 migration
// coalesced prior multi-queue state into the single `'default'` entry; Feature
// 092 brought the surface back, so create/rename/delete/move-between/save queue
// settings are live methods below. No caller attaches a schedule — the one call
// to `setQueueSchedule` clears one — so the `fireDueSchedules` watchdog path is
// a no-op in practice (the function is retained for migration robustness and to
// keep the watchdog wiring stable).
//
// Pause semantics (preserved):
//   - operator pause/resume: `setQueuePausedState`
//   - cascade pause/resume:  `cascadedPause`, `cascadedResume`
//     (cascade is overridden by an explicit operator pause; cascadedResume
//      is a strict no-op when the entry's `pauseSource !== 'cascade'`.)
import { DEFAULT_QUEUE_ID } from '../contracts/queue-identity';
import type { QueueFailurePolicy } from '../contracts/queue-failure-policy';
import { errorMessage } from '../lib/errors';
import { randomUUID } from 'crypto';
import {
  MAX_GLOBAL_CONCURRENCY_CAP,
  QueueMutationRejected,
  type WorkspaceStateStore
} from '../state/workspace-state';
import type { WorkflowRun } from '../state/workflow-run';
import { resolveBoundQueueId } from '../state/connected-workflow-run';
import type { FrozenRunPlan } from '../contracts/run-request';
import type { SanitizedLogger } from '../lib/logger';
import {
  createQueue,
  deleteQueue,
  findQueue,
  renameQueue,
  setQueueSchedule,
  QueueRegistryViolation,
  type QueuePauseSource
} from './queue-registry';
import {
  type FeatureRequest,
  type FeatureRequestFailure,
  type FeatureRequestPauseCause,
  type FeatureRequestRerun,
  type FeatureRequestStatus,
  type QueueState,
  type TerminalRequestStatus,
  validateDescription
} from './feature-request';
import { terminalCapture, withoutTerminalCapture } from './terminal-capture';
import { withRefreshedLifecycle } from './queue-lifecycle-refresh';
import { hasResettableQueueState, queueResetFields } from './queue-reset-settle';
import { decideTaskTransition, type TaskTransitionRejectionReason } from './task-transition-decision';

export interface MutationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Code-review fix (2026-09-03) — `finish`/`pause`/`retry` each catch
 * `QueueMutationRejected` to convert an *ineligible transition* (decided by
 * `decideTaskTransition`) into their own `{ ok: false, reason }` result.
 * `store.updateQueue`'s own commit-fence check (`checkCommitFence`) throws the
 * SAME error class for an unrelated reason — a stale or unverifiable
 * ownership fence — and that failure must keep propagating exactly as it did
 * before FR-R3-153, so an existing caller's own try/catch (which logs it)
 * still sees it instead of a silently-discarded `{ ok: false }`. This is the
 * closed vocabulary `decideTaskTransition` itself can produce; anything else
 * (including every commit-fence reason) is re-thrown by
 * `isTaskTransitionRejection` below.
 */
const TASK_TRANSITION_REJECTION_REASONS: ReadonlySet<string> = new Set<TaskTransitionRejectionReason>([
  'task-not-found',
  'queue-mismatch',
  'illegal-source-status',
  'in-flight-ownership-conflict'
]);

function isTaskTransitionRejection(err: unknown): err is QueueMutationRejected {
  return err instanceof QueueMutationRejected && TASK_TRANSITION_REJECTION_REASONS.has(err.reason);
}

export interface ClearResult {
  removed: number;
}

// FR-R3-150 (T1621) — widens `ClearResult` with the `ok`/`reason` shape the
// rest of this file already uses for a refusable mutation (`MutationResult`,
// `setQueuePausedState`'s registry check); `ok`/`reason` are additive, so
// every existing `.removed`-only reader stays correct unchanged. Named for
// both `clearByStatus` siblings (renamed from `ClearCompletedResult`).
export interface ClearByStatusResult extends ClearResult {
  readonly ok: boolean;
  readonly reason?: 'unknown-queue-id';
}

// Feature 063 (FR-005 / data-model §CleanAllResetOperation) — result of
// `QueueManager.clearAll()`. The handler passes this through to the
// audit writer (verbatim) and uses it to decide which toast (if any)
// to surface to the operator.
export interface CleanAllResult {
  readonly removed: {
    readonly pending: number;
    readonly completed: number;
    readonly failed: number;
    readonly canceled: number;
  };
  readonly inflightAborted: boolean;
  readonly runnerAcked: boolean;
  readonly pauseCleared: boolean;
  // Pre-clear pause source on the canonical queue; null if not paused.
  readonly pauseSource: 'operator' | 'cascade' | 'retry-cap' | null;
  readonly activeRunCleared: boolean;
  readonly watchdogCleared: boolean;
  // FR-R3-150 (T1619c) — `true` when at least one queue carried an armed
  // scheduled start that this reset disarmed. On the result for the same
  // reason `ClearQueueResult.scheduleCleared` is: FR-009 wants the recorded
  // history to state what the action affected, and a disarmed timer is
  // otherwise only inferable from a start that never came.
  readonly scheduleCleared: boolean;
  // `true` when ALL pre-state fields were already empty — the handler
  // uses this to skip emitting an audit event for the no-op case
  // (contracts/cmd-clear-all.md §Idempotency).
  readonly wasNoop: boolean;
}

// Feature 063 — optional runner-ack callback. The handler injects a
// closure that wraps `WorkflowController.cancelActive()` plus a
// `runDriver.running`-poll race against a 2s timer. `null` when no
// in-flight task existed (we never have to wait on the runner).
export type CleanAllRunnerAckProbe = () => Promise<boolean>;

// FR-R3-150 (T1619, LC-Q-01/LC-Q-05) — queue-scoped Clean All. `clearAll()`
// above resets every queue; `clearQueue()` below resets exactly one,
// addressed by `queueId`. It is *not* implemented by filtering the
// workspace-wide write (a queue-scoped reset is never derived that way —
// see `clearQueue()`'s own header comment).
//
// Code-review finding — research.md D2's "compose `clearAll()` over this" is
// closed as will-not-implement (tasks.md T1619b, 2026-09-03). What the two
// methods genuinely share is the per-queue field write and the no-op
// predicate, and those are extracted to `queue-reset-settle.ts`, whose header
// records why the methods themselves stay separate.
//
// A discriminated union rather than a result with optional fields, on the
// same precedent as `QueueDeletionImpact` above: a refusal has no impact to
// report, and a cleared queue has no reason.
export type ClearQueueResult =
  | { readonly outcome: 'refused'; readonly reason: 'unknown-queue-id' }
  | {
      readonly outcome: 'cleared';
      readonly queueId: string;
      readonly wasNoop: boolean;
      readonly removed: {
        readonly pending: number;
        readonly completed: number;
        readonly failed: number;
        readonly canceled: number;
      };
      readonly inflightAborted: boolean;
      readonly runnerAcked: boolean;
      readonly pauseCleared: boolean;
      readonly pauseSource: QueuePauseSource;
      readonly activeRunCleared: boolean;
      readonly scheduleCleared: boolean;
      readonly lifecycle: 'active-empty';
    };

export interface QueueMutationDetail extends MutationResult {
  queueId?: string;
  taskId?: string;
  priorStatus?: FeatureRequestStatus;
  runId?: string | null;
  taskCount?: number;
  /**
   * Feature 092 (T083, FR-016a) — how many connected-run aggregates a queue
   * deletion terminated. Separate from `taskCount` because they count different
   * things: a queue may hold pending Tasks and no aggregate, or an aggregate
   * sitting between nodes and no Tasks at all.
   */
  connectedRunCount?: number;
  disposition?: 'move' | 'cancel';
  fromName?: string;
  toName?: string;
  /**
   * Feature 034 — additive optional field populated by
   * `WorkflowController.deleteTask` after the session-cleanup helper
   * resolves. `true` iff BOTH the session-root directory removal and
   * the raw transcript file removal succeeded (or the targets were
   * already absent — `force: true` converts ENOENT to success). `false`
   * when cleanup was skipped (runId === null) OR at least one sub-op
   * raised a caught error. The optionality on the interface
   * accommodates existing test fixtures that build a partial result;
   * production code paths always populate it on `ok: true`.
   */
  sessionCleaned?: boolean;
  /**
   * Feature FR-R3-005 (T327) — present only when the cleanup was refused
   * because containment could not be proven, which is a different operator
   * action from a cleanup that ran and failed. Bounded and path-free.
   */
  sessionCleanupRefusal?: 'not-contained' | 'resolve-failed';
}

/**
 * Feature 092 (T031, US1) — what `CMD_DELETE_QUEUE` needs to know before it
 * either refuses or asks the operator to confirm.
 *
 * A discriminated union rather than a result with optional fields: a refusal
 * has no impact to report, and a deletable queue has no reason.
 */
export type QueueDeletionImpact =
  | { readonly outcome: 'refused'; readonly reason: string }
  | {
      readonly outcome: 'deletable';
      readonly queueId: string;
      readonly pendingTaskCount: number;
      readonly boundConnectedRunIds: readonly string[];
    };

// BUG-001 (FR-022): idempotent rejection reasons → DEBUG, not WARN.
// Feature 195 (T036) — 'failure-policy-unchanged' joins this set for the
// same reason: the operator asked for the state the queue is already in.
const IDEMPOTENT_REJECT_REASONS: ReadonlySet<string> = new Set([
  'not-paused',
  'already-paused',
  'failure-policy-unchanged'
]);

/**
 * Feature 092 (T050, FR-025) — how many Tasks one queue may run at once.
 *
 * Deliberately not operator-configurable and deliberately not the workspace
 * ceiling. `markInFlight`'s `inFlightId` refusal already encodes this number
 * structurally (one slot, one id); the constant names it so the drain's step 3
 * and that refusal are visibly the same bound rather than two agreeing
 * accidents.
 */
const PER_QUEUE_CAPACITY = 1;

/**
 * Feature 065 — minimal hook that the QueueManager's pause/resume paths
 * use to cancel an outstanding scheduled-start timer when the queue
 * leaves `idle-pending` via an operator pause (FR-019). Kept structural
 * so unit tests can satisfy it without importing the coordinator.
 *
 * Feature 092 (T059, FR-030) — widened from the single `'pause-cancel'`
 * literal to the two reasons this file actually passes: a pause still
 * cancels with `'pause-cancel'`, and a deletion disarms with
 * `'operator-cancel'`. The reason vocabulary is owned by
 * `SchedulerCancelReason` in `../services/scheduled-start-coordinator`;
 * this is a deliberate narrowing of it, not a fork, so the hook stays
 * structural and a coordinator that accepts the full vocabulary remains
 * assignable to it.
 */
export interface ScheduledStartCancelHook {
  cancel(queueId: string, reason: 'pause-cancel' | 'operator-cancel'): Promise<void> | void;
}

/**
 * Feature 065 — minimal hook for emitting `scheduled-start-canceled`,
 * `idle-pending-entered`, `idle-pending-exited` from the pause/resume
 * writer when a lifecycle transition occurs. Kept structural so unit
 * tests can supply a vi.fn().
 */
export interface LifecycleAuditHook {
  append(entry: {
    runId: string;
    phase: string;
    iteration: number;
    eventType: string;
    outcome: 'info' | 'success';
    payload: Record<string, unknown>;
  }): Promise<unknown>;
}

// Code-review finding (reuse) — the one fold both `clearAll()` and
// `clearQueue()` need: how many of a set of Tasks are in each terminal-or-
// pending status. Shared so the four-branch chain (and any status the two
// resets grow to need) is written once. `clearAll()` calls this once per
// queue over a workspace-wide loop; `clearQueue()` calls it once over a
// single queue's own `requests`.
function countRemovedByStatus(requests: readonly FeatureRequest[]): {
  pending: number;
  completed: number;
  failed: number;
  canceled: number;
} {
  const removed = { pending: 0, completed: 0, failed: 0, canceled: 0 };
  for (const r of requests) {
    if (r.status === 'pending') removed.pending++;
    else if (r.status === 'completed') removed.completed++;
    else if (r.status === 'failed') removed.failed++;
    else if (r.status === 'canceled') removed.canceled++;
  }
  return removed;
}

export class QueueManager {
  private readonly store: WorkspaceStateStore;
  /** Feature 019 — optional debug logger; absent in unit tests. */
  private readonly logger: SanitizedLogger | null;
  // Feature 065 — late-injected optional dependencies used by the
  // pause/resume writer to cancel outstanding schedules and emit the
  // lifecycle audit trail. Both are optional so existing callers and
  // tests that don't touch the pause path are unaffected.
  private scheduledStartCancelHook: ScheduledStartCancelHook | null = null;
  private lifecycleAuditHook: LifecycleAuditHook | null = null;

  constructor(store: WorkspaceStateStore, logger?: SanitizedLogger) {
    this.store = store;
    this.logger = logger ?? null;
  }

  /** Feature 065 — wire the schedule-cancel hook (called from `extension.ts`). */
  public setScheduledStartCancelHook(hook: ScheduledStartCancelHook | null): void {
    this.scheduledStartCancelHook = hook;
  }

  /** Feature 065 — wire the lifecycle audit hook (called from `extension.ts`). */
  public setLifecycleAuditHook(hook: LifecycleAuditHook | null): void {
    this.lifecycleAuditHook = hook;
  }

  /**
   * Feature 092 (T027, FR-007) — one queue's Tasks, addressed by id.
   *
   * The default keeps every pre-feature call site meaning what it meant: the
   * reserved queue is where an un-addressed enqueue lands, so it is also where
   * an un-addressed read looks. `listAll()` is the deliberate opposite and the
   * only way to see across queues.
   */
  public list(queueId: string = DEFAULT_QUEUE_ID): FeatureRequest[] {
    return this.store.getQueue(queueId).requests.slice();
  }

  /** Every queue's Tasks, in queue order then position order. */
  public listAll(): FeatureRequest[] {
    return Object.values(this.store.getQueueStates()).flatMap((queue) =>
      queue.requests.slice().sort((a, b) => a.position - b.position)
    );
  }

  /**
   * Feature 092 (T027, FR-007) — the next pending Task on one queue.
   *
   * Was `registry.entries[0]` under the v6 single-entry invariant. The entry is
   * now looked up by id, because position 0 is no longer a synonym for the
   * reserved queue: FR-002 dropped the positional assertions and `'default'`
   * may legally sit anywhere in the list.
   *
   * The old `r.queueId !== DEFAULT_QUEUE_ID` filter is gone rather than
   * parameterised. Under v10 the map key partitions the Tasks, so a row read
   * out of `getQueue(queueId)` is by construction that queue's; re-filtering on
   * the row's own field would make the projection depend on two authorities
   * that a write is not free to disagree on.
   */
  public peekNextPending(queueId: string = DEFAULT_QUEUE_ID): FeatureRequest | null {
    if (!findQueue(this.store.getQueueRegistry(), queueId)) return null;
    // FR-R3-011 — pausedness is read from the queue's own record, not from a
    // registry entry that used to carry a copy of it. The registry lookup above
    // stays: it answers a different question — whether the queue exists at all.
    const queue = this.store.getQueue(queueId);
    if (queue.queueLifecycle === 'operator-paused') return null;
    const requests = queue.requests;
    let best: FeatureRequest | null = null;
    for (const r of requests) {
      if (r.status !== 'pending') continue;
      if (best === null || r.position < best.position) {
        best = r;
      }
    }
    return best;
  }

  /**
   * Feature 092 (T027) — in-flight count, per queue or workspace-wide.
   *
   * An omitted `queueId` means *the workspace*, not the reserved queue: this
   * feeds `hasWorkspaceCapacity()`, which compares against a workspace-wide
   * ceiling, and before v10 the single `QueueState` made the two readings
   * identical. Reading only `'default'` here would silently turn a workspace
   * ceiling into a per-queue one the moment a second queue ran.
   */
  public hasInFlight(queueId?: string): boolean {
    return this.inFlightCount(queueId) > 0;
  }

  public inFlightCount(queueId?: string): number {
    const queues =
      queueId === undefined
        ? Object.values(this.store.getQueueStates())
        : [this.store.getQueue(queueId)];
    return queues.reduce(
      (total, queue) => total + queue.requests.filter((r) => r.status === 'in-flight').length,
      0
    );
  }

  /**
   * Feature 092 (T050, FR-025) — *this queue* can take a Task right now.
   *
   * Per-queue capacity stays exactly 1 in-flight Task: this feature makes
   * queues concurrent with each other, not internally parallel. A `false` here
   * means **busy** — the queue is already running something, and no amount of
   * workspace headroom changes that.
   */
  public hasQueueCapacity(queueId: string = DEFAULT_QUEUE_ID): boolean {
    return this.inFlightCount(queueId) < PER_QUEUE_CAPACITY;
  }

  /**
   * Feature 092 (T050, FR-026) — *the workspace* can take another Run.
   *
   * The body is the pre-092 `hasCapacity()` unchanged; only the name narrows to
   * say which of the two capacities it answers. A `false` here means
   * **waiting** — a ready queue lost a race for the last slot and will promote
   * on the next sweep, which is not a refusal and not an error (contract §1
   * step 4).
   */
  public hasWorkspaceCapacity(): boolean {
    return this.inFlightCount() < this.store.getGlobalConcurrencyCap();
  }

  /**
   * Feature 093 (T072, FR-014, RS-1) — the cap as a counting semaphore over
   * **live Runs**, which is what the operator set it to bound.
   *
   * `hasWorkspaceCapacity()` above counts in-flight *Task rows*; FR-014 names
   * that reading and rejects it as the cap's oracle ("not merely the number of
   * accounted slots"). The two agreed while one Run could execute per window
   * and nothing forced them to keep agreeing. The count passed here is
   * `RunSessionRegistry.size` — a session exists from the moment its Run is
   * admitted until the Run reaches a terminal state, so a **paused** Run keeps
   * its slot (FR-014a) with no second rule to state it, and a Run that ended
   * releases its slot without an operator doing anything (FR-016).
   *
   * Takes the count rather than reading it, because the sessions live in the
   * controller and the queue model has no business holding a handle to it.
   * Acquisition only: nothing here revokes a slot, so lowering the cap below
   * the number of live Runs refuses the next start and terminates none of the
   * current ones (FR-017).
   */
  public hasExecutionCapacity(liveRunCount: number): boolean {
    return liveRunCount < this.store.getGlobalConcurrencyCap();
  }

  public async enqueue(
    description: string,
    options: {
      pipelineId?: string;
      rerun?: FeatureRequestRerun;
      queueId?: string;
      position?: number;
      // Feature 087 (T042, US3, FR-030) — a composed run arrives with its
      // Pipeline already frozen at validation. The manager carries the plan
      // through verbatim; it never inspects or re-expands it.
      runPlan?: FrozenRunPlan;
    } = {}
  ): Promise<FeatureRequest> {
    const validated = validateDescription(description);
    const now = Date.now();
    const request: FeatureRequest = {
      id: randomUUID(),
      description: validated,
      enqueuedAt: now,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      completedAt: null,
      status: 'pending',
      queueId: options.queueId ?? this.store.getDefaultQueueId(),
      position: options.position ?? 0,
      pauseCause: null,
      runId: null,
      retryCount: 0,
      lastError: null,
      pausedReason: null,
      ...(options.pipelineId ? { pipelineId: options.pipelineId } : {}),
      ...(options.rerun ? { rerun: options.rerun } : {}),
      // Written only when supplied, so an item enqueued by any pre-existing
      // path serializes exactly as it did before this feature (T034).
      ...(options.runPlan ? { runPlan: options.runPlan } : {})
    };
    const inserted = await this.store.insertPendingRequest(request, {
      queueId: options.queueId,
      position: options.position
    });
    // Feature 019 — DEBUG instrumentation point. Emitted AFTER the
    // store mutation so `sizeAfter` reflects the post-enqueue count.
    this.logger?.debug('queue-manager.enqueue', {
      taskId: inserted.id,
      queueId: inserted.queueId,
      sizeAfter: this.store.getQueue(inserted.queueId ?? DEFAULT_QUEUE_ID).requests.length
    });
    return inserted;
  }

  public async markInFlight(featureId: string, runId: string, isResume: boolean = false): Promise<void> {
    const now = Date.now();
    // FR-R3-153 (T1636/T1637) — strict resolution (research.md R2): a missing
    // task falls back to Default only as "some queue to open" for the
    // mutator's own not-found check below, never as a guessed owner. A found
    // row is opened at its own queue, so the mutator's `queue.requests.find`
    // is the true, race-safe answer to "does this queue own it."
    const ownerQueueId = this.queueIdForTask(featureId);
    const movedRequest = await this.store.updateQueue((queue) => {
      const current = queue.requests.find((r) => r.id === featureId);
      const decision = decideTaskTransition({
        operation: 'mark-in-flight',
        currentStatus: current?.status,
        queueOwnsTask: current !== undefined,
        queueAlreadyHasDifferentInFlight: queue.inFlightId !== null && queue.inFlightId !== featureId
      });
      if (!decision.eligible) {
        // Thrown, not returned — a value returned from this mutator is always
        // committed (with a bumped `updatedAt`) by `store.updateQueue`, so
        // the only way to leave the task row, queue ownership, and
        // timestamps completely unchanged on refusal (spec FR-004) is to
        // never reach that commit at all. Matches this method's own
        // pre-existing throw-to-refuse contract (`admitNew` already
        // try/catches it).
        throw new QueueMutationRejected(
          decision.reason,
          `Cannot mark ${featureId} in-flight: ${decision.reason}`
        );
      }
      const requests = queue.requests.map((r) =>
        r.id === featureId
          ? {
              ...r,
              status: 'in-flight' as FeatureRequestStatus,
              runId,
              startedAt: r.startedAt ?? now,
              updatedAt: now
            }
          : r
      );
      return {
        queue: withRefreshedLifecycle({ ...queue, requests, inFlightId: featureId }),
        result: requests.find((request) => request.id === featureId)
      };
    }, ownerQueueId,
      this.store.runCommitClaim(ownerQueueId)
    );
    // Feature 019 — DEBUG instrumentation. `markInFlight` is the
    // effective "dequeue" — a pending task transitions to in-flight.
    // `sizeAfter` reflects the pending count after the transition.
    const updatedQueue = this.store.getQueue(ownerQueueId);
    const pendingAfter = updatedQueue.requests.filter((r) => r.status === 'pending').length;
    this.logger?.debug('queue-manager.dequeue', {
      taskId: featureId,
      queueId: movedRequest?.queueId ?? null,
      sizeAfter: pendingAfter
    });

    // Feature 072 — emit task-execution-started after markInFlight succeeds
    if (this.lifecycleAuditHook) {
      try {
        // Feature 093 (T022) — the queue is already resolved above as the one
        // this transition addressed, so the Run is read from it rather than
        // ambiently. The `id === runId` guard stays: the queue answers *which*
        // Run, and the id answers whether it is the one this call started.
        const currentRun = this.store.getRun(ownerQueueId);
        const pipelineId = (currentRun?.id === runId ? currentRun?.pipeline?.id : '') ?? '';
        await this.lifecycleAuditHook.append({
          runId,
          phase: 'queue-manager',
          iteration: 0,
          eventType: 'task-execution-started',
          outcome: 'info',
          payload: {
            taskId: featureId,
            runId,
            // Feature 092 (T064, FR-039) — the fallback is the queue this
            // transition addressed, not the empty string. A Task whose own
            // `queueId` is unset is a pre-v10 row, and the queue it is in is
            // still known here; emitting `''` would leave the one event that
            // says a Run started unable to say where, which is exactly the
            // fixed value FR-039 replaces.
            queueId: movedRequest?.queueId ?? ownerQueueId,
            pipelineId,
            isResume
          }
        });
      } catch (err) {
        this.logger?.warn(`task-execution-started audit emission failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * FR-R3-153 (code-review fix, 2026-09-03) — `finish` and `pause` share this
   * exact wrapper: run a mutator through `store.updateQueue`, and translate
   * a `decideTaskTransition` refusal (thrown as `QueueMutationRejected`, so
   * a refused write never reaches the commit that would bump `updatedAt` —
   * spec FR-004) back into the `{ ok: false, reason }` shape both methods
   * return. `retry` does NOT use this: its catch remaps `task-not-found` to
   * its own pre-existing `'not-found'`/`'illegal-state'` vocabulary, a
   * translation this shared helper would have to special-case for one
   * caller — not extracted here for that reason.
   */
  private async runTaskTransitionMutation(
    ownerQueueId: string,
    mutator: (queue: QueueState) => { readonly queue: QueueState; readonly result: MutationResult }
  ): Promise<MutationResult> {
    try {
      return await this.store.updateQueue<MutationResult>(
        mutator,
        ownerQueueId,
        this.store.runCommitClaim(ownerQueueId)
      );
    } catch (err) {
      if (isTaskTransitionRejection(err)) return { ok: false, reason: err.reason };
      throw err;
    }
  }

  public async finish(
    featureId: string,
    status: TerminalRequestStatus,
    lastError: FeatureRequestFailure | string | null = null
  ): Promise<MutationResult> {
    const now = Date.now();
    const ownerQueueId = this.queueIdForTask(featureId);
    // FR-R3-158 (T018) / FR-R3-157 (T035, C3.5) — looked up by Task, on `retry()`'s
    // pattern, so a task finishing beside a running sibling cannot be handed the
    // sibling's Run. One lookup for every captured field: see `terminal-capture.ts`.
    const captured = terminalCapture(this.store.findRunByTask(featureId)?.run ?? null);
    return this.runTaskTransitionMutation(ownerQueueId, (queue) => {
      const current = queue.requests.find((r) => r.id === featureId);
      const decision = decideTaskTransition({
        operation: 'finish',
        currentStatus: current?.status,
        targetStatus: status,
        queueOwnsTask: current !== undefined,
        queueAlreadyHasDifferentInFlight: false
      });
      if (!decision.eligible) {
        throw new QueueMutationRejected(decision.reason, `Cannot finish ${featureId}: ${decision.reason}`);
      }
      return {
        queue: withRefreshedLifecycle({
          ...queue,
          requests: queue.requests.map((r) =>
            r.id === featureId
              ? {
                  ...r,
                  status,
                  completedAt: now,
                  updatedAt: now,
                  lastError: status === 'failed' ? lastError ?? r.lastError : r.lastError,
                  ...captured
                }
              : r
          ),
          inFlightId: queue.inFlightId === featureId ? null : queue.inFlightId
        }),
        result: { ok: true }
      };
    });
  }

  /**
   * Mark a task `paused`. When `preserveInFlightForRestore === true` AND
   * the task is the queue's current `inFlightId`, the inFlight pointer is
   * NOT cleared so the queue-projector (T069) can route the paused row
   * back to the inFlight bucket — preserving the active-feature binding
   * for the Activity Feed across a system-armed scheduled restore
   * (BUG-006 / FR-026). Default behavior (operator pause) clears
   * `inFlightId` exactly as before.
   */
  public async pause(
    featureId: string,
    pauseCause: FeatureRequestPauseCause | null = null,
    preserveInFlightForRestore: boolean = false
  ): Promise<MutationResult> {
    const now = Date.now();
    const ownerQueueId = this.queueIdForTask(featureId);
    return this.runTaskTransitionMutation(ownerQueueId, (queue) => {
      const idx = queue.requests.findIndex((r) => r.id === featureId);
      const current = idx === -1 ? undefined : queue.requests[idx];
      const decision = decideTaskTransition({
        operation: 'pause',
        currentStatus: current?.status,
        queueOwnsTask: current !== undefined,
        queueAlreadyHasDifferentInFlight: false
      });
      if (!decision.eligible) {
        throw new QueueMutationRejected(decision.reason, `Cannot pause ${featureId}: ${decision.reason}`);
      }
      const requests = queue.requests.map((r, i) =>
        i === idx
          ? {
              ...r,
              status: 'paused' as FeatureRequestStatus,
              pauseCause,
              updatedAt: now
            }
          : r
      );
      const inFlightId =
        queue.inFlightId === featureId && !preserveInFlightForRestore ? null : queue.inFlightId;
      return { queue: withRefreshedLifecycle({ ...queue, requests, inFlightId }), result: { ok: true } };
    });
  }

  public async cancel(featureId: string): Promise<boolean> {
    const now = Date.now();
    return this.store.updateQueue((queue) => {
      const idx = queue.requests.findIndex((r) => r.id === featureId);
      if (idx === -1 || queue.requests[idx].status !== 'pending') {
        return { queue, result: false };
      }
      const requests = queue.requests.map((r, i) =>
        i === idx
          ? { ...r, status: 'canceled' as FeatureRequestStatus, completedAt: now, updatedAt: now }
          : r
      );
      return { queue: withRefreshedLifecycle({ ...queue, requests }), result: true };
    }, this.queueIdForTask(featureId),
      this.store.runCommitClaim(this.queueIdForTask(featureId))
    );
  }

  public async remove(featureId: string): Promise<boolean> {
    try {
      await this.store.removePendingRequest(featureId);
      return true;
    } catch {
      return false;
    }
  }

  // Canonical single-writer for a queue's pause state.
  //
  // FR-R3-011 — one write to one key. This method used to perform an atomic
  // *dual*-write: `QueueRegistryEntry.state` + `pauseSource` in
  // `KEYS.queueRegistry`, then `queueLifecycle` + the legacy `paused` mirror in
  // `KEYS.queue`. A `Memento` has no multi-key transaction, so "atomic" was
  // aspirational — the two writes had a window between them, and a window
  // disposed inside it left the pair split. `queueLifecycle` and `pauseSource`
  // now live in one entry of one key, so the whole fact moves together and a
  // split pair is unrepresentable.
  //
  // `pauseSource` defaults to 'operator'; pass 'cascade' from `cascadedPause`
  // and 'retry-cap' from the retry-handler. On clear, all sources are uniformly
  // cleared.
  public async setQueuePausedState(
    paused: boolean,
    queueId?: string,
    pausedReason: string | null = null,
    pauseSource: Exclude<QueuePauseSource, null> = 'operator',
    resumePrompt?: string
  ): Promise<QueueMutationDetail> {
    const op = paused ? 'queue-manager.pause' : 'queue-manager.resume';
    const fields: Record<string, unknown> = paused
      ? { queueId: queueId ?? null, reason: pausedReason, source: pauseSource }
      : { queueId: queueId ?? null, source: pauseSource };
    return this.logMutation(op, fields, async () => {
      try {
        const resolvedQueueId = queueId ?? this.store.getDefaultQueueId();
        const registry = this.store.getQueueRegistry();
        if (!findQueue(registry, resolvedQueueId)) {
          return { ok: false, reason: 'unknown-queue-id' };
        }
        const queue = this.store.getQueue(resolvedQueueId);
        const alreadyPaused = queue.queueLifecycle === 'operator-paused';
        // Idempotency: paused-true is a no-op only when the source matches.
        // Distinct sources (cascade → operator, etc.) overwrite attribution
        // so the resume side knows what to clear.
        if (paused && alreadyPaused && queue.pauseSource === pauseSource) {
          return { ok: false, reason: 'already-paused' };
        }
        if (!paused && !alreadyPaused) {
          // FR-R3-011 — the BUG-001 self-heal that stood here is gone with the
          // divergence it healed. It existed because the registry could read
          // `active` while the legacy `QueueState.paused` boolean still read
          // `true`, leaving an operator's Resume a confusing no-op; there is one
          // value now, so a queue that reads not-paused *is* not paused and
          // saying so is the whole answer.
          return { ok: false, reason: 'not-paused' };
        }

        const now = Date.now();
        // Feature 065 (T036/T037) — lifecycle transition + scheduled-start
        // cancellation rules. On pause: if entering from idle-pending with
        // an armed schedule, cancel the in-process timer and clear the
        // persisted scheduledStartAt/Source atomically with the lifecycle
        // change. On resume: derive the new lifecycle from inFlightId and
        // pending.length per FR-019.
        if (paused) {
          const wasIdlePending = queue.queueLifecycle === 'idle-pending';
          const hadSchedule = queue.scheduledStartAt !== null;
          if (wasIdlePending && hadSchedule && this.scheduledStartCancelHook) {
            try {
              await this.scheduledStartCancelHook.cancel(resolvedQueueId, 'pause-cancel');
            } catch (err) {
              this.logger?.warn(
                `scheduled-start cancel on pause failed: ${(err as Error).message}`
              );
            }
          }
          await this.store.updateQueue(
            (current) => ({
              queue: {
                ...current,
                queueLifecycle: 'operator-paused',
                pauseSource,
                pausedReason,
                scheduledStartAt: null,
                scheduledStartSource: null
              },
              result: undefined
            }),
            resolvedQueueId,
            this.store.runCommitClaim(resolvedQueueId)
          );
          // Note: `scheduled-start-canceled` is emitted by the coordinator's
          // own `cancel()` method (above), not duplicated here. We only emit
          // `idle-pending-exited` AFTER the cancel to preserve the ordering
          // invariant required by FR-019.
          if (wasIdlePending && this.lifecycleAuditHook) {
            await this.appendLifecycleAudit('idle-pending-exited', {
              queueId: resolvedQueueId,
              exitReason: 'pause',
              transitionReason: 'pause'
            });
          }
        } else {
          // Resume: derive next lifecycle from queue contents.
          const hasInFlight = queue.inFlightId !== null;
          const hasPending = queue.requests.some((r) => r.status === 'pending');
          const nextLifecycle = hasInFlight
            ? 'running'
            : hasPending
              ? 'idle-pending'
              : 'active-empty';
          await this.store.updateQueue(
            (current) => ({
              queue: {
                ...current,
                queueLifecycle: nextLifecycle,
                pauseSource: null,
                pausedReason: null,
                scheduledStartAt: null,
                scheduledStartSource: null
              },
              result: undefined
            }),
            resolvedQueueId,
            this.store.runCommitClaim(resolvedQueueId)
          );
          if (
            nextLifecycle === 'idle-pending' &&
            this.lifecycleAuditHook
          ) {
            await this.appendLifecycleAudit('idle-pending-entered', {
              queueId: resolvedQueueId,
              scheduledStartAt: null,
              scheduledStartSource: null,
              transitionReason: 'resume-from-pause'
            });
          }
        }
        if (paused) {
          await this.pauseMatchingRunForQueue(resolvedQueueId, now);
        } else {
          await this.resumeMatchingRunForQueue(resolvedQueueId, now, resumePrompt);
        }
        return { ok: true, queueId: resolvedQueueId };
      } catch (err) {
        return { ok: false, reason: this.registryErrorReason(err) };
      }
    });
  }

  /**
   * Feature 028 — cascade-pause a queue because a task inside it hit an
   * active-phase pause. Idempotent and operator-respecting:
   *
   *   - active            → manually-paused (pauseSource: 'cascade')
   *   - cascade-paused    → no-op (already cascade)
   *   - operator-paused   → no-op (operator wins; never demoted to cascade)
   *
   * Returns `{ ok: true }` on every legal path so the caller can blindly
   * invoke this when a phase pause is detected.
   */
  public async cascadedPause(queueId: string): Promise<QueueMutationDetail> {
    return this.logMutation('queue-manager.cascade-pause', { queueId }, async () => {
      try {
        if (!findQueue(this.store.getQueueRegistry(), queueId)) {
          return { ok: false, reason: 'unknown-queue-id' };
        }
        // FR-R3-011 — the precedence this method exists to enforce is now read
        // from the queue's own record. It is the same test as before, against
        // one value instead of a registry copy of it: already paused means
        // either already cascade (idempotent) or operator-pause-wins, and both
        // are a no-op.
        if (this.store.getQueue(queueId).queueLifecycle === 'operator-paused') {
          return { ok: true, queueId };
        }
        await this.store.updateQueue(
          (queue) => ({
            queue: {
              ...queue,
              queueLifecycle: 'operator-paused',
              pauseSource: 'cascade',
              pausedReason: null,
              scheduledStartAt: null,
              scheduledStartSource: null
            },
            result: undefined
          }),
          queueId,
          this.store.runCommitClaim(queueId)
        );
        return { ok: true, queueId };
      } catch (err) {
        return { ok: false, reason: this.registryErrorReason(err) };
      }
    });
  }

  /**
   * Feature 028 — clear a cascade-pause that was previously installed by
   * `cascadedPause()`. NO-OP when the queue is operator-paused or already
   * active, so an operator who explicitly paused mid-cascade keeps their
   * pause intact when the phase resumes.
   */
  public async cascadedResume(queueId: string): Promise<QueueMutationDetail> {
    return this.logMutation('queue-manager.cascade-resume', { queueId }, async () => {
      try {
        if (!findQueue(this.store.getQueueRegistry(), queueId)) {
          return { ok: false, reason: 'unknown-queue-id' };
        }
        const existing = this.store.getQueue(queueId);
        // FR-R3-011 — both halves of the test read one record. An operator pause
        // and an already-active queue are equally a no-op, which is what leaves
        // an operator's pause standing when the phase that cascaded resumes.
        if (
          existing.queueLifecycle !== 'operator-paused'
          || existing.pauseSource !== 'cascade'
        ) {
          return { ok: true, queueId };
        }
        const hasInFlight = existing.inFlightId !== null;
        const hasPending = existing.requests.some((r) => r.status === 'pending');
        await this.store.updateQueue(
          (queue) => ({
            queue: {
              ...queue,
              queueLifecycle: hasInFlight ? 'running' : hasPending ? 'idle-pending' : 'active-empty',
              pauseSource: null,
              pausedReason: null,
              scheduledStartAt: null,
              scheduledStartSource: null
            },
            result: undefined
          }),
          queueId,
          this.store.runCommitClaim(queueId)
        );
        return { ok: true, queueId };
      } catch (err) {
        return { ok: false, reason: this.registryErrorReason(err) };
      }
    });
  }

  /**
   * Feature 092 (T029, US1, FR-012) — create a queue.
   *
   * The registry helper owns the cap, the UUIDv4 id shape and the trimmed
   * case-insensitive name uniqueness rule; the manager only supplies the id
   * and surfaces the refusal code.
   */
  public async createQueue(name: string): Promise<QueueMutationDetail> {
    const queueId = randomUUID();
    return this.logMutation('queue-manager.create-queue', { queueId }, async () => {
      try {
        await this.store.setQueueRegistry(
          createQueue(this.store.getQueueRegistry(), { id: queueId, name, now: Date.now() })
        );
        await this.armConcurrencyNotice();
        return { ok: true, queueId };
      } catch (err) {
        return { ok: false, reason: this.registryErrorReason(err) };
      }
    });
  }

  /**
   * Feature 092 (T065, FR-037) — arm the shared-working-tree notice the first
   * time this workspace stops being single-queue.
   *
   * Placed here rather than in `cmd-create-queue.ts` for the same reason the
   * scheduled-start disarm sits in `deleteQueue`: this method is the single
   * site every creation entrance passes through, so a webview-only arm would
   * miss a queue created by any other caller. The task named the webview file;
   * the mechanism it names — a persisted one-time answer — is what moved.
   *
   * The two conditions are not redundant. `entries.length >= 2` is the trigger
   * (a workspace that stopped being single-queue), and `=== null` is what makes
   * it fire ONCE PER WORKSPACE rather than once per crossing: delete back down
   * to one queue and grow again and the persisted answer, whatever it was, is
   * already there. Arming after the registry write is deliberate — a notice for
   * a second queue that failed to be created would be a warning about a
   * concurrency the operator does not have.
   */
  private async armConcurrencyNotice(): Promise<void> {
    if (this.store.getQueueRegistry().entries.length < 2) return;
    if (this.store.getConcurrencyNotice() !== null) return;
    await this.store.setConcurrencyNotice('pending');
  }

  /**
   * Feature 092 (T065, FR-037) — the operator answered the notice.
   *
   * A no-op unless the notice is actually pending. Writing `'dismissed'` over
   * `null` would answer a question this workspace was never asked, and would
   * suppress the notice permanently for the first second queue it later
   * creates; writing it over `'dismissed'` is the idempotent repeat this guard
   * also absorbs.
   */
  public async dismissConcurrencyNotice(): Promise<void> {
    if (this.store.getConcurrencyNotice() !== 'pending') return;
    await this.store.setConcurrencyNotice('dismissed');
  }

  /** Feature 092 (T029, US1, FR-013) — rename a queue in place. */
  public async renameQueue(queueId: string, name: string): Promise<QueueMutationDetail> {
    return this.logMutation('queue-manager.rename-queue', { queueId }, async () => {
      const existing = findQueue(this.store.getQueueRegistry(), queueId);
      try {
        await this.store.setQueueRegistry(
          renameQueue(this.store.getQueueRegistry(), { id: queueId, name, now: Date.now() })
        );
        // Names are operator-authored, so they stay out of the audit payload
        // (FR-023a); the handler reports the id and the caller-visible result.
        return { ok: true, queueId, fromName: existing?.name, toName: name.trim() };
      } catch (err) {
        return { ok: false, reason: this.registryErrorReason(err) };
      }
    });
  }

  /**
   * Feature 092 (T031, US1) — the impact a deletion would have, or the reason
   * it is refused outright.
   *
   * The order is the contract of contracts/queue-registry-and-migration.md §1,
   * not an implementation detail, and the first match wins: the default queue
   * (FR-004) before an in-flight Task (FR-015) before the confirmation gate
   * (FR-014). A bound connected run that is mid-node holds an in-flight Task,
   * so it is refused at step 2 and never reaches the terminate branch — step 3
   * is only ever reached by an aggregate sitting between nodes.
   */
  public queueDeletionImpact(queueId: string): QueueDeletionImpact {
    if (queueId === DEFAULT_QUEUE_ID) {
      return { outcome: 'refused', reason: 'default-queue-undeletable' };
    }
    if (!findQueue(this.store.getQueueRegistry(), queueId)) {
      return { outcome: 'refused', reason: 'unknown-queue-id' };
    }
    const requests = this.store.getRequestsForQueue(queueId);
    if (requests.some((request) => request.status === 'in-flight')) {
      return { outcome: 'refused', reason: 'queue-has-in-flight-task' };
    }
    // Feature 092 (T083, FR-041/FR-016a) — the aggregates are scanned by their
    // own `queueId`, not derived from the Tasks this queue happens to hold.
    //
    // The two are different questions and only one of them is "is this run
    // bound here". `connectedRunOwning(taskId)` answers the move refusal's
    // question — does some aggregate own this specific Task — and stays the
    // oracle there. Deriving the binding from it instead would name only the
    // aggregates with a child Task still on the queue, which is precisely the
    // set the comment above says never reaches this step: a run sitting between
    // nodes has no live child, so a Task-scan reports it as unaffected and the
    // operator would delete its queue without being told.
    const boundConnectedRunIds = Object.values(this.store.getConnectedRuns())
      .filter((run) => resolveBoundQueueId(run) === queueId)
      .map((run) => run.connectedRunId)
      .sort();
    return {
      outcome: 'deletable',
      queueId,
      pendingTaskCount: requests.filter((request) => request.status === 'pending').length,
      boundConnectedRunIds
    };
  }

  /**
   * Feature 092 (T029/T031, US1, FR-014 – FR-016) — delete a queue.
   *
   * Re-checks the ordered refusals rather than trusting the caller's earlier
   * impact read: the confirmation is a round trip, and a Task may have gone
   * in-flight in between.
   */
  public async deleteQueue(queueId: string): Promise<QueueMutationDetail> {
    return this.logMutation('queue-manager.delete-queue', { queueId }, async () => {
      const impact = this.queueDeletionImpact(queueId);
      if (impact.outcome === 'refused') return { ok: false, reason: impact.reason, queueId };
      try {
        // Registry first: it owns the position compaction (FR-016) and is the
        // authority on the queue's existence. The execution state is dropped
        // second so a failure between the two leaves an orphan record rather
        // than a registry entry pointing at nothing.
        await this.store.setQueueRegistry(
          deleteQueue(this.store.getQueueRegistry(), { id: queueId, now: Date.now() })
        );
        await this.store.deleteQueueState(queueId);
        // Feature 092 (T083, FR-016a) — terminate every aggregate bound here,
        // and terminate rather than rebind. Rebinding would move a run the
        // operator confirmed the deletion of onto a queue they did not choose,
        // and picking that queue is a decision nothing in this method is
        // entitled to make; the alternative, leaving the record, is the one
        // outcome FR-016a names outright — no aggregate pointing at a queue
        // that no longer exists.
        //
        // The ids come from the impact that was just re-checked, so exactly the
        // set the operator was shown is the set that is removed.
        const terminated = await this.store.deleteConnectedRuns(impact.boundConnectedRunIds);
        // Feature 092 (T059, FR-030) — disarm this queue's scheduled start,
        // and only this queue's. The disarm lives here rather than in
        // `cmd-delete-queue.ts` because this method is the single site every
        // deletion entrance passes through; a webview-only disarm would leave
        // an orphan timer behind any other caller. It runs after the deletion
        // succeeds: disarming first would strand a live queue's start if the
        // registry write then failed.
        if (this.scheduledStartCancelHook) {
          try {
            await this.scheduledStartCancelHook.cancel(queueId, 'operator-cancel');
          } catch (err) {
            // The queue is already gone; a failed disarm must not turn a
            // completed deletion into a refusal. A stray fire finds no
            // `idle-pending` state and supersedes itself.
            this.logger?.warn(
              `queue-manager.delete-queue: scheduled-start disarm failed: ${(err as Error).message}`
            );
          }
        }
        return {
          ok: true,
          queueId,
          taskCount: impact.pendingTaskCount,
          connectedRunCount: terminated
        };
      } catch (err) {
        return { ok: false, reason: this.registryErrorReason(err), queueId };
      }
    });
  }

  public async saveQueueSettings(params: {
    globalConcurrencyCap: number;
    defaultQueueId: string;
  }): Promise<QueueMutationDetail> {
    // Feature 092 (T057, FR-026/FR-027) — the cap ranges over
    // `[1, MAX_GLOBAL_CONCURRENCY_CAP]`. Feature 056 Track 4 (FR-018..FR-022)
    // pinned it at 1 and said relaxing it required re-validating
    // multi-active-run lock semantics; US2 did exactly that — the workspace
    // lock now carries window primacy only, and mutual exclusion between Runs
    // moved to the per-queue execution lease — so the precondition is met.
    // FR-R3-145 (T1569) corrected the sentence that stood here: it listed five
    // sites sharing the bound, of which three — the package contribution,
    // `SETTINGS_SCHEMA` and `KEY_SPECS` — went with the configuration key,
    // which was on no scheduling path. `setGlobalConcurrencyCap` remains.
    //
    // Feature 094 — the authority for a cap above one is
    // `docs/architecture/local-queue-parallelism-ratification.md`, which
    // narrows one clause of the remote/multi-user expansion gate for the local
    // single-operator shape only. The 092 note above explains the mechanism
    // that made a cap above one representable; it is not the decision to use
    // one. This is one of the three sites that *enforce* the bound, alongside
    // `state/workspace-state.ts` and `contracts/validators/queue-management.ts`.
    if (
      !Number.isInteger(params.globalConcurrencyCap) ||
      params.globalConcurrencyCap < 1 ||
      params.globalConcurrencyCap > MAX_GLOBAL_CONCURRENCY_CAP
    ) {
      return { ok: false, reason: 'invalid-concurrency-cap' };
    }
    if (!findQueue(this.store.getQueueRegistry(), params.defaultQueueId)) {
      return { ok: false, reason: 'unknown-queue-id' };
    }
    try {
      await this.store.setGlobalConcurrencyCap(params.globalConcurrencyCap);
      await this.store.setDefaultQueueId(params.defaultQueueId);
      return { ok: true, queueId: params.defaultQueueId };
    } catch {
      return { ok: false, reason: 'config-write-failed' };
    }
  }

  /**
   * Feature 195 (T036, FR-018, FR-019) — this queue's own halt-on-failure
   * answer. `policy: null` removes the stored field rather than writing a
   * concrete value: the shape gate data-model.md §2 describes — a record
   * carrying `failurePolicy` has been touched by an operator, one without it
   * has not — is what lets a later change to the workspace default reach
   * exactly the queues that never stated an opinion (FR-018). A request that
   * asks for the queue's current answer (stored or absent, matching `policy`
   * exactly) is refused idempotently rather than written, so a redundant
   * write never bumps `updatedAt` for nothing.
   *
   * No audit event (FR-023, data-model.md §7): the preference this writes is
   * not an outcome any audit consumer classifies.
   */
  public async setFailurePolicy(
    queueId: string,
    policy: QueueFailurePolicy | null
  ): Promise<QueueMutationDetail> {
    return this.logMutation('queue-manager.set-failure-policy', { queueId }, async () => {
      if (!findQueue(this.store.getQueueRegistry(), queueId)) {
        return { ok: false, reason: 'unknown-queue-id' };
      }
      try {
        const current = this.store.getQueue(queueId);
        if ((current.failurePolicy ?? null) === policy) {
          return { ok: false, reason: 'failure-policy-unchanged', queueId };
        }
        await this.store.updateQueue(
          (queue) => {
            if (policy === null) {
              const { failurePolicy: _drop, ...rest } = queue;
              return { queue: rest, result: undefined };
            }
            return { queue: { ...queue, failurePolicy: policy }, result: undefined };
          },
          queueId,
          this.store.runCommitClaim(queueId)
        );
        return { ok: true, queueId };
      } catch (err) {
        return { ok: false, reason: this.registryErrorReason(err) };
      }
    });
  }

  public async modifyTask(
    taskId: string,
    description: string
  ): Promise<QueueMutationDetail> {
    try {
      const task = await this.store.modifyPendingRequest(taskId, { description });
      return { ok: true, queueId: task.queueId ?? DEFAULT_QUEUE_ID };
    } catch (err) {
      return { ok: false, reason: this.taskErrorReason(err) };
    }
  }

  /**
   * Removes a Task row. Deliberately does not cancel or clean up a Run this
   * task might own — that ordering (cancel → release the execution lease →
   * remove the row) is `task-deletion.ts#deleteTaskWithSessionCleanup`'s job,
   * and it is this method's only production caller.
   *
   * FR-R3-153 (T1640, research.md R6) — this method used to also mark an
   * in-flight task's Run `canceled` in the store directly, as a fallback for
   * callers that bypass `deleteTaskWithSessionCleanup`. That fallback never
   * called `cancelActive` (so nothing told the actual running process to
   * stop) or released the execution lease — worse than doing nothing, since
   * a caller could see `status: 'canceled'` and believe cleanup had
   * happened. `QueueManager` has no access to `cancelActive` or the
   * execution-lease releaser (both live one layer up, in
   * `TaskDeletionDeps`), so this method cannot safely perform that sequence
   * itself; removed rather than rewritten, so a second, weaker cancellation
   * protocol cannot silently reappear here.
   */
  public async removeTask(taskId: string): Promise<QueueMutationDetail> {
    try {
      const removed = await this.store.removeRequest(taskId);
      return {
        ok: true,
        taskId: removed.id,
        queueId: removed.queueId ?? DEFAULT_QUEUE_ID,
        priorStatus: removed.status,
        runId: removed.runId
      };
    } catch (err) {
      return { ok: false, reason: this.taskErrorReason(err) };
    }
  }

  public async reorderTask(taskId: string, newPosition: number): Promise<QueueMutationDetail> {
    try {
      const task = await this.store.reorderPendingRequest(taskId, newPosition);
      return { ok: true, queueId: task.queueId ?? DEFAULT_QUEUE_ID };
    } catch (err) {
      return { ok: false, reason: this.taskErrorReason(err) };
    }
  }

  /**
   * Feature 030 (US2, T031) — unified-queue reorder helper.
   *
   * Wraps `store.reorderPendingRequest` with the canonical
   * `TaskReorderedPayload`-shape result so the message router can emit
   * the `task-reordered` audit event uniformly for both the success
   * branch and every rejection branch (see
   * specs/030-single-task-queue/data-model.md §"Audit Events").
   *
   * Resolution rules:
   *   - taskId not found                 → rejected / 'invalid-position'
   *   - taskId found but not pending     → rejected / 'task-not-pending'
   *   - newPosition out of range         → rejected / 'invalid-position'
   *   - newPosition === current position → rejected / 'no-op'
   *   - otherwise                        → success, newOrder reflects the
   *                                        post-mutation pending ordering
   *
   * Feature 065 BUG-009 T078 (FR-030) — `newPosition` is interpreted as an
   * index into the projector's flattened `orderedItems` array (the same
   * coordinate system the UI emits the drop event in), NOT as a sparse
   * pending-only sub-array index. The writer translates the global index
   * to the underlying pending-array index by counting the non-pending
   * rows preceding `newPosition` in the same pre-mutation snapshot:
   *
   *   translatedPendingIdx = newPosition - countNonPendingBefore(newPosition)
   *
   * `fromPosition` and `toPosition` in the result are the **pending-row
   * positions** (0..pendingCount-1) AFTER translation — matching the
   * `task-reordered` audit payload contract (host-side history readers
   * continue to consume pending-array indices, FR-030 invariant).
   *
   * `fromGlobalPosition` exposes the source row's index in the global
   * `orderedItems` projection for the arrow-move handler's
   * `globalPos + delta` math (it has no audit consumer).
   *
   * The audit emission itself is the caller's responsibility; this
   * function only resolves the disposition + new ordering. The single
   * sanitization point at `appendAudit` → `SanitizedLogger.sanitize`
   * remains the canonical funnel (per CLAUDE.md hard rule).
   */
  public async reorderTaskInUnifiedQueue(
    taskId: string,
    newPosition: number
  ): Promise<{
    outcome: 'success' | 'rejected';
    cause?: 'task-not-pending' | 'invalid-position' | 'no-op';
    fromPosition: number;
    toPosition: number;
    fromGlobalPosition: number;
    newOrder: readonly string[];
  }> {
    // Feature 092 (T027, FR-007) — "unified" now means "the queue that owns
    // this Task". Every index below is an index into that one queue's rows, so
    // the global/pending translation is unchanged; what changed is that the
    // coordinate system is per queue rather than per workspace.
    const ownerQueueId = this.queueIdForTask(taskId);
    const queue = this.store.getQueue(ownerQueueId);
    const sortedAll = queue.requests.slice().sort((a, b) => a.position - b.position);
    const queueOrder = sortedAll.map((r) => r.id);
    const fromGlobalPosition = queueOrder.indexOf(taskId);
    const sortedPending = sortedAll.filter((r) => r.status === 'pending');
    const fromPendingIdx = sortedPending.findIndex((r) => r.id === taskId);
    const target = queue.requests.find((r) => r.id === taskId);

    if (!target) {
      return {
        outcome: 'rejected',
        cause: 'invalid-position',
        fromPosition: -1,
        toPosition: newPosition,
        fromGlobalPosition: -1,
        newOrder: queueOrder
      };
    }
    // FR-030 source-eligibility guard: only pending rows can be the drag
    // source. The drag *target* MAY land at any global index (including
    // positions visually occupied by paused or failed rows); only the
    // source-side check enforces this guard.
    if (target.status !== 'pending') {
      return {
        outcome: 'rejected',
        cause: 'task-not-pending',
        fromPosition: -1,
        toPosition: newPosition,
        fromGlobalPosition,
        newOrder: queueOrder
      };
    }
    if (
      !Number.isInteger(newPosition) ||
      newPosition < 0 ||
      newPosition >= sortedAll.length
    ) {
      return {
        outcome: 'rejected',
        cause: 'invalid-position',
        fromPosition: fromPendingIdx,
        toPosition: newPosition,
        fromGlobalPosition,
        newOrder: queueOrder
      };
    }
    // Translate the global `orderedItems` index to a pending-array index
    // by counting how many non-pending rows precede `newPosition` in the
    // pre-mutation projection snapshot. The translation collapses any
    // global drop target that falls onto (or just past) a non-pending
    // row into the adjacent pending-array slot — non-pending rows are
    // stable anchors under FR-030.
    let nonPendingBefore = 0;
    for (let i = 0; i < newPosition; i++) {
      if (sortedAll[i].status !== 'pending') nonPendingBefore++;
    }
    const translatedPendingIdx = newPosition - nonPendingBefore;
    if (
      translatedPendingIdx < 0 ||
      translatedPendingIdx >= sortedPending.length
    ) {
      return {
        outcome: 'rejected',
        cause: 'invalid-position',
        fromPosition: fromPendingIdx,
        toPosition: translatedPendingIdx,
        fromGlobalPosition,
        newOrder: queueOrder
      };
    }
    if (translatedPendingIdx === fromPendingIdx) {
      return {
        outcome: 'rejected',
        cause: 'no-op',
        fromPosition: fromPendingIdx,
        toPosition: translatedPendingIdx,
        fromGlobalPosition,
        newOrder: queueOrder
      };
    }

    try {
      await this.store.reorderPendingRequest(taskId, translatedPendingIdx);
      const afterAll = this.store
        .getQueue(ownerQueueId)
        .requests.slice()
        .sort((a, b) => a.position - b.position)
        .map((r) => r.id);
      return {
        outcome: 'success',
        fromPosition: fromPendingIdx,
        toPosition: translatedPendingIdx,
        fromGlobalPosition,
        newOrder: afterAll
      };
    } catch (err) {
      const reason = this.taskErrorReason(err);
      const cause =
        reason === 'task-not-in-pending-state'
          ? 'task-not-pending'
          : 'invalid-position';
      return {
        outcome: 'rejected',
        cause,
        fromPosition: fromPendingIdx,
        toPosition: translatedPendingIdx,
        fromGlobalPosition,
        newOrder: queueOrder
      };
    }
  }

  /**
   * Feature 092 (T028, FR-017) — move one pending Task to another queue.
   *
   * The Task's own fields are not this method's business: `movePendingRequest`
   * rewrites `queueId`, `position` and `updatedAt` and carries every other
   * field — description, `runPlan`, `pipelineId`, `rerun`, `retryCount` —
   * through the spread untouched. Preservation is therefore a property of the
   * store's single write, not something re-asserted here.
   *
   * The one refusal this layer owns is FR-017's: a Task that is a child of a
   * connected Workflow run cannot be moved individually, because its queue is
   * fixed by its aggregate's binding (FR-042). Moving it would put a child of a
   * queue-bound aggregate on a queue the aggregate is not bound to, which is
   * FR-042 violated by an operator gesture rather than by a scheduler bug. The
   * check is here rather than in the store because the connected-run aggregate
   * is a peer key, and the store's queue writer has no business reading it.
   */
  public async moveTask(
    taskId: string,
    targetQueueId: string,
    position?: number | null
  ): Promise<QueueMutationDetail> {
    return this.logMutation('queue-manager.move-task', { taskId, queueId: targetQueueId }, async () => {
      if (this.connectedRunOwning(taskId) !== null) {
        return { ok: false, reason: 'task-bound-to-connected-run', taskId };
      }
      try {
        const moved = await this.store.movePendingRequest(taskId, {
          targetQueueId,
          position: position ?? null
        });
        return {
          ok: true,
          taskId: moved.id,
          queueId: moved.queueId ?? targetQueueId,
          priorStatus: moved.status
        };
      } catch (err) {
        return { ok: false, reason: this.taskErrorReason(err), taskId };
      }
    });
  }

  /**
   * The connected run that enqueued `taskId` as a child, or `null`.
   *
   * A child Run is recorded as a `ChildRunRef.queueItemId` on the node record
   * of the attempt that started it, so membership is a scan of every
   * aggregate's node attempts. Returns the identifier only — the caller refuses
   * on presence and never on the aggregate's contents.
   */
  private connectedRunOwning(taskId: string): string | null {
    for (const run of Object.values(this.store.getConnectedRuns())) {
      for (const node of Object.values(run.nodes)) {
        if (node.attempts.some((attempt) => attempt.queueItemId === taskId)) {
          return run.connectedRunId;
        }
      }
    }
    return null;
  }

  public async fireDueSchedules(now: number = Date.now()): Promise<readonly string[]> {
    const registry = this.store.getQueueRegistry();
    const due = registry.entries.filter((entry) => {
      if (!entry.schedule) return false;
      const target = Date.parse(entry.schedule.targetAt);
      return Number.isFinite(target) && target <= now;
    });
    if (due.length === 0) return [];
    let next = registry;
    for (const entry of due) {
      next = setQueueSchedule(next, { id: entry.id, schedule: null, now });
    }
    await this.store.setQueueRegistry(next);
    // FR-R3-011 — the unpause half moved to the queue record, and moving it is
    // what makes a fired schedule actually resume the queue. This loop used to
    // call `setQueuePaused(next, { paused: false })` on the registry alone,
    // which cleared the registry's copy and left `queueLifecycle` reading
    // `operator-paused` — so the queue looked active and still refused to
    // drain. That was one concrete instance of the divergence this feature
    // removes, not a separate defect.
    for (const entry of due) {
      const queue = this.store.getQueue(entry.id);
      if (queue.queueLifecycle !== 'operator-paused') continue;
      const hasInFlight = queue.inFlightId !== null;
      const hasPending = queue.requests.some((r) => r.status === 'pending');
      await this.store.updateQueue(
        (current) => ({
          queue: {
            ...current,
            queueLifecycle: hasInFlight ? 'running' : hasPending ? 'idle-pending' : 'active-empty',
            pauseSource: null,
            pausedReason: null,
            scheduledStartAt: null,
            scheduledStartSource: null
          },
          result: undefined
        }),
        entry.id,
        this.store.runCommitClaim(entry.id)
      );
    }
    return due.map((entry) => entry.id);
  }

  public async retry(featureId: string): Promise<MutationResult> {
    // Check whether the task's run context is still the active workspace
    // run. If so, preserve runId and startedAt so the auto-drain
    // coordinator can resume the failed phase instead of restarting the
    // entire pipeline from scratch.
    // Feature 093 (T022) — pattern B. `retry` already names the Task, so the
    // Run it compares against is the one executing that Task, not whichever
    // Run the workspace happened to hold.
    const activeRun = this.store.findRunByTask(featureId)?.run ?? null;
    const ownerQueueId = this.queueIdForTask(featureId);
    try {
      return await this.store.updateQueue<MutationResult>((queue) => {
        const idx = queue.requests.findIndex((r) => r.id === featureId);
        const target = idx === -1 ? undefined : queue.requests[idx];
        // FR-R3-153 (T1636/T1637) — routed through the shared classifier.
        // Ineligible is thrown, not returned (spec FR-004 — a refused
        // transition must leave timestamps completely unchanged, and
        // `store.updateQueue` unconditionally bumps `updatedAt` on any
        // returned value); the catch below translates it back to this
        // method's own pre-existing `'not-found'`/`'illegal-state'`
        // vocabulary so every current caller (queue-ops.ts's message
        // lookup, this file's own tests) keeps working unchanged
        // (research.md/T010 — "preserving each caller's existing
        // {ok, reason} return shape").
        //
        const decision = decideTaskTransition({
          operation: 'return-to-pending',
          currentStatus: target?.status,
          queueOwnsTask: target !== undefined,
          queueAlreadyHasDifferentInFlight: false
        });
        // Checked as two separate guards (rather than one `||`-joined
        // condition with a ternary picking the reason) so each narrows on its
        // own: `target === undefined` narrows `target` for the rest of this
        // callback, and `!decision.eligible` narrows `decision` to the
        // `{ eligible: false, reason }` arm so `decision.reason` is a real
        // read, not a guess. `decideTaskTransition` already refuses with
        // `'task-not-found'` on every path where `target` is undefined
        // (currentStatus undefined is its first check, before queueOwnsTask),
        // so the two throws below never disagree with each other.
        if (target === undefined) {
          throw new QueueMutationRejected('task-not-found', `Cannot retry ${featureId}`);
        }
        if (!decision.eligible) {
          throw new QueueMutationRejected(decision.reason, `Cannot retry ${featureId}`);
        }
        const canResume =
          target.status === 'failed' &&
          target.runId !== null &&
          activeRun !== null &&
          activeRun.id === target.runId &&
          (activeRun.status === 'failed' || activeRun.status === 'paused');
        // FR-R3-158 (T031, FR-009b) / FR-R3-157 (T036, FR-013, C3.8) — everything
        // captured off the previous attempt's Run is dropped at the moment the
        // retry is requested; `terminal-capture.ts` says why it is removed, not zeroed.
        const retained = withoutTerminalCapture(target);
        const updated: FeatureRequest = {
          ...retained,
          status: 'pending',
          retryCount: target.retryCount + 1,
          lastError: null,
          pausedReason: null,
          completedAt: null,
          startedAt: canResume ? target.startedAt : null,
          updatedAt: Date.now(),
          runId: canResume ? target.runId : null
        };
        const without = queue.requests.filter((_, i) => i !== idx);
        const inFlightIdx = without.findIndex((r) => r.status === 'in-flight');
        const insertAt = inFlightIdx === -1 ? 0 : inFlightIdx + 1;
        const reordered = [...without.slice(0, insertAt), updated, ...without.slice(insertAt)];
        const repositioned = reordered.map((r, i) => ({ ...r, position: i }));
        return {
          queue: withRefreshedLifecycle({ ...queue, requests: repositioned }),
          result: { ok: true }
        };
      }, ownerQueueId, this.store.runCommitClaim(ownerQueueId));
    } catch (err) {
      if (isTaskTransitionRejection(err)) {
        return { ok: false, reason: err.reason === 'task-not-found' ? 'not-found' : 'illegal-state' };
      }
      throw err;
    }
  }

  public async moveUp(featureId: string): Promise<MutationResult> {
    return this.move(featureId, -1);
  }

  public async moveDown(featureId: string): Promise<MutationResult> {
    return this.move(featureId, 1);
  }

  // Code-review finding (iteration 4) — `clearCompleted` and `clearFailed`
  // each hand-copied this same three-line guard. Both delegate their
  // removal to the shared `clearByStatus`; this is the shared refusal ahead
  // of it, so a future third `clearByStatus` sibling (or a change to the
  // refusal shape) has one call site to edit instead of two.
  private refuseIfUnknownQueue(queueId: string): ClearByStatusResult | null {
    if (findQueue(this.store.getQueueRegistry(), queueId)) return null;
    return { ok: false, reason: 'unknown-queue-id', removed: 0 };
  }

  // FR-R3-150 (T1621) — refuses an unknown queue id rather than silently
  // returning `{ removed: 0 }` (which `getQueue()`'s born-empty fallback
  // would otherwise make indistinguishable from "known queue, nothing to
  // clear"). The default parameter itself is unchanged and remains valid for
  // the separate `schegent.clearCompleted` palette route (`queue-ops.ts`),
  // which is not gated by this check — it is a trusted internal caller
  // naming Default explicitly, not a queue id arriving over IPC (FR-011).
  public async clearCompleted(queueId: string = DEFAULT_QUEUE_ID): Promise<ClearByStatusResult> {
    const refusal = this.refuseIfUnknownQueue(queueId);
    if (refusal !== null) return refusal;
    const { removed } = await this.clearByStatus('completed', queueId);
    return { ok: true, removed };
  }

  // `clearCompleted`'s sibling gets the same refusal.
  public async clearFailed(queueId: string = DEFAULT_QUEUE_ID): Promise<ClearByStatusResult> {
    const refusal = this.refuseIfUnknownQueue(queueId);
    if (refusal !== null) return refusal;
    const { removed } = await this.clearByStatus('failed', queueId);
    return { ok: true, removed };
  }

  // Feature 063 — atomic queue + run + pause + watchdog reset (FR-005).
  //
  // Callers (the `clear-all-handler`) pass a runner-ack probe that wraps
  // `controller.cancelActive()` + a 2s ack race. They no longer take the
  // workspace lock around this call: 092's T136 and 093's T068b retired the
  // run-scoped primacy acquire/release, and primacy is now the window's for
  // its whole lifetime. The method:
  //   1. Snapshots pre-clear state for the result/audit payload.
  //   2. Fast-paths an empty workspace as a no-op (no writes, no audit).
  //   3. Performs the writes via the canonical single-writers
  //      (`setQueue`, `setQueuePausedState`, `setRun`, `setWatchdog`).
  //   4. Awaits the runner-ack probe (caller-supplied 2s bound, FR-007).
  //   5. Returns the structured `CleanAllResult`.
  //
  // Cross-contamination invariant (FR-006): this method writes to
  // `KEYS.queue`, `KEYS.queueRegistry` (via setQueuePausedState),
  // `KEYS.run`, and `KEYS.watchdog` — and nothing else. The suppression
  // memento, settings, history, audit log, and features list are not
  // touched.
  //
  // Feature 092 (T027, FR-006) — "all" now means every queue. The counts, the
  // in-flight probe and the clear itself iterate the whole map, because a reset
  // that emptied only `'default'` would leave an operator-created queue holding
  // work while reporting the workspace clean. The result shape is unchanged and
  // stays workspace-scoped; the one field that cannot be pluralised without
  // changing the contract is `pauseSource`, which is documented below.

  // Code-review finding (reuse) — the "clear the active run snapshot" write
  // `clearAll()`/`clearQueue()` each issued twice (pre-probe, then the
  // BUG-003 compensating re-clear — see each call site), factored to one.
  private async clearRunSnapshots(queueIds: readonly string[]): Promise<void> {
    for (const queueId of queueIds) {
      await this.store.setRun(queueId, null, this.store.runCommitClaim(queueId));
    }
  }

  public async clearAll(probe?: CleanAllRunnerAckProbe | null): Promise<CleanAllResult> {
    const queuesBefore = this.store.getQueueStates();
    const queueIdsBefore = Object.keys(queuesBefore);
    // Feature 093 (T022) — pattern D. `clearAll` is workspace-scoped, so "the
    // active run" is every queue's, and the ids are captured before the clear
    // because step 3 below has to name each queue it clears.
    const runQueueIdsBefore = Object.keys(this.store.getRunMap());
    const watchdogBefore = this.store.getWatchdog();

    const removed = countRemovedByStatus(
      Object.values(queuesBefore).flatMap((queue) => queue.requests)
    );

    const inflightBefore = Object.values(queuesBefore).some(
      (queue) =>
        queue.inFlightId !== null || queue.requests.some((r) => r.status === 'in-flight')
    );
    // Filtered over `Object.entries` rather than over `queueIdsBefore` with a
    // `queuesBefore[id]` read in the predicate: `getQueueStates()` returns a
    // `Record<string, QueueState>`, so an index by a key that is not there is
    // `undefined` at runtime and a crash on the property access. Every
    // key-and-state pair this method needs is carried from one iteration
    // instead, which is also what `tests/lint/compiler-strictness-ratchet.test.ts`
    // asks for under `noUncheckedIndexedAccess`.
    const pausedEntriesBefore = Object.entries(queuesBefore).filter(
      ([, queue]) => queue.queueLifecycle === 'operator-paused'
    );
    const pausedQueueIdsBefore = pausedEntriesBefore.map(([id]) => id);
    const pauseBefore = pausedQueueIdsBefore.length > 0;
    // Feature 092 — `CleanAllResult.pauseSource` is one nullable field and N
    // queues may each carry their own, so it reports the reserved queue's
    // source when that queue was paused and otherwise the first paused entry's.
    // On a single-queue workspace — every workspace before this feature — the
    // two branches coincide and the reported value is byte-identical to what
    // the pre-feature reader produced.
    // FR-R3-011 — the source is read off the paused queue's own record. The
    // selection rule is unchanged: the reserved queue's source when that queue
    // was paused, otherwise the first paused queue's.
    const pauseSourceEntry =
      pausedEntriesBefore.find(([id]) => id === DEFAULT_QUEUE_ID) ?? pausedEntriesBefore[0];
    const pauseSourceBefore: CleanAllResult['pauseSource'] =
      pauseSourceEntry !== undefined
        ? (pauseSourceEntry[1].pauseSource as CleanAllResult['pauseSource']) ?? null
        : null;
    const activeRunBefore = runQueueIdsBefore.length > 0;
    const watchdogActiveBefore =
      watchdogBefore.paused === true ||
      watchdogBefore.pausedSince !== null ||
      watchdogBefore.nextPollAt !== null ||
      watchdogBefore.cause !== null;
    // FR-R3-150 (T1619c, LC-Q-05) — a list and not a flag because step 0 has to
    // name each queue whose timer it disarms; timers are keyed by queue id.
    const scheduledQueueIdsBefore = Object.entries(queuesBefore)
      .filter(([, queue]) => queue.scheduledStartAt !== null)
      .map(([id]) => id);
    const scheduleBefore = scheduledQueueIdsBefore.length > 0;

    // LC-Q-05 — the per-queue half of this gate is the shared predicate, so the
    // two resets cannot disagree about what "already clean" means. The Run and
    // the watchdog are not queue-record fields, so they stay named here.
    const wasNoop =
      Object.values(queuesBefore).every((queue) => !hasResettableQueueState(queue)) &&
      !activeRunBefore &&
      !watchdogActiveBefore;

    if (wasNoop) {
      return {
        removed,
        inflightAborted: false,
        runnerAcked: false,
        pauseCleared: false,
        pauseSource: null,
        activeRunCleared: false,
        watchdogCleared: false,
        scheduleCleared: false,
        wasNoop: true
      };
    }

    // 0. Disarm every armed timer before persisting the clear — the ordering
    //    `setQueuePausedState`'s pause branch and `clearQueue` both use, so no
    //    window exists where a timer is still armed against fields that already
    //    read as cleared. Unconditional on the armed schedule, not gated on
    //    `operator-paused`: that gate was this method's LC-Q-05 bug.
    for (const queueId of scheduledQueueIdsBefore) {
      if (!this.scheduledStartCancelHook) break;
      try {
        await this.scheduledStartCancelHook.cancel(queueId, 'operator-cancel');
      } catch (err) {
        this.logger?.warn(`scheduled-start cancel on clear-all failed: ${errorMessage(err)}`);
      }
    }

    // 1. Clear queue items (also drops `inFlightId`), on every queue, and
    //    settle the lifecycle and schedule fields with them (T1619c, LC-Q-05).
    //    `defer-pause-release` is what leaves step 2 below the owner of an
    //    `operator-paused` queue's release; see `queue-reset-settle.ts`.
    for (const queueId of queueIdsBefore) {
      await this.store.updateQueue(
        (queue) => ({
          queue: { ...queue, ...queueResetFields(queue, Date.now(), 'defer-pause-release') },
          result: undefined
        }),
        queueId,
        this.store.runCommitClaim(queueId)
      );
    }

    // 2. Clear pause state via the canonical single-writer, which after
    //    FR-R3-011 writes one field pair on one record. There is no longer a
    //    registry half to keep in lock-step — the registry's pause view is
    //    derived on read — so this loop is the whole of the clear, and
    //    `schegent.queues.registry` is untouched by `clearAll`.
    for (const queueId of pausedQueueIdsBefore) {
      await this.setQueuePausedState(false, queueId, null, 'operator');
    }

    // 3. Clear the active run snapshot — one per queue that held one.
    await this.clearRunSnapshots(runQueueIdsBefore);

    // 4. Reset watchdog backoff fields. Preserve `pollIntervalMs` (config)
    //    and `lastStatusOk` (observability scalar) — only the active-pause
    //    fields are cleared.
    if (watchdogActiveBefore) {
      await this.store.setWatchdog({
        paused: false,
        pausedSince: null,
        nextPollAt: null,
        pollIntervalMs: watchdogBefore.pollIntervalMs,
        lastStatusOk: watchdogBefore.lastStatusOk,
        cause: null
      });
    }

    // 5. Bounded runner-ack race (FR-007). Skip when no in-flight task
    //    existed — `runnerAcked` defaults to `false` and the result
    //    flag is interpreted by the handler in the "no-op" sense.
    let runnerAcked = false;
    if (inflightBefore && probe) {
      try {
        runnerAcked = await probe();
      } catch {
        runnerAcked = false;
      }
    }

    // 6. BUG-003 compensating clear: the probe's `controller.cancelActive()`
    //    triggers the RunDriver's abort branch, which calls
    //    `persistTransition(run, { ...run, status: 'canceled' })`. That write
    //    lands AFTER step 3's `setRun(null)` and repopulates the store with a
    //    canceled-status run — the Phase Progression panel then renders the
    //    cleared run as still-active. Re-clear after the probe completes to
    //    reassert FR-005's "active workflow-run snapshot cleared" invariant.
    //    Idempotent; safe when no run was present.
    //
    //    Feature 093 (T022) — the same queue ids as step 3, not a re-read of the
    //    map: a queue whose Run the probe re-persisted is one that held a Run
    //    before the clear, and re-reading would additionally clear a Run started
    //    on some *other* queue while the probe was awaited — work `clearAll`
    //    never saw and has no mandate over.
    await this.clearRunSnapshots(runQueueIdsBefore);

    return {
      removed,
      inflightAborted: inflightBefore,
      runnerAcked,
      pauseCleared: pauseBefore,
      pauseSource: pauseSourceBefore,
      activeRunCleared: activeRunBefore,
      watchdogCleared: watchdogActiveBefore,
      scheduleCleared: scheduleBefore,
      wasNoop: false
    };
  }

  // FR-R3-150 (T1619) — the queue-scoped reset. Unlike `clearAll()` above,
  // this never iterates `getQueueStates()` — every read and write below is
  // keyed to the single addressed `queueId`, so a sibling queue's tasks,
  // run, pause, schedule, timer, and execution claim are never read, let
  // alone written (FR-006, LC-Q-01). Workspace-wide watchdog state (the one
  // surface `clearAll()` also resets) is out of scope here by design
  // (FR-007) — it is not a per-queue field.
  //
  // Closes LC-Q-05 for the addressed queue, in one memento write and not two:
  // the field rule and the no-op predicate are `queue-reset-settle.ts`, which
  // says why they are shared with `clearAll()` and why the two methods are
  // still separate.
  public async clearQueue(
    queueId: string,
    probe?: CleanAllRunnerAckProbe | null
  ): Promise<ClearQueueResult> {
    if (!findQueue(this.store.getQueueRegistry(), queueId)) {
      return { outcome: 'refused', reason: 'unknown-queue-id' };
    }

    const before = this.store.getQueue(queueId);
    const removed = countRemovedByStatus(before.requests);
    const inflightBefore =
      before.inFlightId !== null || before.requests.some((r) => r.status === 'in-flight');
    const pauseBefore = before.queueLifecycle === 'operator-paused';
    const activeRunBefore = this.store.getRun(queueId) !== null;
    const scheduleBefore = before.scheduledStartAt !== null;

    // The Run is not a queue-record field, so it is named alongside the shared
    // predicate rather than inside it (FR-008/SC-004).
    const wasNoop = !hasResettableQueueState(before) && !activeRunBefore;

    if (wasNoop) {
      return {
        outcome: 'cleared',
        queueId,
        wasNoop: true,
        removed,
        inflightAborted: false,
        runnerAcked: false,
        pauseCleared: false,
        pauseSource: null,
        activeRunCleared: false,
        scheduleCleared: false,
        lifecycle: 'active-empty'
      };
    }

    // Disarm the timer before persisting the clear — the same ordering
    // `setQueuePausedState`'s pause branch already uses (cancel the external
    // hook first, then write the fields it fed), so no window exists where
    // the timer is still armed against fields that already read as cleared.
    // Unconditional on `scheduleBefore`, not gated on `operator-paused` —
    // that gate was `clearAll()`'s LC-Q-05 bug.
    if (scheduleBefore && this.scheduledStartCancelHook) {
      try {
        await this.scheduledStartCancelHook.cancel(queueId, 'operator-cancel');
      } catch (err) {
        this.logger?.warn(`scheduled-start cancel on clear-queue failed: ${errorMessage(err)}`);
      }
    }

    await this.store.updateQueue(
      (queue) => ({
        queue: { ...queue, ...queueResetFields(queue, Date.now(), 'release-pause') },
        result: undefined
      }),
      queueId,
      this.store.runCommitClaim(queueId)
    );

    if (activeRunBefore) {
      await this.clearRunSnapshots([queueId]);
    }

    let runnerAcked = false;
    if (inflightBefore && probe) {
      try {
        runnerAcked = await probe();
      } catch {
        runnerAcked = false;
      }
    }

    // BUG-003 compensating re-clear (mirrors `clearAll()`'s step 6, via the
    // shared `clearRunSnapshots`): the probe's `cancelActive()` can
    // repopulate `run` with a canceled-status snapshot, landing after this
    // method's own clear above.
    if (activeRunBefore) {
      await this.clearRunSnapshots([queueId]);
    }

    return {
      outcome: 'cleared',
      queueId,
      wasNoop: false,
      removed,
      inflightAborted: inflightBefore,
      runnerAcked,
      pauseCleared: pauseBefore,
      pauseSource: pauseBefore ? before.pauseSource : null,
      activeRunCleared: activeRunBefore,
      scheduleCleared: scheduleBefore,
      lifecycle: 'active-empty'
    };
  }

  /**
   * Feature 092 (T027) — Task ids are workspace-unique, so a lookup by id names
   * a Task and not a queue. `store.getRequest` resolves the owner across every
   * queue; scanning only `'default'` would make a Task on an operator-created
   * queue read as non-existent to every caller of this — including
   * `matchingRunForQueue`, which would then decline to pause its own run.
   */
  public findById(id: string): FeatureRequest | null {
    return this.store.getRequest(id);
  }

  /**
   * Feature 092 (T027, FR-006) — the queue that owns `taskId`.
   *
   * The row's own `queueId` is the answer rather than a scan of the map,
   * because the store writes the two in lockstep: `insertPendingRequest` files
   * the row under the queue it stamps on it, and `movePendingRequest` rewrites
   * both in one write. A Task that has since been removed resolves to the
   * reserved queue, which is where the pre-feature code would have looked and
   * where the ensuing mutation will correctly find nothing.
   *
   * Feature 092 (T132, FR-033a) — public because a terminating Run has to name
   * the queue whose execution lease it is returning, and `WorkflowRun` carries
   * no `queueId` (FR-008 guarantee 3 froze `KEYS.run` as a single Run). Callers
   * on that path MUST check the row exists first: the removed-Task fallback to
   * the reserved queue is safe for a mutation that then finds nothing, but a
   * lease release keyed on a guessed queue would clear a sibling Run's lease,
   * since every Run in one window shares an owner id.
   */
  public queueIdForTask(taskId: string): string {
    return this.store.getRequest(taskId)?.queueId ?? DEFAULT_QUEUE_ID;
  }

  /**
   * FR-R3-010 (T405) — the same question, refusing to guess.
   *
   * The lenient sibling above is right for a caller that has to put a mutation
   * somewhere and will correctly find nothing on a removed Task. It is wrong
   * for a caller recording a fact, which is what history does: a guessed queue
   * files one queue's record under another queue's name, and an operator asking
   * "what has this queue done" is given an answer that is wrong rather than
   * incomplete. `null` says so, and the caller routes to the documented
   * unattributed partition.
   *
   * A row that exists but predates queue stamping still resolves to
   * `DEFAULT_QUEUE_ID` — that is the queue it is on, not a guess about a row
   * nobody can find.
   */
  public queueIdForExistingTask(taskId: string): string | null {
    const request = this.store.getRequest(taskId);
    return request === null ? null : request.queueId ?? DEFAULT_QUEUE_ID;
  }

  // Feature 065 BUG-009 T078 (FR-030) — arrow-driven move operates in the
  // global `orderedItems` index space and routes through the unified
  // reorder helper so the writer applies the same global → pending-array
  // index translation as the drag path. The source-status guard (only
  // pending rows can be moved) is enforced inside the helper.
  private async move(featureId: string, direction: -1 | 1): Promise<MutationResult> {
    const queue = this.store.getQueue(this.queueIdForTask(featureId));
    const sortedAll = queue.requests.slice().sort((a, b) => a.position - b.position);
    const fromGlobalIdx = sortedAll.findIndex((r) => r.id === featureId);
    if (fromGlobalIdx === -1) return { ok: false, reason: 'not-found' };
    if (sortedAll[fromGlobalIdx].status !== 'pending') {
      return { ok: false, reason: 'illegal-state' };
    }
    const pendingCount = sortedAll.filter((r) => r.status === 'pending').length;
    if (pendingCount < 2) return { ok: false, reason: 'no-peer' };
    const newGlobalIdx = fromGlobalIdx + direction;
    if (newGlobalIdx < 0 || newGlobalIdx >= sortedAll.length) {
      return { ok: false, reason: 'at-edge' };
    }
    const decision = await this.reorderTaskInUnifiedQueue(featureId, newGlobalIdx);
    if (decision.outcome === 'success') return { ok: true };
    // The arrow stepped onto a non-pending neighbor whose translation
    // collapses back to the source's current pending-array index. The
    // pre-FR-030 contract surfaces this as the "edge" sentinel rather
    // than a no-op rejection.
    if (decision.cause === 'no-op') return { ok: false, reason: 'at-edge' };
    return { ok: false, reason: decision.cause ?? 'illegal-state' };
  }

  private async clearByStatus(
    status: FeatureRequestStatus,
    queueId: string = DEFAULT_QUEUE_ID
  ): Promise<ClearResult> {
    const removed = await this.store.updateQueue((queue) => {
      const before = queue.requests.length;
      const filtered = queue.requests.filter(
        (r) => r.status !== status || r.id === queue.inFlightId
      );
      return {
        queue: filtered.length === before
          ? queue
          : { ...queue, requests: filtered.map((r, i) => ({ ...r, position: i })) },
        result: before - filtered.length
      };
    }, queueId,
      this.store.runCommitClaim(queueId)
    );
    if (removed === 0) return { removed: 0 };
    // BUG-001 escape hatch: when the operator clears completed/failed items
    // and no in-flight task remains, also release any lingering pause so a
    // stale `retry-cap-exhausted` pause whose originating run is gone does
    // not strand future tasks. Skipped while a task is in flight to avoid
    // disturbing an active phase's pause state.
    //
    // Feature 092 (T027) — scoped to the cleared queue. The escape hatch
    // releases *this* queue's pause because *this* queue's work was cleared;
    // a sibling's in-flight Task is not a reason to keep it stranded, and a
    // sibling's pause is not this call's to release.
    //
    // FR-R3-011 — the pause is read off `queueLifecycle`. Reading the retired
    // `paused` mirror made the escape hatch a no-op on every record written
    // after the v13 collapse, which is precisely the stranding it exists to
    // undo.
    if (
      !this.hasInFlight(queueId)
      && this.store.getQueue(queueId).queueLifecycle === 'operator-paused'
    ) {
      await this.setQueuePausedState(false, queueId, null, 'operator');
    }
    return { removed };
  }

  /**
   * Feature 065 — emit a `scheduled-start-*` / `idle-pending-*` lifecycle
   * audit event via the late-injected hook. Best-effort; failures are
   * logged but do not abort the pause/resume operation.
   */
  private async appendLifecycleAudit(
    eventType:
      | 'scheduled-start-canceled'
      | 'idle-pending-entered'
      | 'idle-pending-exited',
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.lifecycleAuditHook) return;
    try {
      await this.lifecycleAuditHook.append({
        runId: '',
        phase: 'scheduled-start',
        iteration: 0,
        eventType,
        outcome: 'info',
        payload: { ...payload, occurredAt: payload.occurredAt ?? Date.now() }
      });
    } catch (err) {
      this.logger?.warn(
        `lifecycle audit append failed (${eventType}): ${(err as Error).message}`
      );
    }
  }

  private async pauseMatchingRunForQueue(queueId: string, now: number): Promise<void> {
    // Feature 093 (T022) — pattern A. The queue is a parameter, so the Run is
    // read from it directly instead of reading the one workspace Run and asking
    // afterwards whether it belonged here.
    const run = this.store.getRun(queueId);
    const matching = this.matchingRunForQueue(run, queueId);
    if (!matching) return;
    if (matching.manualPauseAt !== null) return;
    await this.store.setRun(queueId, {
      ...matching,
      manualPauseAt: now,
      manualPauseCause: 'queue-paused-mid-run'
    },
      this.store.runCommitClaim(queueId)
    );
  }

  private async resumeMatchingRunForQueue(queueId: string, now: number, resumePrompt?: string): Promise<void> {
    const run = this.store.getRun(queueId);
    const matching = this.matchingRunForQueue(run, queueId);
    if (!matching || matching.manualPauseCause !== 'queue-paused-mid-run') return;
    await this.store.setRun(queueId, {
      ...matching,
      status: matching.status === 'paused' ? 'running' : matching.status,
      manualPauseAt: null,
      manualPauseCause: null,
      lastTransitionAt: now,
      resumePrompt
    },
      this.store.runCommitClaim(queueId)
    );
  }

  private matchingRunForQueue(run: WorkflowRun | null, queueId: string): WorkflowRun | null {
    if (!run) return null;
    const feature = this.findById(run.featureId);
    if (!feature) return null;
    if ((feature.queueId ?? DEFAULT_QUEUE_ID) !== queueId) return null;
    if (feature.status !== 'in-flight') return null;
    return run;
  }

  /**
   * Feature 019 BUG-001 (FR-021) — paired INFO-on-success / WARN-on-failure
   * instrumentation for every queue-CRUD entry point. The wrapper runs the
   * actual mutation, then emits exactly one runtime-log line based on the
   * resolved `result.ok` flag. Failure path uses the canonical
   * `<op> failed` tag so operators can grep both outcomes via the op
   * prefix. The logger is optional so unit-test call sites that omit it
   * keep working.
   */
  private async logMutation(
    op: string,
    fields: Record<string, unknown>,
    fn: () => Promise<QueueMutationDetail>
  ): Promise<QueueMutationDetail> {
    const result = await fn();
    // FR-023: emit the canonical resolved queueId, never caller-supplied null.
    const callerQueueId = fields.queueId;
    const resolvedQueueId =
      result.queueId ??
      (typeof callerQueueId === 'string' && callerQueueId.length > 0
        ? callerQueueId
        : this.store.getDefaultQueueId());
    const payload = { ...fields, queueId: resolvedQueueId };
    if (result.ok) {
      this.logger?.info(op, payload);
    } else if (result.reason && IDEMPOTENT_REJECT_REASONS.has(result.reason)) {
      this.logger?.debug(`${op} noop`, { ...payload, reason: result.reason, noop: true });
    } else {
      this.logger?.warn(`${op} failed`, { ...payload, reason: result.reason });
    }
    return result;
  }

  private registryErrorReason(err: unknown): string {
    if (err instanceof QueueRegistryViolation) {
      return err.code === 'invalid-queue-name' ? 'invalid-name' : err.code;
    }
    return err instanceof Error ? err.message : 'operation-rejected';
  }

  private taskErrorReason(err: unknown): string {
    if (err instanceof QueueMutationRejected) {
      if (err.reason === 'task-not-found') return 'unknown-task-id';
      return err.reason;
    }
    if (err instanceof Error && /non-empty|exceeds/i.test(err.message)) {
      return 'invalid-description';
    }
    return err instanceof Error ? err.message : 'operation-rejected';
  }
}
