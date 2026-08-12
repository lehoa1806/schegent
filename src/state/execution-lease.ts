// Feature 092 (T048, US2, FR-031/FR-033) — the per-queue execution lease.
//
// This is the relaxed half of the lock split described in
// specs/092-multi-queue-concurrency/contracts/concurrent-drain-and-leases.md §2.
// `WorkspaceLockManager` keeps its exact semantics and its zero diff because it
// feeds `WorkflowSnapshot.isPrimary` and therefore every mutating IPC gate; a
// window must not become primary merely by draining a queue. So execution
// exclusion moves here, where the cardinality rule is different:
//
//   Window primacy : one holder per workspace   (state/lock.ts, unchanged)
//   Execution      : one holder per QUEUE, N across queues   (this file)
//
// Everything else is deliberately the same shape as the lock — same 5 s
// heartbeat, same 15 s staleness, same reclaim-on-stale terms — and the
// constants are imported rather than restated so the two cannot drift.

import { HEARTBEAT_INTERVAL_MS, STALENESS_THRESHOLD_MS, systemClock, systemScheduler } from './lock';
import type { Clock, Scheduler, SchedulerHandle } from './lock';

/** One queue's execution claim. Persisted under `KEYS.executionLeases`. */
export interface ExecutionLease {
  readonly queueId: string;
  readonly ownerId: string;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
}

/**
 * The store surface the manager needs. Narrow on purpose: the lease manager
 * owns the staleness arithmetic, the store owns persistence.
 */
export interface ExecutionLeaseStore {
  getExecutionLeases(): Record<string, ExecutionLease>;
  setExecutionLease(queueId: string, lease: ExecutionLease | null): Promise<void>;
}

export class ExecutionLeaseManager {
  private readonly store: ExecutionLeaseStore;
  private readonly ownerId: string;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private heartbeatHandle: SchedulerHandle | null = null;

  constructor(
    store: ExecutionLeaseStore,
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

  /**
   * Claim one queue. Succeeds when the queue is unclaimed, already ours, or
   * held by an owner whose heartbeat has gone stale — the same three cases the
   * workspace lock admits, applied per queue instead of per workspace.
   */
  public async tryAcquire(queueId: string): Promise<{ acquired: boolean; ownerId: string }> {
    const existing = this.store.getExecutionLeases()[queueId];
    const now = this.clock.now();
    if (existing && existing.ownerId !== this.ownerId) {
      if (!this.isStale(existing, now)) {
        return { acquired: false, ownerId: existing.ownerId };
      }
    }
    await this.store.setExecutionLease(queueId, {
      queueId,
      ownerId: this.ownerId,
      acquiredAt: existing?.ownerId === this.ownerId ? existing.acquiredAt : now,
      heartbeatAt: now
    });
    this.startHeartbeat();
    return { acquired: true, ownerId: this.ownerId };
  }

  public isHeld(queueId: string): boolean {
    const lease = this.store.getExecutionLeases()[queueId];
    if (!lease || lease.ownerId !== this.ownerId) return false;
    return !this.isStale(lease, this.clock.now());
  }

  public isForeignLeaseHeld(queueId: string): boolean {
    const lease = this.store.getExecutionLeases()[queueId];
    if (!lease || lease.ownerId === this.ownerId) return false;
    return !this.isStale(lease, this.clock.now());
  }

  public ownerOfRecord(queueId: string): string | null {
    return this.store.getExecutionLeases()[queueId]?.ownerId ?? null;
  }

  /** Every queue this window currently holds a live lease on. */
  public heldQueueIds(): readonly string[] {
    const now = this.clock.now();
    return Object.values(this.store.getExecutionLeases())
      .filter((lease) => lease.ownerId === this.ownerId && !this.isStale(lease, now))
      .map((lease) => lease.queueId);
  }

  /**
   * One interval refreshes every lease this window holds. A per-lease timer
   * would multiply memento writes by the queue count for no added safety —
   * the leases share an owner, so they go stale together or not at all.
   */
  public async heartbeat(): Promise<void> {
    const now = this.clock.now();
    const mine = Object.values(this.store.getExecutionLeases()).filter(
      (lease) => lease.ownerId === this.ownerId
    );
    for (const lease of mine) {
      await this.store.setExecutionLease(lease.queueId, { ...lease, heartbeatAt: now });
    }
  }

  public async release(queueId: string): Promise<void> {
    const lease = this.store.getExecutionLeases()[queueId];
    if (lease && lease.ownerId === this.ownerId) {
      await this.store.setExecutionLease(queueId, null);
    }
    this.stopHeartbeatIfIdle();
  }

  public async releaseAll(): Promise<void> {
    // Each write awaits, so the key set this started from can be stale by the
    // time the loop reaches the next key — the drain's step-7 failure path
    // releases its own queue, and another window's release rewrites the whole
    // record. Re-read and guard rather than assume: the only caller is
    // `dispose()`, which releases the workspace lock immediately afterwards,
    // and a throw here would skip that release.
    for (const queueId of Object.keys(this.store.getExecutionLeases())) {
      const lease = this.store.getExecutionLeases()[queueId];
      if (lease?.ownerId === this.ownerId) {
        await this.store.setExecutionLease(queueId, null);
      }
    }
    this.stopHeartbeatIfIdle();
  }

  /**
   * Run `fn` while holding one queue's lease, releasing on both the normal and
   * the throwing path.
   *
   * Unlike `WorkspaceLockManager.withLock`, contention returns `null` instead
   * of throwing `LockHeldError`: losing an execution lease means another window
   * is already draining that queue, which is the ordinary outcome of the
   * drain's step 6 and not an error the operator should ever see. The workspace
   * lock throws because losing *primacy* genuinely aborts what the caller was
   * doing.
   */
  public async withLease<T>(queueId: string, fn: () => Promise<T>): Promise<T | null> {
    const probe = await this.tryAcquire(queueId);
    if (!probe.acquired) return null;
    try {
      return await fn();
    } finally {
      await this.release(queueId).catch(() => undefined);
    }
  }

  private isStale(lease: ExecutionLease, now: number): boolean {
    return now - lease.heartbeatAt > STALENESS_THRESHOLD_MS;
  }

  private startHeartbeat(): void {
    if (this.heartbeatHandle) return;
    this.heartbeatHandle = this.scheduler.setInterval(() => {
      void this.heartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeatIfIdle(): void {
    if (Object.values(this.store.getExecutionLeases()).some((l) => l.ownerId === this.ownerId)) {
      return;
    }
    this.heartbeatHandle?.clear();
    this.heartbeatHandle = null;
  }
}
