// QueueManager — single-queue mode (Feature 030).
//
// The unified workspace queue is the canonical `'default'` queue defined
// in `queue-registry`. The manager exposes pause/resume + task-level
// mutators (reorder, modify, remove, retry, clear) plus the headless
// pump helpers (peekNextPending, hasCapacity, markInFlight, finish).
//
// Multi-queue management surface (create/rename/delete/move-between/save
// queue settings) was removed in Feature 030; the v6 migration coalesced
// any prior multi-queue state into the single `'default'` entry. The
// registry never carries a schedule under single-queue mode, so the
// `fireDueSchedules` watchdog path is a no-op in practice (the function
// is retained for migration robustness and to keep the watchdog wiring
// stable).
//
// Pause semantics (preserved):
//   - operator pause/resume: `setQueuePausedState`
//   - cascade pause/resume:  `cascadedPause`, `cascadedResume`
//     (cascade is overridden by an explicit operator pause; cascadedResume
//      is a strict no-op when the entry's `pauseSource !== 'cascade'`.)
import { randomUUID } from 'crypto';
import { QueueMutationRejected, type WorkspaceStateStore } from '../state/workspace-state';
import type { WorkflowRun } from '../state/workflow-run';
import type { SanitizedLogger } from '../lib/logger';
import {
  DEFAULT_QUEUE_ID,
  findQueue,
  setQueuePaused,
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
  validateDescription
} from './feature-request';

export interface MutationResult {
  ok: boolean;
  reason?: string;
}

export interface ClearResult {
  removed: number;
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

export interface QueueMutationDetail extends MutationResult {
  queueId?: string;
  taskId?: string;
  priorStatus?: FeatureRequestStatus;
  runId?: string | null;
  taskCount?: number;
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
}

// Feature 030 — single-queue mode removed the multi-queue `deleteNamedQueue`
// surface. The `QueueDeleteDisposition` discriminant is no longer needed.

// BUG-001 (FR-022): idempotent rejection reasons → DEBUG, not WARN.
const IDEMPOTENT_REJECT_REASONS: ReadonlySet<string> = new Set(['not-paused', 'already-paused']);

/**
 * Feature 065 — minimal hook that the QueueManager's pause/resume paths
 * use to cancel an outstanding scheduled-start timer when the queue
 * leaves `idle-pending` via an operator pause (FR-019). Kept structural
 * so unit tests can satisfy it without importing the coordinator.
 */
export interface ScheduledStartCancelHook {
  cancel(queueId: string, reason: 'pause-cancel'): Promise<void> | void;
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

  public list(): FeatureRequest[] {
    return this.store.getQueue().requests.slice();
  }

  public peekNextPending(): FeatureRequest | null {
    // Feature 030 — single-queue mode. The registry has exactly one
    // entry (id === DEFAULT_QUEUE_ID) by v6 invariant. If that entry is
    // manually-paused (operator OR cascade), peek returns null. Otherwise
    // pick the oldest pending request on the default queue by position.
    const registry = this.store.getQueueRegistry();
    const entry = registry.entries[0];
    if (!entry || entry.state !== 'active') return null;
    const requests = this.store.getQueue().requests;
    let best: FeatureRequest | null = null;
    for (const r of requests) {
      if (r.status !== 'pending') continue;
      if ((r.queueId ?? DEFAULT_QUEUE_ID) !== DEFAULT_QUEUE_ID) continue;
      if (best === null || r.position < best.position) {
        best = r;
      }
    }
    return best;
  }

  public hasInFlight(): boolean {
    return this.inFlightCount() > 0;
  }

  public inFlightCount(): number {
    return this.store.getQueue().requests.filter((r) => r.status === 'in-flight').length;
  }

  public hasCapacity(): boolean {
    return this.inFlightCount() < this.store.getGlobalConcurrencyCap();
  }

