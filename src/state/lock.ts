import type { WorkspaceStateStore } from './workspace-state';
import type { WorkspaceLock } from './workflow-run';

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const STALENESS_THRESHOLD_MS = 15_000;

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface SchedulerHandle {
  clear(): void;
}

export interface Scheduler {
  setInterval(fn: () => void, ms: number): SchedulerHandle;
}

export const systemScheduler: Scheduler = {
  setInterval(fn, ms) {
    const id = setInterval(fn, ms);
    return {
      clear() {
        clearInterval(id);
      }
    };
  }
};

/**
 * The per-workspace window-primacy lease. Its tenure is activation-to-disposal:
 * acquired in `extension.ts` at activation, released at `dispose()`, and nowhere
 * else (feature 093, FR-028 / FR-032a).
 *
 * Deliberately **no** scope wrapper. Feature 034's `withLock(scope, fn)` released
 * in a `finally`, which made a window-scoped lease end at a Run-scoped moment:
 * it acquired idempotently per owner and kept no reference count, so
 * with two Runs in one window the first `finally` to run dropped primacy for
 * every Run in the window, and a rival window could claim the workspace while
 * this one was still executing. `RunDriver.drive()` was its last production
 * caller; removing that wrapper (and the `session.retain()` calls that existed
 * only to suppress its auto-release) left the method dead, and it is deleted
 * rather than kept, because a working wrapper is a working template for
 * reintroducing the defect. Reference-counting it was the rejected alternative —
 * it keeps the lease's lifetime implicit and has to be right at every release
 * site. Acquire with `tryAcquire()` and release only where the tenure genuinely
 * ends. `tests/integration/concurrent-run-execution.test.ts` (SC-009) pins this.
 */
export class WorkspaceLockManager {
  private readonly store: WorkspaceStateStore;
  private readonly ownerId: string;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private heartbeatHandle: SchedulerHandle | null = null;

  constructor(
    store: WorkspaceStateStore,
    ownerId: string,
    clock: Clock = systemClock,
    scheduler: Scheduler = systemScheduler
  ) {
    this.store = store;
    this.ownerId = ownerId;
    this.clock = clock;
    this.scheduler = scheduler;
  }

  public get id(): string {
    return this.ownerId;
  }

  public async tryAcquire(): Promise<{ acquired: boolean; ownerId: string }> {
    const existing = this.store.getLock();
    const now = this.clock.now();
    if (existing && existing.ownerId !== this.ownerId) {
      const stale = now - existing.heartbeatAt > STALENESS_THRESHOLD_MS;
      if (!stale) {
        return { acquired: false, ownerId: existing.ownerId };
      }
    }
    const lock: WorkspaceLock = {
      ownerId: this.ownerId,
      acquiredAt: existing?.ownerId === this.ownerId ? existing.acquiredAt : now,
      heartbeatAt: now
    };
    await this.store.setLock(lock);
    this.startHeartbeat();
    return { acquired: true, ownerId: this.ownerId };
  }

  public isHeld(): boolean {
    const lock = this.store.getLock();
    if (!lock) return false;
    if (lock.ownerId !== this.ownerId) return false;
    return this.clock.now() - lock.heartbeatAt <= STALENESS_THRESHOLD_MS;
  }

  public isForeignLockHeld(): boolean {
    const lock = this.store.getLock();
    if (!lock) return false;
    if (lock.ownerId === this.ownerId) return false;
    return this.clock.now() - lock.heartbeatAt <= STALENESS_THRESHOLD_MS;
  }

  public ownerOfRecord(): string | null {
    return this.store.getLock()?.ownerId ?? null;
  }

  public async heartbeat(): Promise<void> {
    const lock = this.store.getLock();
    if (!lock || lock.ownerId !== this.ownerId) return;
    await this.store.setLock({ ...lock, heartbeatAt: this.clock.now() });
  }

  public async release(): Promise<void> {
    this.stopHeartbeat();
    const lock = this.store.getLock();
    if (lock && lock.ownerId === this.ownerId) {
      await this.store.setLock(null);
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatHandle) return;
    this.heartbeatHandle = this.scheduler.setInterval(() => {
      void this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    this.heartbeatHandle?.clear();
    this.heartbeatHandle = null;
  }
}
