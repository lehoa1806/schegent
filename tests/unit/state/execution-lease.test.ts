// Feature 092 (T035, US2, FR-031/FR-033) — the per-queue execution lease.
//
// This is the half of the lock split that relaxes cardinality: N concurrent
// holders across distinct queues, at most one per queue, on the same staleness
// terms as the workspace lock. The other half — window primacy — is
// `WorkspaceLockManager`, whose diff is deliberately zero (T067).
//
// The staleness constants are IMPORTED from `state/lock.ts` rather than
// restated, because contracts/concurrent-drain-and-leases.md §2 makes "same
// constants" part of the contract; a local copy would let the two drift while
// every assertion here kept passing.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  ExecutionLeaseManager,
  type ExecutionLease
} from '../../../src/state/execution-lease';
import {
  HEARTBEAT_INTERVAL_MS,
  STALENESS_THRESHOLD_MS,
  type Clock,
  type Scheduler,
  type SchedulerHandle
} from '../../../src/state/lock';

/** The narrow store surface the lease manager reads and writes. */
class LeaseStore {
  private leases: Record<string, ExecutionLease> = {};
  getExecutionLeases(): Record<string, ExecutionLease> {
    return this.leases;
  }
  async setExecutionLease(queueId: string, lease: ExecutionLease | null): Promise<void> {
    const next = { ...this.leases };
    if (lease === null) delete next[queueId];
    else next[queueId] = lease;
    this.leases = next;
  }
}