  public async enqueue(
    description: string,
    options: {
      pipelineId?: string;
      rerun?: FeatureRequestRerun;
      queueId?: string;
      position?: number;
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
      ...(options.rerun ? { rerun: options.rerun } : {})
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
      sizeAfter: this.store.getQueue().requests.length
    });
    return inserted;
  }

  public async markInFlight(featureId: string, runId: string): Promise<void> {
    const queue = this.store.getQueue();
    if (!this.hasCapacity() && queue.inFlightId !== featureId) {
      throw new Error(`Another request is already in flight: ${queue.inFlightId}`);
    }
    const now = Date.now();
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
    await this.store.setQueue({ ...queue, requests, inFlightId: featureId });
    // Feature 019 — DEBUG instrumentation. `markInFlight` is the
    // effective "dequeue" — a pending task transitions to in-flight.
    // `sizeAfter` reflects the pending count after the transition.
    const updatedQueue = this.store.getQueue();
    const pendingAfter = updatedQueue.requests.filter((r) => r.status === 'pending').length;
    const movedRequest = updatedQueue.requests.find((r) => r.id === featureId);
    this.logger?.debug('queue-manager.dequeue', {
      taskId: featureId,
      queueId: movedRequest?.queueId ?? null,
      sizeAfter: pendingAfter
    });
  }

  public async finish(
    featureId: string,
    status: FeatureRequestStatus,
    lastError: FeatureRequestFailure | string | null = null
  ): Promise<void> {
    const queue = this.store.getQueue();
    const now = Date.now();
    const requests = queue.requests.map((r) =>
      r.id === featureId
        ? {
            ...r,
            status,
            completedAt: now,
            updatedAt: now,
            lastError: status === 'failed' ? lastError ?? r.lastError : r.lastError
          }
        : r
    );
    const inFlightId = queue.inFlightId === featureId ? null : queue.inFlightId;
    await this.store.setQueue({ ...queue, requests, inFlightId });
  }

  public async pause(
    featureId: string,
    pauseCause: FeatureRequestPauseCause | null = null
  ): Promise<boolean> {
    const queue = this.store.getQueue();
    const idx = queue.requests.findIndex((r) => r.id === featureId);
    if (idx === -1) return false;
    const now = Date.now();
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
    const inFlightId = queue.inFlightId === featureId ? null : queue.inFlightId;
    await this.store.setQueue({ ...queue, requests, inFlightId });
    return true;
  }

  public async cancel(featureId: string): Promise<boolean> {
    const queue = this.store.getQueue();
    const idx = queue.requests.findIndex((r) => r.id === featureId);
    if (idx === -1) return false;
    if (queue.requests[idx].status !== 'pending') return false;
    const now = Date.now();
    const requests = queue.requests.map((r, i) =>
      i === idx
        ? { ...r, status: 'canceled' as FeatureRequestStatus, completedAt: now, updatedAt: now }
        : r
    );
    await this.store.setQueue({ ...queue, requests });
    return true;
  }

  public async remove(featureId: string): Promise<boolean> {
    try {
      await this.store.removePendingRequest(featureId);
      return true;
    } catch {
      return false;
    }
  }

