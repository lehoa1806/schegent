// Feature 065 — ScheduledStartCoordinator owns the in-process `setTimeout`
// handles that drive `idle-pending → running` transitions when an operator (or
// programmatic caller) commits a future-dated start.
//
// Feature 092 (T058, FR-029/FR-030) made that one handle per queue. Feature 065
// owned a single `NodeJS.Timeout | null` and said so deliberately, because the
// repo enforced a single-queue model and one timer was therefore the whole
// truth; `arm()` cleared whatever was outstanding without asking which queue it
// belonged to. That is now a `Map<queueId, ActiveTimer>`, and every method is
// addressed:
//
//   - `arm(queueId, ...)` clears only that queue's outstanding handle. Arming
//     queue B must not silently disarm queue A's start — the operator scheduled
//     two things and would be told about neither.
//   - `fire(queueId)` reads *that* queue's `QueueState`. Reading the workspace
//     singleton would let a sibling's pause classify this queue's timer as
//     superseded.
//   - `cancel(queueId, ...)` disarms that queue and only that queue; it is the
//     disarm the queue-deletion path calls (FR-030).
//   - `reArm()` sweeps every queue carrying a persisted schedule rather than
//     hardcoding `'default'`.
//
// The CLAUDE.md hard rule that forbade a multi-queue registry "without a new
// state migration and scheduler design" is satisfied, not bypassed: US1 supplies
// the v9 → v10 migration and this file is the scheduler design.
//
// Persistence of `scheduledStartAt` lives on `QueueState` (feature 065
// schema v7). The coordinator only schedules in-process timers; it does
// NOT itself write to persisted state. State mutation is the caller's
// responsibility (the queue manager / guarded-run-service emits the
// `idle-pending-entered` audit event and persists `scheduledStartAt`).
//
// Audit emission policy:
//   - `scheduled-start-armed`     on `arm(...)`.
//   - `scheduled-start-fired`     on `fire(...)` when the queue is still in
//                                 `idle-pending` with matching `scheduledStartAt`.
//   - `scheduled-start-canceled`  on `cancel(...)`.
//   - `scheduled-start-superseded` on `fire(...)` when the queue is no
//                                  longer in a matching `idle-pending` state.
//                                  Payload carries one of the four `superseder`
//                                  literals enumerated in data-model.md
//                                  §Event-specific payload extensions:
//                                  'pause' / 'operator-start-now' /
//                                  'already-running' / 'lock-unavailable'.
//
// See:
//   specs/065-enqueue-start-separation/data-model.md
//   specs/065-enqueue-start-separation/contracts/audit-events.diff.md

import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { SanitizedLogger } from '../lib/logger';
import type { ScheduledStartSource } from '../queue/feature-request';
import type { WorkspaceStateStore } from '../state/workspace-state';

export type SchedulerSuperseder =
  | 'pause'
  | 'operator-start-now'
  | 'already-running'
  | 'lock-unavailable';

export type SchedulerCancelReason =
  | 'operator-cancel'
  | 'pause-cancel'
  | 'change-schedule';

export interface ScheduledStartFiredEvent {
  readonly queueId: string;
  readonly scheduledStartAt: number;
  readonly scheduledStartSource: ScheduledStartSource;
  readonly firedAt: number;
  readonly transitionReason: 'timer-fired' | 'offline-elapsed';
}

export interface ScheduledStartCoordinatorDeps {
  // Feature 092 (T058) — `getQueueStates` is what lets `reArm()` ask which
  // queues carry persisted execution state instead of assuming `'default'`.
  readonly store: Pick<WorkspaceStateStore, 'getQueue' | 'getQueueStates' | 'updateQueue'>;
  readonly auditWriter: Pick<AuditLogWriter, 'append'>;
  readonly logger: Pick<SanitizedLogger, 'warn'>;
  readonly onFire: (queueId: string) => Promise<void> | void;
  // Feature 065 (T049b) — optional UI observer fired AFTER the audit
  // event is appended and BEFORE `onFire` runs. Used by the status-bar
  // transient indicator. Side-effects in the observer MUST be cheap
  // (sync UI update only); the observer is invoked with `void` and any
  // thrown error is logged-and-swallowed.
  readonly onFiredObserver?: (event: ScheduledStartFiredEvent) => void;
  // Feature 065 (T053) — optional probe that returns `true` when the
  // workspace lock is held by a foreign owner at fire time. When true,
  // `fire()` emits `scheduled-start-superseded { superseder: 'lock-unavailable' }`
  // and clears `scheduledStartAt`/`scheduledStartSource` without flipping
  // the lifecycle out of `idle-pending`. The next auto-drain heartbeat
  // (after the foreign lock is released) will retry the promotion via
  // the existing rule (FR-014). The operator is NOT asked to reschedule.
  readonly isForeignLockHeld?: () => boolean;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (handle: NodeJS.Timeout) => void;
}

