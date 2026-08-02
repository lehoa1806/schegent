// Feature 065 — ScheduledStartCoordinator owns the single in-process
// `setTimeout` handle that drives `idle-pending → running` transitions
// when an operator (or programmatic caller) commits a future-dated start.
//
// The repo enforces a single-queue model (spec 030 + CLAUDE.md hard rule
// "Never reintroduce a multi-queue registry without a new state
// migration and scheduler design"), so the coordinator owns a single
// `NodeJS.Timeout | null`, NOT a `Map<queueId, ...>`. The `queueId`
// parameter is accepted on the method signatures for forward-compatibility
// with audit-event payloads but the coordinator asserts at most one
// outstanding timer at any time.
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
  readonly store: Pick<WorkspaceStateStore, 'getQueue' | 'updateQueue'>;
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

interface ActiveTimer {
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
  private timer: ActiveTimer | null = null;

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
    if (this.timer !== null) {
      this.clearTimerFn(this.timer.handle);
      this.timer = null;
    }
    const delayMs = Math.max(0, scheduledStartAt - this.nowFn());
    const handle = this.setTimerFn(() => {
      void this.fire(queueId);
    }, delayMs);
    this.timer = { queueId, scheduledStartAt, source, handle };
    await this.appendAudit('scheduled-start-armed', {
      queueId,
      scheduledStartAt,
      scheduledStartSource: source,
      transitionReason: source
    });
  }

  public async cancel(queueId: string, reason: SchedulerCancelReason): Promise<void> {
    if (this.timer === null) return;
    if (this.timer.queueId !== queueId) return;
    const { scheduledStartAt, source } = this.timer;
    this.clearTimerFn(this.timer.handle);
    this.timer = null;
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
    const armed = this.timer;
    if (armed === null || armed.queueId !== queueId) return;
    const queueState = this.store.getQueue();
    if (
      queueState.queueLifecycle !== 'idle-pending' ||
      queueState.scheduledStartAt !== armed.scheduledStartAt
    ) {
      const superseder = this.classifySuperseder(queueState.queueLifecycle);
      this.timer = null;
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
      this.timer = null;
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
      await this.store.updateQueue((current) => ({
        queue: {
          ...current,
          scheduledStartAt: null,
          scheduledStartSource: null,
          updatedAt: this.nowFn()
        },
        result: undefined
      }));
      return;
    }
    this.timer = null;
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
   * Called once at activation after the v6→v7 migration. Inspects the
   * persisted queue state and re-arms (or fires-immediately) any pending
   * scheduled start. Per FR-011, the re-arm is computed against the
   * persisted original `scheduledStartAt`, not against an in-process tick.
   */
  public async reArm(): Promise<void> {
    const queueState = this.store.getQueue();
    if (queueState.queueLifecycle !== 'idle-pending') return;
    if (queueState.scheduledStartAt === null) return;
    const source = queueState.scheduledStartSource ?? 'migration-default';
    const queueId = 'default';
    if (queueState.scheduledStartAt <= this.nowFn()) {
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
      return;
    }
    await this.arm(queueId, queueState.scheduledStartAt, source);
  }

  public hasActiveTimer(): boolean {
    return this.timer !== null;
  }

  public dispose(): void {
    if (this.timer !== null) {
      this.clearTimerFn(this.timer.handle);
      this.timer = null;
    }
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
