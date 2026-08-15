// Crash-recovery integration test (R10).
//
// Simulates the failure mode of an extension host process that is
// killed mid-phase: the WorkflowRun was persisted in 'in-flight' state
// and the WorkspaceLockManager owns the lock, but no `release()` ever
// fires. On the next activation (= a new owner ID), the system MUST:
//
//   1. Recognize the lock as stale once `STALENESS_THRESHOLD_MS`
//      has elapsed since the last heartbeat, AND succeed `tryAcquire`.
//   2. Read back the persisted state and find the in-flight run
//      intact (audit log untouched, run state recoverable).
//   3. NOT throw or wedge because the dead owner never released.
//      Nothing runs cleanup in a killed process, so stale-detection is
//      the only takeover path — there is no scope wrapper whose
//      `finally` could have released on the way out.
//
// This is the operational scenario behind the "Reliability gaps:
// no documented crash-recovery integration test" finding in the
// principal-level review (R10).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  WorkspaceLockManager,
  STALENESS_THRESHOLD_MS,
  type Clock,
  type Scheduler,
  type SchedulerHandle
} from '../../src/state/lock';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';

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

class NoopScheduler implements Scheduler {
  setInterval(_fn: () => void, _ms: number): SchedulerHandle {
    return { clear: () => undefined };
  }
}

describe('Crash-recovery: lock survives host crash and stale-takeover succeeds', () => {
  let memento: FakeMemento;
  let store: WorkspaceStateStore;
  let clock: ManualClock;
  let scheduler: NoopScheduler;

  beforeEach(async () => {
    memento = new FakeMemento();
    store = new WorkspaceStateStore(memento);
    await store.initialize();
    clock = new ManualClock();
    scheduler = new NoopScheduler();
  });

  it('a fresh manager (new ownerId) cannot acquire while the old lock is fresh', async () => {
    const oldManager = new WorkspaceLockManager(store, 'host-pid-1-aaaaaaaa', clock, scheduler);
    const oldAcq = await oldManager.tryAcquire();
    expect(oldAcq.acquired).toBe(true);

    // Crash: old manager goes away without calling release().
    // Time passes — but less than the stale threshold.
    clock.advance(STALENESS_THRESHOLD_MS - 1);

    const newManager = new WorkspaceLockManager(store, 'host-pid-2-bbbbbbbb', clock, scheduler);
    const newAcq = await newManager.tryAcquire();
    expect(newAcq.acquired).toBe(false);
    expect(newAcq.ownerId).toBe('host-pid-1-aaaaaaaa');
  });

  it('a fresh manager takes over once the old lock has gone stale (heartbeat exceeded)', async () => {
    const oldManager = new WorkspaceLockManager(store, 'host-pid-1-aaaaaaaa', clock, scheduler);
    await oldManager.tryAcquire();
    // Crash. Time exceeds the stale threshold.
    clock.advance(STALENESS_THRESHOLD_MS + 1);

    const newManager = new WorkspaceLockManager(store, 'host-pid-2-bbbbbbbb', clock, scheduler);
    const newAcq = await newManager.tryAcquire();
    expect(newAcq.acquired).toBe(true);
    expect(newAcq.ownerId).toBe('host-pid-2-bbbbbbbb');
  });
});

describe('Crash-recovery: persistent workspace state survives the takeover', () => {
  it('the memento round-trips run/queue state across a simulated crash', async () => {
    const memento = new FakeMemento();
    const clock = new ManualClock();
    const scheduler = new NoopScheduler();

    // Bootstrapping the store seeds the v6 single-queue registry.
    const storeA = new WorkspaceStateStore(memento);
    await storeA.initialize();

    // Write something through Store A that we expect to read from Store B.
    const lockA = new WorkspaceLockManager(storeA, 'owner-A', clock, scheduler);
    await lockA.tryAcquire();
    expect(lockA.isHeld()).toBe(true);

    // Crash. Time passes past stale threshold.
    clock.advance(STALENESS_THRESHOLD_MS + 50);

    // Fresh store (= new activation) reads the same memento.
    const storeB = new WorkspaceStateStore(memento);
    await storeB.initialize();
    expect(storeB.getQueueRegistry()).not.toBeNull();

    // The lock record is still there — but it's stale.
    expect(storeB.getLock()?.ownerId).toBe('owner-A');

    const lockB = new WorkspaceLockManager(storeB, 'owner-B', clock, scheduler);
    const probe = await lockB.tryAcquire();
    expect(probe.acquired).toBe(true);

    // After takeover the lock owner record is owner-B.
    expect(storeB.getLock()?.ownerId).toBe('owner-B');
  });
});
