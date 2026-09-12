import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkspaceLockManager,
  HEARTBEAT_INTERVAL_MS,
  STALENESS_THRESHOLD_MS,
  type Clock,
  type Scheduler,
  type SchedulerHandle
} from '../../../src/state/lock';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { Memento } from '../../../src/state/workspace-state';

class FakeMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

class ManualClock implements Clock {
  current = 1_000_000;
  now() {
    return this.current;
  }
  advance(ms: number) {
    this.current += ms;
  }
}

class ManualScheduler implements Scheduler {
  intervals: Array<{ fn: () => void; ms: number }> = [];
  setInterval(fn: () => void, ms: number): SchedulerHandle {
    const entry = { fn, ms };
    this.intervals.push(entry);
    return {
      clear: () => {
        const i = this.intervals.indexOf(entry);
        if (i >= 0) this.intervals.splice(i, 1);
      }
    };
  }
}

let memento: FakeMemento;
let store: WorkspaceStateStore;
let clock: ManualClock;
let scheduler: ManualScheduler;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  clock = new ManualClock();
  scheduler = new ManualScheduler();
});

describe('WorkspaceLockManager.tryAcquire', () => {
  it('acquires when no lock exists', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    const result = await lock.tryAcquire();
    expect(result.acquired).toBe(true);
    expect(result.ownerId).toBe('owner-1');
  });

  it('starts the heartbeat after acquisition', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    await lock.tryAcquire();
    expect(scheduler.intervals).toHaveLength(1);
    expect(scheduler.intervals[0].ms).toBe(HEARTBEAT_INTERVAL_MS);
  });

  it('refuses when a non-stale lock is held by another owner', async () => {
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();
    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    const result = await lockB.tryAcquire();
    expect(result.acquired).toBe(false);
    expect(result.ownerId).toBe('owner-A');
  });

  it('takes over a stale lock', async () => {
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();
    clock.advance(STALENESS_THRESHOLD_MS + 1_000);
    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    const result = await lockB.tryAcquire();
    expect(result.acquired).toBe(true);
    expect(result.ownerId).toBe('owner-B');
  });

  it('renews the same owner without resetting acquiredAt', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    await lock.tryAcquire();
    const original = store.getLock()!.acquiredAt;
    clock.advance(1_000);
    await lock.tryAcquire();
    expect(store.getLock()!.acquiredAt).toBe(original);
  });
});

describe('WorkspaceLockManager.isHeld', () => {
  it('returns true after acquire', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    await lock.tryAcquire();
    expect(lock.isHeld()).toBe(true);
  });

  it('returns false when owner does not match', async () => {
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();
    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    expect(lockB.isHeld()).toBe(false);
  });

  it('returns false when heartbeat is stale even for owning manager', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    await lock.tryAcquire();
    clock.advance(STALENESS_THRESHOLD_MS + 1_000);
    expect(lock.isHeld()).toBe(false);
  });
});

describe('WorkspaceLockManager.heartbeat', () => {
  it('updates heartbeatAt timestamp', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    await lock.tryAcquire();
    const before = store.getLock()!.heartbeatAt;
    clock.advance(2_000);
    await lock.heartbeat();
    expect(store.getLock()!.heartbeatAt).toBe(before + 2_000);
  });

  it('is a no-op when not the owner', async () => {
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();
    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    await lockB.heartbeat();
    expect(store.getLock()!.ownerId).toBe('owner-A');
  });
});

