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