class FakeClock implements Clock {
  constructor(private t = 1_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

class FakeScheduler implements Scheduler {
  public intervals: { fn: () => void; ms: number; cleared: boolean }[] = [];
  setInterval(fn: () => void, ms: number): SchedulerHandle {
    const entry = { fn, ms, cleared: false };
    this.intervals.push(entry);
    return {
      clear() {
        entry.cleared = true;
      }
    };
  }
}

/**
 * A store where the first *release* also drops `alsoRemoves`, standing in for a
 * release that lands from elsewhere while a sweep is between two of its awaits.
 */
class VanishingStore extends LeaseStore {
  private done = false;
  constructor(private readonly alsoRemoves: string) {
    super();
  }
  override async setExecutionLease(
    queueId: string,
    lease: ExecutionLease | null
  ): Promise<void> {
    await super.setExecutionLease(queueId, lease);
    if (lease !== null || this.done) return;
    this.done = true;
    await super.setExecutionLease(this.alsoRemoves, null);
  }
}

function manager(
  store: LeaseStore,
  ownerId: string,
  clock: Clock,
  scheduler: Scheduler = new FakeScheduler()
): ExecutionLeaseManager {
  return new ExecutionLeaseManager(store, ownerId, clock, scheduler);
}

describe('ExecutionLeaseManager (T035, US2)', () => {
  let store: LeaseStore;
  let clock: FakeClock;

  beforeEach(() => {
    store = new LeaseStore();
    clock = new FakeClock();
  });

  describe('cardinality — N across queues, one per queue (FR-031)', () => {
    it('lets one owner hold leases on several distinct queues at once', async () => {
      const owner = manager(store, 'window-a', clock);
      for (const q of ['default', 'docs', 'research']) {
        expect((await owner.tryAcquire(q)).acquired, q).toBe(true);
      }
      expect(owner.heldQueueIds().slice().sort()).toEqual(['default', 'docs', 'research']);
    });

    it('lets two owners hold leases on two different queues concurrently', async () => {
      const a = manager(store, 'window-a', clock);
      const b = manager(store, 'window-b', clock);
      expect((await a.tryAcquire('default')).acquired).toBe(true);
      expect((await b.tryAcquire('docs')).acquired).toBe(true);
      expect(a.isHeld('default')).toBe(true);
      expect(b.isHeld('docs')).toBe(true);
    });

    it('refuses a second owner on the SAME queue and names the incumbent', async () => {
      const a = manager(store, 'window-a', clock);
      const b = manager(store, 'window-b', clock);
      await a.tryAcquire('default');
      const attempt = await b.tryAcquire('default');
      expect(attempt).toEqual({ acquired: false, ownerId: 'window-a' });
      expect(b.isHeld('default')).toBe(false);
      expect(b.isForeignLeaseHeld('default')).toBe(true);
    });

    it('is idempotent for the same owner and preserves the original acquiredAt', async () => {
      const a = manager(store, 'window-a', clock);
      await a.tryAcquire('default');
      const first = store.getExecutionLeases()['default'].acquiredAt;
      clock.advance(1_000);
      expect((await a.tryAcquire('default')).acquired).toBe(true);
      expect(store.getExecutionLeases()['default'].acquiredAt).toBe(first);
      expect(store.getExecutionLeases()['default'].heartbeatAt).toBe(clock.now());
    });

    it('releasing one queue leaves this owner holding the others', async () => {
      const a = manager(store, 'window-a', clock);
      await a.tryAcquire('default');
      await a.tryAcquire('docs');
      await a.release('default');
      expect(a.isHeld('default')).toBe(false);
      expect(a.isHeld('docs')).toBe(true);
      expect(Object.keys(store.getExecutionLeases())).toEqual(['docs']);
    });

    it('a release by a non-owner is a no-op rather than a steal', async () => {
      const a = manager(store, 'window-a', clock);
      const b = manager(store, 'window-b', clock);
      await a.tryAcquire('default');
      await b.release('default');
      expect(a.isHeld('default')).toBe(true);
    });
  });

  describe('staleness and reclaim (FR-033)', () => {
    it('reuses the workspace lock constants rather than a second pair', () => {
      expect(HEARTBEAT_INTERVAL_MS).toBe(5_000);
      expect(STALENESS_THRESHOLD_MS).toBe(15_000);
    });

    it('holds the lease against a rival right up to the staleness threshold', async () => {
      const a = manager(store, 'window-a', clock);
      const b = manager(store, 'window-b', clock);
      await a.tryAcquire('default');
      clock.advance(STALENESS_THRESHOLD_MS);
      expect((await b.tryAcquire('default')).acquired).toBe(false);
    });

    it('a crashed holder past the threshold is reclaimed by the next window', async () => {
      const crashed = manager(store, 'window-a', clock);
      const survivor = manager(store, 'window-b', clock);
      await crashed.tryAcquire('default');
      // The crashed window stops heart-beating; nothing else changes.
      clock.advance(STALENESS_THRESHOLD_MS + 1);
      expect((await survivor.tryAcquire('default')).acquired).toBe(true);
      expect(store.getExecutionLeases()['default'].ownerId).toBe('window-b');
      // And the crash strands nothing: the reclaimed lease is a fresh one.
      expect(store.getExecutionLeases()['default'].acquiredAt).toBe(clock.now());
    });

    it('a stale lease is reported as held by nobody', async () => {
      const a = manager(store, 'window-a', clock);
      const b = manager(store, 'window-b', clock);
      await a.tryAcquire('default');
      clock.advance(STALENESS_THRESHOLD_MS + 1);
      expect(a.isHeld('default')).toBe(false);
      expect(b.isForeignLeaseHeld('default')).toBe(false);
    });
  });

  describe('heartbeat (FR-031)', () => {
    it('arms a single interval at HEARTBEAT_INTERVAL_MS regardless of lease count', async () => {
      const scheduler = new FakeScheduler();
      const a = manager(store, 'window-a', clock, scheduler);
      await a.tryAcquire('default');
      await a.tryAcquire('docs');
      expect(scheduler.intervals).toHaveLength(1);
      expect(scheduler.intervals[0].ms).toBe(HEARTBEAT_INTERVAL_MS);
    });

    it('refreshes every lease this owner holds and touches no other owner\'s', async () => {
      const a = manager(store, 'window-a', clock);
      const b = manager(store, 'window-b', clock);
      await a.tryAcquire('default');
      await a.tryAcquire('docs');
      await b.tryAcquire('research');
      const foreignBefore = store.getExecutionLeases()['research'].heartbeatAt;

      clock.advance(HEARTBEAT_INTERVAL_MS);
      await a.heartbeat();

      expect(store.getExecutionLeases()['default'].heartbeatAt).toBe(clock.now());
      expect(store.getExecutionLeases()['docs'].heartbeatAt).toBe(clock.now());
      expect(store.getExecutionLeases()['research'].heartbeatAt).toBe(foreignBefore);
    });

    it('stops the interval once the last lease is released', async () => {
      const scheduler = new FakeScheduler();
      const a = manager(store, 'window-a', clock, scheduler);
      await a.tryAcquire('default');
      await a.tryAcquire('docs');
      await a.release('default');
      expect(scheduler.intervals[0].cleared).toBe(false);
      await a.release('docs');
      expect(scheduler.intervals[0].cleared).toBe(true);
    });

    it('releaseAll drops every lease this owner holds and no others', async () => {
      const a = manager(store, 'window-a', clock);
      const b = manager(store, 'window-b', clock);
      await a.tryAcquire('default');
      await a.tryAcquire('docs');
      await b.tryAcquire('research');
      await a.releaseAll();
      expect(Object.keys(store.getExecutionLeases())).toEqual(['research']);
    });

    it('releaseAll survives a lease that disappears mid-sweep', async () => {
      // `releaseAll` awaits a write per lease, so the key set it started from can
      // be stale by the time it reaches the next key: the drain's step-7 failure
      // path releases its own queue, and another window's release rewrites the
      // whole record. The only caller is `dispose()`, which releases the
      // workspace lock immediately afterwards — a throw here would skip that.
      const vanishing = new VanishingStore('docs');
      const a = manager(vanishing, 'window-a', clock);
      await a.tryAcquire('default');
      await a.tryAcquire('docs');

      await expect(a.releaseAll()).resolves.toBeUndefined();
      expect(Object.keys(vanishing.getExecutionLeases())).toEqual([]);
    });
  });

  describe('withLease', () => {
    it('releases on the normal path', async () => {
      const a = manager(store, 'window-a', clock);
      const seen = await a.withLease('default', async () => a.isHeld('default'));
      expect(seen).toBe(true);
      expect(a.isHeld('default')).toBe(false);
    });

    it('releases on the throwing path and rethrows', async () => {
      const a = manager(store, 'window-a', clock);
      await expect(
        a.withLease('default', async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      expect(a.isHeld('default')).toBe(false);
    });

    it('does not run the body when another window holds the queue', async () => {
      const a = manager(store, 'window-a', clock);
      const b = manager(store, 'window-b', clock);
      await a.tryAcquire('default');
      let ran = false;
      const result = await b.withLease('default', async () => {
        ran = true;
      });
      expect(ran).toBe(false);
      expect(result).toBeNull();
      // The incumbent is untouched.
      expect(store.getExecutionLeases()['default'].ownerId).toBe('window-a');
    });
  });
});