  // Feature 030 — single-queue mode: multi-queue management methods removed;
  // canonical queue is always 'default' (v6 registry shape).
  // Canonical single-writer for the unified queue's pause state (BUG-001
  // FR-020/FR-021): atomic dual-write of registry state + pauseSource and
  // the legacy `QueueState.paused` boolean. `pauseSource` defaults to
  // 'operator'; pass 'cascade' from `cascadedPause` and 'retry-cap' from
  // the retry-handler. On clear, all sources are uniformly cleared.
  public async setQueuePausedState(
    paused: boolean,
    queueId?: string,
    pausedReason: string | null = null,
    pauseSource: Exclude<QueuePauseSource, null> = 'operator'
  ): Promise<QueueMutationDetail> {
    const op = paused ? 'queue-manager.pause' : 'queue-manager.resume';
    const fields: Record<string, unknown> = paused
      ? { queueId: queueId ?? null, reason: pausedReason, source: pauseSource }
      : { queueId: queueId ?? null, source: pauseSource };
    return this.logMutation(op, fields, async () => {
      try {
        const resolvedQueueId = queueId ?? this.store.getDefaultQueueId();
        const registry = this.store.getQueueRegistry();
        const existing = findQueue(registry, resolvedQueueId);
        if (!existing) return { ok: false, reason: 'unknown-queue-id' };
        const alreadyPaused = existing.state === 'manually-paused';
        // Idempotency: paused-true is a no-op only when the source matches.
        // Distinct sources (cascade → operator, etc.) overwrite attribution
        // so the resume side knows what to clear.
        if (paused && alreadyPaused && existing.pauseSource === pauseSource) {
          return { ok: false, reason: 'already-paused' };
        }
        if (!paused && !alreadyPaused) {
          // BUG-001 self-heal: registry already active but legacy boolean
          // stale (set by a pre-fix writer). Heal so operator Resume visibly
          // recovers the queue instead of being a confusing noop.
          if (resolvedQueueId === DEFAULT_QUEUE_ID) {
            const queue = this.store.getQueue();
            if (queue.paused === true) {
              await this.store.setQueue({ ...queue, paused: false, pausedReason: null });
              return { ok: true, queueId: resolvedQueueId };
            }
          }
          return { ok: false, reason: 'not-paused' };
        }

        const now = Date.now();
        await this.store.setQueueRegistry(
          setQueuePaused(registry, {
            id: resolvedQueueId,
            paused,
            pauseSource,
            now
          })
        );
        if (resolvedQueueId === DEFAULT_QUEUE_ID) {
          const queue = this.store.getQueue();
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
            await this.store.setQueue({
              ...queue,
              paused,
              pausedReason,
              queueLifecycle: 'operator-paused',
              scheduledStartAt: null,
              scheduledStartSource: null
            });
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
            await this.store.setQueue({
              ...queue,
              paused,
              pausedReason,
              queueLifecycle: nextLifecycle,
              scheduledStartAt: null,
              scheduledStartSource: null
            });
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
        }
        if (paused) {
          await this.pauseMatchingRunForQueue(resolvedQueueId, now);
        } else {
          await this.resumeMatchingRunForQueue(resolvedQueueId, now);
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
        const registry = this.store.getQueueRegistry();
        const existing = findQueue(registry, queueId);
        if (!existing) return { ok: false, reason: 'unknown-queue-id' };
        if (existing.state === 'manually-paused') {
          // Either already cascade (idempotent) or operator-pause-wins.
          return { ok: true, queueId };
        }
        const now = Date.now();
        await this.store.setQueueRegistry(
          setQueuePaused(registry, {
            id: queueId,
            paused: true,
            pauseSource: 'cascade',
            now
          })
        );
        if (queueId === DEFAULT_QUEUE_ID) {
          const queue = this.store.getQueue();
          await this.store.setQueue({ ...queue, paused: true, pausedReason: null });
        }
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
        const registry = this.store.getQueueRegistry();
        const existing = findQueue(registry, queueId);
        if (!existing) return { ok: false, reason: 'unknown-queue-id' };
        if (existing.state !== 'manually-paused' || existing.pauseSource !== 'cascade') {
          return { ok: true, queueId };
        }
        const now = Date.now();
        await this.store.setQueueRegistry(
          setQueuePaused(registry, { id: queueId, paused: false, now })
        );
        if (queueId === DEFAULT_QUEUE_ID) {
          const queue = this.store.getQueue();
          await this.store.setQueue({ ...queue, paused: false, pausedReason: null });
        }
        return { ok: true, queueId };
      } catch (err) {
        return { ok: false, reason: this.registryErrorReason(err) };
      }
    });
  }

  public async saveQueueSettings(params: {
    globalConcurrencyCap: number;
    defaultQueueId: string;
  }): Promise<QueueMutationDetail> {
    // Feature 056 Track 4 (FR-018..FR-022) — v1 ships exactly one
    // active run. The package contribution, host validator
    // (`KEY_SPECS['queue.globalConcurrencyCap'].max`), and this
    // QueueManager validator all pin the cap at 1; relaxing this
    // requires re-validating multi-active-run lock semantics.
    if (
      !Number.isInteger(params.globalConcurrencyCap) ||
      params.globalConcurrencyCap < 1 ||
      params.globalConcurrencyCap > 1
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

  public async removeTask(taskId: string): Promise<QueueMutationDetail> {
    try {
      const removed = await this.store.removeRequest(taskId);
      const run = this.store.getRun();
      if (removed.status === 'in-flight' && run?.featureId === removed.id) {
        await this.store.setRun({
          ...run,
          status: 'canceled',
          lastTransitionAt: Date.now()
        });
      }
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
   * `fromPosition` and `toPosition` are the **pending-row positions**
   * (0..pendingCount-1), matching the operator-visible reorder UX —
   * not the raw `FeatureRequest.position` field which can be sparse
   * once in-flight rows are interleaved.
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
    newOrder: readonly string[];
  }> {
    const queue = this.store.getQueue();
    const pending = queue.requests
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.position - b.position);
    const pendingOrder = pending.map((r) => r.id);
    const target = queue.requests.find((r) => r.id === taskId);

    if (!target) {
      return {
        outcome: 'rejected',
        cause: 'invalid-position',
        fromPosition: -1,
        toPosition: newPosition,
        newOrder: pendingOrder
      };
    }
    if (target.status !== 'pending') {
      return {
        outcome: 'rejected',
        cause: 'task-not-pending',
        fromPosition: -1,
        toPosition: newPosition,
        newOrder: pendingOrder
      };
    }
    if (
      !Number.isInteger(newPosition) ||
      newPosition < 0 ||
      newPosition >= pending.length
    ) {
      const fromIdx = pendingOrder.indexOf(taskId);
      return {
        outcome: 'rejected',
        cause: 'invalid-position',
        fromPosition: fromIdx,
        toPosition: newPosition,
        newOrder: pendingOrder
      };
    }
    const fromPosition = pendingOrder.indexOf(taskId);
    if (fromPosition === newPosition) {
      return {
        outcome: 'rejected',
        cause: 'no-op',
        fromPosition,
        toPosition: newPosition,
        newOrder: pendingOrder
      };
    }

    try {
      await this.store.reorderPendingRequest(taskId, newPosition);
      const afterPending = this.store
        .getQueue()
        .requests.filter((r) => r.status === 'pending')
        .sort((a, b) => a.position - b.position)
        .map((r) => r.id);
      return {
        outcome: 'success',
        fromPosition,
        toPosition: newPosition,
        newOrder: afterPending
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
        fromPosition,
        toPosition: newPosition,
        newOrder: pendingOrder
      };
    }
  }

  // Feature 030 — single-queue mode removed the cross-queue `moveTask`,
  // `setSchedule`, and `clearSchedule` mutators. Tasks always live on
  // 'default'; the registry never carries a schedule (v6 invariant in
  // `validateQueueRegistry`).

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
      next = setQueuePaused(next, { id: entry.id, paused: false, now });
      next = setQueueSchedule(next, { id: entry.id, schedule: null, now });
    }
    await this.store.setQueueRegistry(next);
    return due.map((entry) => entry.id);
  }

  public async retry(featureId: string): Promise<MutationResult> {
    const queue = this.store.getQueue();
    const idx = queue.requests.findIndex((r) => r.id === featureId);
    if (idx === -1) return { ok: false, reason: 'not-found' };
    const target = queue.requests[idx];
    if (target.status !== 'failed' && target.status !== 'canceled' && target.status !== 'paused') {
      return { ok: false, reason: 'illegal-state' };
    }
    const now = Date.now();
    const updated: FeatureRequest = {
      ...target,
      status: 'pending',
      retryCount: target.retryCount + 1,
      lastError: null,
      pausedReason: null,
      completedAt: null,
      startedAt: null,
      updatedAt: now,
      runId: null
    };
    const without = queue.requests.filter((_, i) => i !== idx);
    const inFlightIdx = without.findIndex((r) => r.status === 'in-flight');
    const insertAt = inFlightIdx === -1 ? 0 : inFlightIdx + 1;
    const reordered = [...without.slice(0, insertAt), updated, ...without.slice(insertAt)];
    const repositioned = reordered.map((r, i) => ({ ...r, position: i }));
    await this.store.setQueue({ ...queue, requests: repositioned });
    return { ok: true };
  }

  public async moveUp(featureId: string): Promise<MutationResult> {
    return this.move(featureId, -1);
  }

  public async moveDown(featureId: string): Promise<MutationResult> {
    return this.move(featureId, 1);
  }

  public async clearCompleted(): Promise<ClearResult> {
    return this.clearByStatus('completed');
  }

  public async clearFailed(): Promise<ClearResult> {
    return this.clearByStatus('failed');
  }

  // Feature 063 — atomic queue + run + pause + watchdog reset (FR-005).
  //
  // Callers (the `clear-all-handler`) acquire the workspace lock OUTSIDE
  // this call (via `WorkspaceLockManager.withLock`) and pass a runner-ack
  // probe that wraps `controller.cancelActive()` + a 2s ack race. The
  // method:
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
  public async clearAll(probe?: CleanAllRunnerAckProbe | null): Promise<CleanAllResult> {
    const queueBefore = this.store.getQueue();
    const runBefore = this.store.getRun();
    const watchdogBefore = this.store.getWatchdog();

    const removed = {
      pending: 0,
      completed: 0,
      failed: 0,
      canceled: 0
    };
    for (const r of queueBefore.requests) {
      if (r.status === 'pending') removed.pending++;
      else if (r.status === 'completed') removed.completed++;
      else if (r.status === 'failed') removed.failed++;
      else if (r.status === 'canceled') removed.canceled++;
    }

    const inflightBefore =
      queueBefore.inFlightId !== null ||
      queueBefore.requests.some((r) => r.status === 'in-flight');
    const pauseBefore = queueBefore.paused;
    // Read pauseSource from the canonical registry entry (single source
    // of truth — the legacy `queue.paused` boolean only mirrors it).
    const registryBefore = this.store.getQueueRegistry();
    const defaultEntryBefore = registryBefore.entries.find(
      (e) => e.id === DEFAULT_QUEUE_ID
    );
    const pauseSourceBefore: CleanAllResult['pauseSource'] =
      defaultEntryBefore && defaultEntryBefore.pauseSource
        ? (defaultEntryBefore.pauseSource as CleanAllResult['pauseSource'])
        : null;
    const activeRunBefore = runBefore !== null;
    const watchdogActiveBefore =
      watchdogBefore.paused === true ||
      watchdogBefore.pausedSince !== null ||
      watchdogBefore.nextPollAt !== null ||
      watchdogBefore.cause !== null;

    const wasNoop =
      queueBefore.requests.length === 0 &&
      !inflightBefore &&
      !pauseBefore &&
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
        wasNoop: true
      };
    }

