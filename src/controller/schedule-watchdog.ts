import type { QueueState } from '../queue/feature-request';
import type { SanitizedLogger } from '../lib/logger';
import type { AuditEventType } from '../contracts/audit-events';

export interface QueueScheduleWatchdogDeps {
  /**
   * Every queue's persisted execution state. FR-R3-002 (T284) — the watchdog
   * reads `QueueState`, not `QueueRegistryEntry.schedule`. The registry's
   * `schedule` field has been `null` since the v5 → v6 migration; the live
   * per-queue deadline is `QueueState.scheduledStartAt`, added by feature 065
   * and made per-queue by feature 092's v9 → v10 record.
   */
  readonly getQueueStates: () => Readonly<Record<string, QueueState>>;
  /**
   * Whether `ScheduledStartCoordinator` still holds an in-process timer for
   * this queue. A queue whose timer is armed and healthy is the coordinator's
   * to fire; the watchdog exists for the deadlines that no timer will reach.
   */
  readonly hasArmedTimer: (queueId: string) => boolean;
  /**
   * The shared promotion hop — clears the queue's schedule fields, then asks
   * `AutoDrainCoordinator.drainIfIdle(queueId)`. FR-R3-002 (T285): the same
   * function the coordinator's `onFire` calls, so promotion has one path and
   * the watchdog is not a second idle-pending enforcement site.
   */
  readonly promote: (queueId: string) => Promise<void> | void;
  /**
   * Whether this window may promote a due schedule.
   *
   * FR-R3-024 (FR-013, FR-016a) — widened to admit a promise, because the host
   * now wires `lock.hasPrimacy()` here rather than `lock.isHeld()`.
   * `WorkspaceLockManager` splits its two predicates by purpose: `isHeld()` is
   * synchronous and *advisory*, reading the `Memento` mirror of the ownership
   * record for projection; `hasPrimacy()` awaits `verifyClaim()` and is
   * *authoritative*, carrying the fencing token issued at acquisition.
   * Promoting a schedule is a decision, not a projection.
   *
   * The rationale lives on this dep rather than at the wiring line because
   * `src/extension.ts` is under a line budget whose own rule puts the decision
   * in the module that owns it. Today's mirror read happens to be safe — the
   * mirror can never be fresher than the record it mirrors — but that is a
   * property of statement order in `lock.ts` and `ownership-registry.ts`, not
   * of the rule those two modules state.
   *
   * A refusal is a *deferral*: `tick()` returns `[]` and the queue's
   * `scheduledStartAt` stays persisted, so the next tick retries. That also
   * makes the fail-closed answer `hasPrimacy()` gives when the storage layer
   * cannot answer cost nothing but one tick.
   */
  readonly isPrimary: () => boolean | Promise<boolean>;
  /**
   * Whether the active Process catalog holds no Pipeline. Feature 098 (FR-031a)
   * made an empty catalog a refusal at fire time:
   * `ScheduledStartCoordinator.refuseOnEmptyCatalog()` drops the timer, tells
   * the operator once, and leaves the queue `idle-pending` with its deadline
   * still persisted — which is exactly the shape `tick()` reads as due and
   * unowned. Without this the sweep re-fires the refused start on its next pass,
   * so the gate belongs on the same predicate the coordinator gates on.
   *
   * Optional so a host that has no catalog to consult (and every test that is
   * not about this gate) behaves as before: absent means "not empty".
   */
  readonly isCatalogEmpty?: () => boolean;
  readonly logger: Pick<SanitizedLogger, 'warn' | 'info'>;
  readonly audit?: {
    append(entry: {
      runId: string;
      phase: string;
      iteration: number;
      eventType: AuditEventType;
      payload: Record<string, unknown>;
      outcome: 'info' | 'success' | 'failure';
    }): Promise<unknown>;
  };
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * FR-R3-002 (T284/T285) — the recovery sweep for scheduled starts that no
 * in-process timer will fire.
 *
 * This class was a documented no-op from feature 030 to feature R3-002, on the
 * premise that `QueueRegistryEntry.schedule` is always `null` in single-queue
 * mode. The premise stopped holding when feature 065 moved the deadline to
 * `QueueState.scheduledStartAt` and feature 092 made that state per-queue, and
 * its absence left one state unreachable: a scheduled start denied at fire time
 * because a foreign window held the workspace lock. `ScheduledStartCoordinator`
 * leaves such a queue in `idle-pending` with its deadline still persisted and
 * its timer dropped — and `AutoDrainCoordinator.drainIfIdle()` *refuses*
 * `idle-pending` by design, so nothing else in the system would ever pick it
 * up. That schedule stayed pending indefinitely.
 *
 * The sweep is deliberately narrow. It does not decide whether a queue may run
 * — step 1 of the drain gate still does, and `promote` is how this class asks
 * it. It only answers "is there an elapsed deadline that no timer owns?", which
 * is a question about liveness, not about policy.
 */
export class QueueScheduleWatchdog {
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;
  private timer: unknown = null;
  private disposed = false;