export interface ActiveTimer {
  readonly queueId: string;
  readonly scheduledStartAt: number;
  readonly source: ScheduledStartSource;
  readonly handle: NodeJS.Timeout;
}

export class ScheduledStartCoordinator {
  private readonly store: ScheduledStartCoordinatorDeps['store'];
  private readonly auditWriter: ScheduledStartCoordinatorDeps['auditWriter'];
  private readonly logger: ScheduledStartCoordinatorDeps['logger'];
  private readonly onFire: ScheduledStartCoordinatorDeps['onFire'];
  private readonly onFiredObserver: ScheduledStartCoordinatorDeps['onFiredObserver'];
  private readonly isForeignLockHeldFn: (() => boolean) | undefined;
  private readonly nowFn: () => number;
  private readonly setTimerFn: (fn: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimerFn: (handle: NodeJS.Timeout) => void;
  /**
   * Feature 092 (T058, FR-029/FR-030) — one entry per queue with an armed
   * start. Keyed by queue id, so every operation is addressed and no operation
   * can reach a queue it was not asked about.
   */
  private readonly timers = new Map<string, ActiveTimer>();

  constructor(deps: ScheduledStartCoordinatorDeps) {
    this.store = deps.store;
    this.auditWriter = deps.auditWriter;
    this.logger = deps.logger;
    this.onFire = deps.onFire;
    this.onFiredObserver = deps.onFiredObserver;
    this.isForeignLockHeldFn = deps.isForeignLockHeld;
    this.nowFn = deps.now ?? (() => Date.now());
    this.setTimerFn = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimerFn = deps.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  public async arm(
    queueId: string,
    scheduledStartAt: number,
    source: ScheduledStartSource
  ): Promise<void> {
    if (!Number.isFinite(scheduledStartAt) || scheduledStartAt <= 0) {
      throw new Error('arm: scheduledStartAt must be a finite positive epoch ms');
    }
    // Feature 092 (T058) — re-arming replaces *this* queue's outstanding
    // handle. Pre-092 this cleared whatever was armed, whichever queue owned it.
    const outstanding = this.timers.get(queueId);
    if (outstanding) {
      this.clearTimerFn(outstanding.handle);
      this.timers.delete(queueId);
    }
    const delayMs = Math.max(0, scheduledStartAt - this.nowFn());
    const handle = this.setTimerFn(() => {
      void this.fire(queueId);
    }, delayMs);
    this.timers.set(queueId, { queueId, scheduledStartAt, source, handle });
    await this.appendAudit('scheduled-start-armed', {
      queueId,
      scheduledStartAt,
      scheduledStartSource: source,
      transitionReason: source
    });
  }

  public async cancel(queueId: string, reason: SchedulerCancelReason): Promise<void> {
    const armed = this.timers.get(queueId);
    if (!armed) return;
    const { scheduledStartAt, source } = armed;
    this.clearTimerFn(armed.handle);
    this.timers.delete(queueId);
    await this.appendAudit('scheduled-start-canceled', {
      queueId,
      scheduledStartAt,
      scheduledStartSource: source,
      transitionReason: reason
    });
  }

  public async change(
    queueId: string,
    newScheduledStartAt: number,
    source: ScheduledStartSource
  ): Promise<void> {
    await this.cancel(queueId, 'change-schedule');
    await this.arm(queueId, newScheduledStartAt, source);
  }

  public async fire(queueId: string): Promise<void> {
    const armed = this.timers.get(queueId);
    if (!armed) return;
    // Feature 092 (T058) — addressed. Reading the workspace singleton here
    // would let a sibling queue's lifecycle decide this queue's supersession.
    const queueState = this.store.getQueue(queueId);
    if (
      queueState.queueLifecycle !== 'idle-pending' ||
      queueState.scheduledStartAt !== armed.scheduledStartAt
    ) {
      const superseder = this.classifySuperseder(queueState.queueLifecycle);
      this.timers.delete(queueId);
      await this.appendAudit('scheduled-start-superseded', {
        queueId,
        scheduledStartAt: armed.scheduledStartAt,
        scheduledStartSource: armed.source,
        superseder,
        transitionReason: 'superseded'
      });
      return;
    }
    // Feature 065 (T053 / FR-014) — lock-unavailable-at-fire. If a
    // competing process holds the workspace lock when the timer fires,
    // we cannot safely promote the queue. Emit `scheduled-start-superseded`
    // with `lock-unavailable`, clear the `scheduledStartAt` fields, and
    // leave the queue in `idle-pending`. The next auto-drain heartbeat
    // (after the foreign lock is released) will retry the promotion
    // under the existing rule. The operator is NOT asked to reschedule.
    if (this.isForeignLockHeldFn?.() === true) {
      this.timers.delete(queueId);
      await this.appendAudit('scheduled-start-superseded', {
        queueId,
        scheduledStartAt: armed.scheduledStartAt,
        scheduledStartSource: armed.source,
        superseder: 'lock-unavailable' as SchedulerSuperseder,
        transitionReason: 'superseded'
      });
      // Clear scheduledStartAt/Source so auto-drain takes over without
      // re-firing the timer. Keep lifecycle as idle-pending — operator
      // intent is preserved.
      await this.store.updateQueue(
        (current) => ({
          queue: {
            ...current,
            scheduledStartAt: null,
            scheduledStartSource: null,
            updatedAt: this.nowFn()
          },
          result: undefined
        }),
        queueId
      );
      return;
    }
    this.timers.delete(queueId);
    const firedAt = this.nowFn();
    await this.appendAudit('scheduled-start-fired', {
      queueId,
      scheduledStartAt: armed.scheduledStartAt,
      scheduledStartSource: armed.source,
      firedAt,
      transitionReason: 'timer-fired'
    });
    this.notifyFiredObserver({
      queueId,
      scheduledStartAt: armed.scheduledStartAt,
      scheduledStartSource: armed.source,
      firedAt,
      transitionReason: 'timer-fired'
    });
    try {
      await this.onFire(queueId);
    } catch (err) {
      this.logger.warn(`scheduled-start fire callback failed: ${(err as Error).message}`);
    }
  }

  /**
   * Called once at activation after the state migrations. Inspects every
   * queue's persisted state and re-arms (or fires-immediately) each pending
   * scheduled start. Per FR-011, the re-arm is computed against the persisted
   * original `scheduledStartAt`, not against an in-process tick.
   *
   * Feature 092 (T058, FR-029) — this sweeps `getQueueStates()` rather than
   * assuming `'default'`. A queue whose deadline elapsed while the window was
   * closed fires now; one still in the future is armed. Each queue is
   * independent: a failing fire on one must not skip the rest, which is why
   * the per-queue body is wrapped rather than the loop.
   */
  public async reArm(): Promise<void> {
    for (const [queueId, queueState] of Object.entries(this.store.getQueueStates())) {
      if (queueState.queueLifecycle !== 'idle-pending') continue;
      if (queueState.scheduledStartAt === null) continue;
      const source = queueState.scheduledStartSource ?? 'migration-default';
      if (queueState.scheduledStartAt > this.nowFn()) {
        await this.arm(queueId, queueState.scheduledStartAt, source);
        continue;
      }
      const firedAt = this.nowFn();
      await this.appendAudit('scheduled-start-fired', {
        queueId,
        scheduledStartAt: queueState.scheduledStartAt,
        scheduledStartSource: source,
        firedAt,
        transitionReason: 'offline-elapsed'
      });
      this.notifyFiredObserver({
        queueId,
        scheduledStartAt: queueState.scheduledStartAt,
        scheduledStartSource: source,
        firedAt,
        transitionReason: 'offline-elapsed'
      });
      try {
        await this.onFire(queueId);
      } catch (err) {
        this.logger.warn(`scheduled-start re-arm immediate fire failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * With a `queueId`, whether *that* queue holds an armed timer. Without one,
   * whether the workspace holds any — the pre-092 question, kept because the
   * status-bar indicator asks exactly that.
   */
  public hasActiveTimer(queueId?: string): boolean {
    if (queueId === undefined) return this.timers.size > 0;
    return this.timers.has(queueId);
  }

  /** The queue ids currently holding an armed timer. */
  public armedQueueIds(): string[] {
    return [...this.timers.keys()];
  }

  /**
   * One queue's armed timer, or `undefined`. Exposes the deadline, source and
   * handle so a caller can tell "still armed, untouched" from "re-armed" — a
   * bare `hasActiveTimer` cannot.
   */
  public armedTimer(queueId: string): ActiveTimer | undefined {
    return this.timers.get(queueId);
  }

  public dispose(): void {
    for (const armed of this.timers.values()) this.clearTimerFn(armed.handle);
    this.timers.clear();
  }

  private notifyFiredObserver(event: ScheduledStartFiredEvent): void {
    if (!this.onFiredObserver) return;
    try {
      this.onFiredObserver(event);
    } catch (err) {
      this.logger.warn(`scheduled-start onFiredObserver failed: ${(err as Error).message}`);
    }
  }

  private classifySuperseder(lifecycle: string): SchedulerSuperseder {
    if (lifecycle === 'operator-paused') return 'pause';
    if (lifecycle === 'running') return 'already-running';
    return 'operator-start-now';
  }

  private async appendAudit(
    eventType:
      | 'scheduled-start-armed'
      | 'scheduled-start-fired'
      | 'scheduled-start-canceled'
      | 'scheduled-start-superseded',
    payload: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.auditWriter.append({
        runId: '',
        phase: 'scheduled-start',
        iteration: 0,
        eventType,
        outcome: 'info',
        payload: { ...payload, occurredAt: payload.occurredAt ?? this.nowFn() }
      });
    } catch (err) {
      this.logger.warn(`schedule audit append failed (${eventType}): ${(err as Error).message}`);
    }
  }
}