    // 1. Clear queue items (also drops `inFlightId`).
    await this.store.setQueue({
      ...queueBefore,
      requests: [],
      inFlightId: null,
      paused: false,
      pausedReason: null,
      updatedAt: Date.now()
    });

    // 2. Clear pause state via the canonical single-writer so the
    //    registry's `pauseSource` is cleared in lock-step with the
    //    legacy boolean (BUG-001 invariant retained).
    if (pauseBefore) {
      await this.setQueuePausedState(false, DEFAULT_QUEUE_ID, null, 'operator');
    }

    // 3. Clear the active run snapshot.
    if (activeRunBefore) {
      await this.store.setRun(null);
    }

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
    if (activeRunBefore) {
      await this.store.setRun(null);
    }

    return {
      removed,
      inflightAborted: inflightBefore,
      runnerAcked,
      pauseCleared: pauseBefore,
      pauseSource: pauseSourceBefore,
      activeRunCleared: activeRunBefore,
      watchdogCleared: watchdogActiveBefore,
      wasNoop: false
    };
  }

  public findById(id: string): FeatureRequest | null {
    return this.store.getQueue().requests.find((r) => r.id === id) ?? null;
  }

  private async move(featureId: string, direction: -1 | 1): Promise<MutationResult> {
    const queue = this.store.getQueue();
    const requests = queue.requests.slice();
    const idx = requests.findIndex((r) => r.id === featureId);
    if (idx === -1) return { ok: false, reason: 'not-found' };
    if (requests[idx].status !== 'pending') return { ok: false, reason: 'illegal-state' };
    const pendingIndices: number[] = [];
    for (let i = 0; i < requests.length; i++) {
      if (requests[i].status === 'pending') pendingIndices.push(i);
    }
    if (pendingIndices.length < 2) return { ok: false, reason: 'no-peer' };
    const myPendingPosition = pendingIndices.indexOf(idx);
    const peerPendingPosition = myPendingPosition + direction;
    if (peerPendingPosition < 0 || peerPendingPosition >= pendingIndices.length) {
      return { ok: false, reason: 'at-edge' };
    }
    const peerIdx = pendingIndices[peerPendingPosition];
    const now = Date.now();
    const swapped = requests.slice();
    swapped[idx] = { ...requests[peerIdx], updatedAt: now };
    swapped[peerIdx] = { ...requests[idx], updatedAt: now };
    const repositioned = swapped.map((r, i) => ({ ...r, position: i }));
    await this.store.setQueue({ ...queue, requests: repositioned });
    return { ok: true };
  }

  private async clearByStatus(status: FeatureRequestStatus): Promise<ClearResult> {
    const queue = this.store.getQueue();
    const before = queue.requests.length;
    const filtered = queue.requests.filter(
      (r) => r.status !== status || r.id === queue.inFlightId
    );
    if (filtered.length === before) return { removed: 0 };
    const repositioned = filtered.map((r, i) => ({ ...r, position: i }));
    await this.store.setQueue({ ...queue, requests: repositioned });
    // BUG-001 escape hatch: when the operator clears completed/failed items
    // and no in-flight task remains, also release any lingering pause so a
    // stale `retry-cap-exhausted` pause whose originating run is gone does
    // not strand future tasks. Skipped while a task is in flight to avoid
    // disturbing an active phase's pause state.
    if (!this.hasInFlight() && this.store.getQueue().paused) {
      await this.setQueuePausedState(false, undefined, null, 'operator');
    }
    return { removed: before - filtered.length };
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
    const run = this.store.getRun();
    const matching = this.matchingRunForQueue(run, queueId);
    if (!matching) return;
    if (matching.manualPauseAt !== null) return;
    await this.store.setRun({
      ...matching,
      manualPauseAt: now,
      manualPauseCause: 'queue-paused-mid-run'
    });
  }

  private async resumeMatchingRunForQueue(queueId: string, now: number): Promise<void> {
    const run = this.store.getRun();
    const matching = this.matchingRunForQueue(run, queueId);
    if (!matching || matching.manualPauseCause !== 'queue-paused-mid-run') return;
    await this.store.setRun({
      ...matching,
      status: matching.status === 'paused' ? 'running' : matching.status,
      manualPauseAt: null,
      manualPauseCause: null,
      lastTransitionAt: now
    });
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