// FR-032 / SC-011 (feature 152, BUG-001) — the election has a lifetime.
//
// `startHeartbeat()` used to be called only on `tryAcquire()`'s success branch, so
// a window that lost the election at activation armed nothing and never asked
// again: when the incumbent host died without releasing its lease, the survivor
// stayed passive for the rest of its lifetime. The reported instance ran 6h28m.
// The fix is that a refused window keeps an interval too, and that interval
// contests instead of beating — which is what `tick()` branches on.
describe('WorkspaceLockManager.onPrimacyGained', () => {
  it('contests on every tick and gains primacy once the holder goes stale', async () => {
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();

    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    const gains: Array<{ acquired: boolean; ownerId: string }> = [];
    lockB.onPrimacyGained((result) => gains.push(result));

    expect((await lockB.tryAcquire()).acquired).toBe(false);
    // The loser arms an interval too, at exactly the rate a primary writes: a
    // contending window that polled more slowly would widen the window in which
    // a dead host's workspace has no driver, and one that polled faster would
    // write more often than the protocol it is contesting.
    // Mapped rather than indexed, so the winner's cadence and the loser's are
    // both stated and neither ratchet is tripped: indexing is a
    // `noUncheckedIndexedAccess` site, and `?.`-guarding the index is a
    // `no-unnecessary-condition` one.
    expect(scheduler.intervals.map((entry) => entry.ms)).toEqual([
      HEARTBEAT_INTERVAL_MS,
      HEARTBEAT_INTERVAL_MS
    ]);
    expect(gains).toEqual([]);

    // A stops beating without releasing — the crash this bug is about.
    clock.advance(STALENESS_THRESHOLD_MS + 1_000);
    await lockB.tick();

    expect(gains).toHaveLength(1);
    expect(gains[0]).toEqual({ acquired: true, ownerId: 'owner-B' });
    expect(lockB.isHeld()).toBe(true);
  });

  it('stays silent on a tick that loses, and notifies only when one wins', async () => {
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();

    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    const gains: Array<{ acquired: boolean; ownerId: string }> = [];
    lockB.onPrimacyGained((result) => gains.push(result));
    await lockB.tryAcquire();

    // A is alive and beating: three contests, three refusals, no notification.
    for (let beat = 0; beat < 3; beat += 1) {
      clock.advance(HEARTBEAT_INTERVAL_MS);
      await lockA.heartbeat();
      await lockB.tick();
    }
    expect(gains).toEqual([]);
    expect(store.getLock()!.ownerId).toBe('owner-A');
  });

  it('says nothing when the very first tryAcquire wins', async () => {
    // Activation's own election is not a gain to announce: nothing is
    // subscribed yet, and `stage2-producers.ts` installs recovery inline on
    // that result. A notify inside `tryAcquire()` would fire here — this is the
    // case that fails if the notify site drifts out of `tick()`.
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    const gains: Array<{ acquired: boolean; ownerId: string }> = [];
    lock.onPrimacyGained((result) => gains.push(result));

    const result = await lock.tryAcquire();

    expect(result.acquired).toBe(true);
    expect(gains).toEqual([]);
  });

  it('notifies exactly once across a gain → loss → gain cycle', async () => {
    // SC-011's second clause. The re-acquisition `heartbeat()` performs inline
    // after a lost fence is a gain in every mechanical sense, and announcing it
    // would install recovery a second time over a window that never stopped
    // being the driver. It stays silent.
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();

    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    const gains: Array<{ acquired: boolean; ownerId: string }> = [];
    lockB.onPrimacyGained((result) => gains.push(result));
    await lockB.tryAcquire();

    // Gain: A goes stale, B's next contest wins.
    clock.advance(STALENESS_THRESHOLD_MS + 1_000);
    await lockB.tick();
    expect(gains).toHaveLength(1);

    // Loss: B stalls long enough for A to reclaim the resource at a new
    // generation, which invalidates B's fence.
    clock.advance(STALENESS_THRESHOLD_MS + 1_000);
    expect((await lockA.tryAcquire()).acquired).toBe(true);
    await lockA.release();

    // Gain again, inline at the fence-loss path rather than through a contest.
    await lockB.tick();

    expect(lockB.isHeld()).toBe(true);
    expect(gains).toHaveLength(1);
  });

  it('stops contesting when a losing window is disposed', async () => {
    // Hard rule 4 is unchanged by this feature: primacy is released at
    // `dispose()` and nowhere else, and `release()` already stops the interval
    // first — so the contest a loser now arms ends on the same call a winner's
    // heartbeat does, with no new release site.
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();
    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    await lockB.tryAcquire();
    expect(scheduler.intervals).toHaveLength(2);

    await lockB.release();

    expect(scheduler.intervals).toHaveLength(1);
  });

  it('disposes a primacy listener on request', async () => {
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();
    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    const gains: Array<{ acquired: boolean; ownerId: string }> = [];
    const subscription = lockB.onPrimacyGained((result) => gains.push(result));
    await lockB.tryAcquire();

    subscription.dispose();
    clock.advance(STALENESS_THRESHOLD_MS + 1_000);
    await lockB.tick();

    expect(lockB.isHeld()).toBe(true);
    expect(gains).toEqual([]);
  });

  it('survives a listener that throws, and keeps contesting afterwards', async () => {
    // The `onFenceLost` swallow discipline, for the same stated reason: one bad
    // callback must not be able to leave the window permanently non-primary.
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();

    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    const gains: Array<{ acquired: boolean; ownerId: string }> = [];
    lockB.onPrimacyGained(() => {
      throw new Error('subscriber exploded');
    });
    lockB.onPrimacyGained((result) => gains.push(result));
    await lockB.tryAcquire();

    clock.advance(STALENESS_THRESHOLD_MS + 1_000);
    await expect(lockB.tick()).resolves.toBeUndefined();

    // The sibling listener still ran, and the window is primary.
    expect(gains).toHaveLength(1);
    expect(lockB.isHeld()).toBe(true);

    // And the next tick is a heartbeat, not a second election.
    const before = store.getLock()!.heartbeatAt;
    clock.advance(HEARTBEAT_INTERVAL_MS);
    await lockB.tick();
    expect(store.getLock()!.heartbeatAt).toBe(before + HEARTBEAT_INTERVAL_MS);
    expect(gains).toHaveLength(1);
  });

  it('re-acquires after a throwing listener refused an earlier win', async () => {
    // The acquisition itself must not be rolled back or retried by the throw:
    // the listener runs after the record is already this window's.
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();
    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    lockB.onPrimacyGained(() => {
      throw new Error('subscriber exploded');
    });
    await lockB.tryAcquire();

    clock.advance(STALENESS_THRESHOLD_MS + 1_000);
    await lockB.tick();

    expect(store.getLock()!.ownerId).toBe('owner-B');
    expect(await lockB.hasPrimacy()).toBe(true);
  });
});

describe('WorkspaceLockManager.release', () => {
  it('clears the lock when held by this owner', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    await lock.tryAcquire();
    await lock.release();
    expect(store.getLock()).toBeNull();
  });

  it('does not clear a lock owned by another', async () => {
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();
    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    await lockB.release();
    expect(store.getLock()?.ownerId).toBe('owner-A');
  });

  it('stops the heartbeat when releasing', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    await lock.tryAcquire();
    expect(scheduler.intervals).toHaveLength(1);
    await lock.release();
    expect(scheduler.intervals).toHaveLength(0);
  });
});
