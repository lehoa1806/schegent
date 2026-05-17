import type { WorkspaceStateStore } from './workspace-state';
import type { WorkspaceLock } from './workflow-run';
import { LockHeldError } from '../lib/errors';

export const HEARTBEAT_INTERVAL_MS = 5_000;
export const STALENESS_THRESHOLD_MS = 15_000;

/**
 * Feature 034 Item 046 — handle passed to a `withLock` body so it can mark
 * the lock as intentionally retained beyond the scope (e.g. a paused
 * workflow expects a later resume call to claim ownership). Without the
 * call, `withLock` releases the lock in its `finally` block on both normal
 * and exceptional exit.
 */
export interface LockSession {
  /**
   * Mark the lock as intentionally retained beyond this `withLock` scope.
   * Use when the wrapped function transitions persisted state into a
   * paused / pending-retry shape that a follow-up entry point will
   * resume. Without this call, the lock is released on exit (normal or
   * thrown). Idempotent; safe to call multiple times.
   */
  retain(): void;
}

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

  /**
   * Feature 034 Item 046 — auto-release lock wrapper. Acquires (idempotent
   * for the same owner), runs `fn`, and releases the lock in a `finally`
   * block. `fn` may call `session.retain()` to keep the lock held past
   * this scope (e.g. paused workflows that expect a later resume to claim
   * ownership). Thrown errors propagate; the lock is still released
   * unless retained.
   *
   * Replaces the hand-rolled `lockReleased` flag pattern in
   * `SchegentWorkflowController.driveRun()`. The wrapper IS the new
   * lock-released invariant: any new exit path is covered automatically.
   *
   * Throws `LockHeldError` when the lock is held by another owner.
   */
  public async withLock<T>(
    _scope: string,
    fn: (session: LockSession) => Promise<T>
  ): Promise<T> {
    const probe = await this.tryAcquire();
    if (!probe.acquired) {
      throw new LockHeldError(probe.ownerId);
    }
    let shouldRetain = false;
    const session: LockSession = {
      retain: () => {
        shouldRetain = true;
      }
    };
    try {
      return await fn(session);
    } finally {
      if (!shouldRetain) {
        await this.release().catch(() => undefined);
      }
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
