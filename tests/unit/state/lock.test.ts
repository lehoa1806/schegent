import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkspaceLockManager,
  HEARTBEAT_INTERVAL_MS,
  STALENESS_THRESHOLD_MS,
  type Clock,
  type Scheduler,
  type SchedulerHandle,
  type LockSession
} from '../../../src/state/lock';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { Memento } from '../../../src/state/workspace-state';
import { LockHeldError } from '../../../src/lib/errors';

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

describe('WorkspaceLockManager.withLock', () => {
  it('releases the lock after the body resolves without retain', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    const result = await lock.withLock('test-scope', async () => 'ok');
    expect(result).toBe('ok');
    expect(store.getLock()).toBeNull();
    expect(scheduler.intervals).toHaveLength(0);
  });

  it('retains the lock when session.retain() is called', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    await lock.withLock('test-scope', async (session) => {
      session.retain();
    });
    expect(store.getLock()?.ownerId).toBe('owner-1');
    expect(scheduler.intervals).toHaveLength(1);
  });

  it('releases the lock when body throws and retain was NOT called', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    await expect(
      lock.withLock('test-scope', async () => {
        throw new Error('synthetic-failure');
      })
    ).rejects.toThrow('synthetic-failure');
    expect(store.getLock()).toBeNull();
  });

  it('retains the lock when body throws AFTER calling retain()', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    await expect(
      lock.withLock('test-scope', async (session) => {
        session.retain();
        throw new Error('paused-then-failed');
      })
    ).rejects.toThrow('paused-then-failed');
    expect(store.getLock()?.ownerId).toBe('owner-1');
  });

  it('throws LockHeldError when another non-stale owner holds the lock', async () => {
    const lockA = new WorkspaceLockManager(store, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();
    const lockB = new WorkspaceLockManager(store, 'owner-B', clock, scheduler);
    let bodyRan = false;
    await expect(
      lockB.withLock('test-scope', async () => {
        bodyRan = true;
      })
    ).rejects.toBeInstanceOf(LockHeldError);
    expect(bodyRan).toBe(false);
    expect(store.getLock()?.ownerId).toBe('owner-A');
  });

  it('treats retain() as idempotent', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    await lock.withLock('test-scope', async (session) => {
      session.retain();
      session.retain();
      session.retain();
    });
    expect(store.getLock()?.ownerId).toBe('owner-1');
  });

  it('reuses an idempotent acquire when the same owner re-enters', async () => {
    const lock = new WorkspaceLockManager(store, 'owner-1', clock, scheduler);
    await lock.tryAcquire();
    const acquiredAtBefore = store.getLock()!.acquiredAt;
    clock.advance(1_500);
    await lock.withLock('test-scope', async (session) => {
      session.retain();
    });
    // tryAcquire inside withLock should renew without resetting acquiredAt
    expect(store.getLock()?.acquiredAt).toBe(acquiredAtBefore);
  });

  // Fuzz-style: enumerate synthetic errors that simulate every distinct exit
  // branch in `WorkflowController.driveRun()` — terminal paths (failed,
  // completed, cancelled, unexpected break) must release; pause paths
  // (breakpoint, delayed-retry, rate-limit, verify-pause, manual-pause)
  // must retain. The wrapper has no per-branch logic: it routes on whether
  // the body called `session.retain()`. This test enumerates the matrix.
  type Branch = {
    label: string;
    behavior: 'throws' | 'returns';
    retain: boolean;
    expectReleased: boolean;
  };
  const BRANCHES: Branch[] = [
    // Terminal release paths
    { label: 'terminal-failed-throws', behavior: 'throws', retain: false, expectReleased: true },
    { label: 'terminal-failed-returns', behavior: 'returns', retain: false, expectReleased: true },
    { label: 'terminal-completed', behavior: 'returns', retain: false, expectReleased: true },
    { label: 'terminal-cancelled-throws', behavior: 'throws', retain: false, expectReleased: true },
    { label: 'unexpected-break', behavior: 'throws', retain: false, expectReleased: true },
    // Pause retain paths
    { label: 'pause-breakpoint', behavior: 'returns', retain: true, expectReleased: false },
    { label: 'pause-delayed-retry', behavior: 'returns', retain: true, expectReleased: false },
    { label: 'pause-rate-limit', behavior: 'returns', retain: true, expectReleased: false },
    { label: 'pause-verify-non-clean', behavior: 'returns', retain: true, expectReleased: false },
    { label: 'pause-manual-mid-flight', behavior: 'returns', retain: true, expectReleased: false },
    // Pause-then-throw paths (controller still retains even if body raises)
    {
      label: 'pause-then-throws-cleanup-error',
      behavior: 'throws',
      retain: true,
      expectReleased: false
    }
  ];

  for (const branch of BRANCHES) {
    it(`fuzz: ${branch.label} ${branch.behavior} retain=${branch.retain} → released=${branch.expectReleased}`, async () => {
      const ownerId = `owner-${branch.label}`;
      const lock = new WorkspaceLockManager(store, ownerId, clock, scheduler);
      const body = async (session: LockSession): Promise<string> => {
        if (branch.retain) session.retain();
        if (branch.behavior === 'throws') throw new Error(`synthetic:${branch.label}`);
        return 'ok';
      };
      const invocation = lock.withLock(branch.label, body);
      if (branch.behavior === 'throws') {
        await expect(invocation).rejects.toThrow(`synthetic:${branch.label}`);
      } else {
        await expect(invocation).resolves.toBe('ok');
      }
      const persisted = store.getLock();
      if (branch.expectReleased) {
        expect(persisted, `${branch.label} expected lock release`).toBeNull();
      } else {
        expect(persisted?.ownerId, `${branch.label} expected retain`).toBe(ownerId);
      }
      // Always clean up so the next iteration starts from a known state.
      if (!branch.expectReleased) await lock.release();
    });
  }
});