  constructor(
    private readonly deps: QueueScheduleWatchdogDeps,
    private readonly tickIntervalMs: number = 60_000
  ) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
    this.now = deps.now ?? (() => Date.now());
  }

  public start(): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = this.setTimer(() => {
      void this.tick().catch((err) =>
        this.deps.logger.warn(`schedule-watchdog tick failed: ${(err as Error).message}`)
      );
    }, this.tickIntervalMs);
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * Promotes every queue holding an elapsed, unowned scheduled start and
   * returns the ids it acted on — the empty array when there is nothing due,
   * which is the ordinary case.
   *
   * A queue is due when all four hold on the **same entry**:
   *   - `queueLifecycle === 'idle-pending'` — the lifecycle a persisted
   *     `scheduledStartAt` is required to be paired with;
   *   - `scheduledStartAt !== null` — there is a deadline at all;
   *   - `scheduledStartAt <= now` — it has elapsed;
   *   - no armed timer — the coordinator is not about to fire it itself.
   *
   * The last clause is what keeps this from racing the coordinator into a
   * double promotion. The first is what keeps it from promoting a queue an
   * operator paused or already started: those are not `idle-pending`, so a
   * schedule superseded on either ground is skipped here too, exactly as the
   * coordinator skips it.
   *
   * Due queues are promoted oldest-deadline-first, so a backlog that
   * accumulated behind a foreign lock is released in the order the operator
   * scheduled it. Each promotion is wrapped individually: one queue that
   * cannot promote must not skip the queues behind it.
   *
   * An empty Process catalog holds the whole sweep, silently: the coordinator
   * already refused these deadlines once and said so, and restating that once a
   * minute for as long as the deadline stands is noise, not information.
   */
  public async tick(): Promise<readonly string[]> {
    if (this.disposed) return [];
    // One ownership read per tick, not one per due queue: the sweep below is
    // synchronous over the states this read already authorized.
    if (!(await this.deps.isPrimary())) return [];
    if (this.deps.isCatalogEmpty?.() === true) return [];
    const now = this.now();
    const due = Object.entries(this.deps.getQueueStates())
      .filter(
        ([queueId, state]) =>
          state.queueLifecycle === 'idle-pending' &&
          state.scheduledStartAt !== null &&
          state.scheduledStartAt <= now &&
          !this.deps.hasArmedTimer(queueId)
      )
      .map(([queueId, state]) => ({
        queueId,
        scheduledStartAt: state.scheduledStartAt as number,
        source: state.scheduledStartSource
      }))
      .sort((a, b) => a.scheduledStartAt - b.scheduledStartAt);

    const acted: string[] = [];
    for (const entry of due) {
      // FR-023a core payload: queueId, eventType, occurredAt, transitionReason.
      // `watchdog-recovered` distinguishes this from the coordinator's
      // `timer-fired` and `offline-elapsed` — the deadline elapsed while this
      // window was up, but no timer was left to fire it. No task description
      // or operator-authored content appears here.
      await this.appendAudit({
        queueId: entry.queueId,
        scheduledStartAt: entry.scheduledStartAt,
        scheduledStartSource: entry.source,
        firedAt: now,
        lateByMs: now - entry.scheduledStartAt,
        transitionReason: 'watchdog-recovered'
      });
      try {
        await this.deps.promote(entry.queueId);
        acted.push(entry.queueId);
      } catch (err) {
        this.deps.logger.warn(
          `schedule-watchdog promotion failed for one queue: ${(err as Error).message}`
        );
      }
    }
    return acted;
  }

  private async appendAudit(payload: Record<string, unknown>): Promise<void> {
    if (!this.deps.audit) return;
    try {
      await this.deps.audit.append({
        runId: '',
        phase: 'scheduled-start',
        iteration: 0,
        eventType: 'scheduled-start-fired',
        outcome: 'info',
        payload: { ...payload, occurredAt: this.now() }
      });
    } catch (err) {
      this.deps.logger.warn(
        `schedule-watchdog audit append failed: ${(err as Error).message}`
      );
    }
  }
}
