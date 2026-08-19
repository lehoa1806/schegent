// Feature FR-R3-003 (T293) — what `Memento` actually provides, measured rather
// than assumed.
//
// The requirement names this an explicit unknown: "VS Code does not document
// cross-process ordering or atomicity guarantees for `Memento.update`. The design
// must not be built on an assumption about it." This file is the measurement, and
// it is deliberately a *negative* result: it demonstrates the two properties a
// lease acquisition would need and shows the surface cannot supply either.
//
// What this file can and cannot establish, stated plainly:
//
//   - It CAN establish what the `Memento` **surface** offers, because the
//     interface is the whole contract: `get` and `update`, no conditional write,
//     no revision, no compare-and-swap. A mechanism that needs one has nothing to
//     call. That is a property of the API, not of a version, so no VS Code build
//     can change it without changing the interface.
//   - It CAN establish that `WorkspaceStateStore.serialize()` orders writes within
//     one store instance and not across two, because the chain map is held on the
//     instance. Two instances are the in-process stand-in for two extension hosts.
//   - It CANNOT establish cross-*process* visibility either way. Two OS processes
//     cannot be created inside a vitest worker, and VS Code's own storage is a
//     per-host SQLite-backed cache that this suite has no handle on. An
//     experiment that reported "it worked on my machine" would be evidence about
//     one build's caching behaviour and not about a guarantee — which is exactly
//     the assumption the finding warns against.
//
// The conclusion the design takes from this is recorded in
// `docs/architecture/workspace-ownership-fencing.md`: because the guarantee
// cannot be established, ownership is not built on it. Acquisition goes through
// an on-disk fenced artifact under `.schegent/`, and `KEYS.lock` /
// `KEYS.executionLeases` survive only as advisory per-host mirrors.

import { describe, expect, it } from 'vitest';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { WorkspaceLockManager, type Clock, type Scheduler, type SchedulerHandle } from '../../../src/state/lock';

/**
 * A `Memento` that records the order in which operations landed and can be told
 * to defer its writes, which is how an interleaving is produced deterministically.
 */
class RecordingMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  public readonly log: string[] = [];
  private pending: Array<() => void> = [];
  public deferWrites = false;

  get<T>(key: string): T | undefined {
    this.log.push(`get:${key}`);
    return this.map.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.log.push(`update:${key}`);
    const apply = () => {
      if (value === undefined) this.map.delete(key);
      else this.map.set(key, value);
    };
    if (!this.deferWrites) {
      apply();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pending.push(() => {
        apply();
        resolve();
      });
    });
  }

  /** Let every deferred write land, in the order it was issued. */
  flush(): void {
    const queued = this.pending;
    this.pending = [];
    for (const apply of queued) apply();
  }
}

class FixedClock implements Clock {
  constructor(private t = 1_000_000) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

class NoopScheduler implements Scheduler {
  setInterval(): SchedulerHandle {
    return { clear: () => undefined };
  }
}

/**
 * Let every already-queued microtask run. `serialize()` issues its operation
 * from a `.then()`, so even the head of a chain reaches the `Memento` a turn
 * after the call — the assertions below are about which writes have been *issued*
 * once the queue drains, not about what happened synchronously.
 */
const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

describe('Memento ordering probe (T293)', () => {
  it('offers no conditional write, so there is no compare-and-swap to call', () => {
    const memento: Memento = new RecordingMemento();
    // The whole surface. Anything a lease acquisition could use to make its write
    // conditional on what it read would have to appear here.
    const surface = new Set<string>();
    for (const key of ['get', 'update', 'keys', 'setKeysForSync']) {
      if (typeof (memento as unknown as Record<string, unknown>)[key] === 'function') {
        surface.add(key);
      }
    }
    expect([...surface].sort()).toEqual(['get', 'update']);
    // `update` takes a key and a value. It does not take an expected prior value,
    // a revision, or a predicate, and it does not return the prior value — so a
    // caller cannot learn whether it raced.
    expect(memento.update.length).toBe(2);
  });

  it('serializes writes within one store instance', async () => {
    const memento = new RecordingMemento();
    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    memento.log.length = 0;
    memento.deferWrites = true;

    const first = store.setLock({ ownerId: 'a', acquiredAt: 1, heartbeatAt: 1 });
    const second = store.setLock({ ownerId: 'b', acquiredAt: 2, heartbeatAt: 2 });
    await settle();
    // The chain has not let the second write issue yet: one `update` so far.
    expect(memento.log.filter((entry) => entry === 'update:schegent.lock')).toHaveLength(1);
    memento.flush();
    await first;
    await settle();
    memento.flush();
    await second;
    expect(store.getLock()?.ownerId).toBe('b');
  });

  it('orders nothing between two store instances over one Memento', async () => {
    // Two instances stand in for two extension hosts: `serialize()` keeps its
    // chain map on the store object, so there is no shared queue to join.
    const memento = new RecordingMemento();
    const hostA = new WorkspaceStateStore(memento);
    const hostB = new WorkspaceStateStore(memento);
    await hostA.initialize();
    await hostB.initialize();
    memento.log.length = 0;
    memento.deferWrites = true;

    const a = hostA.setLock({ ownerId: 'a', acquiredAt: 1, heartbeatAt: 1 });
    const b = hostB.setLock({ ownerId: 'b', acquiredAt: 2, heartbeatAt: 2 });
    await settle();
    // Both writes issued before either landed. Inside one host the second would
    // still be queued; across two, they interleave.
    expect(memento.log.filter((entry) => entry === 'update:schegent.lock')).toHaveLength(2);
    memento.flush();
    await Promise.all([a, b]);
  });

  it('is the defect: read-check-write over a Memento elects two winners', async () => {
    // The pre-feature acquisition, reproduced against the surface it ran on. Both
    // hosts read an empty lock, both find nothing to lose to, and both write.
    const memento = new RecordingMemento();
    const clock = new FixedClock();
    const readCheckWrite = async (ownerId: string): Promise<boolean> => {
      const existing = memento.get<{ ownerId: string; heartbeatAt: number }>('probe.lock');
      if (existing && existing.ownerId !== ownerId) return false;
      await memento.update('probe.lock', {
        ownerId,
        acquiredAt: clock.now(),
        heartbeatAt: clock.now()
      });
      return true;
    };
    memento.deferWrites = true;
    const both = Promise.all([readCheckWrite('host-a'), readCheckWrite('host-b')]);
    memento.flush();
    expect(await both).toEqual([true, true]);
  });

  it('and the fenced registry elects one, over the same Memento', async () => {
    // The same two hosts, arbitrating through the mechanism this feature adds.
    // The store instances are still separate — nothing about the interleaving
    // changed — and the outcome is now exactly one winner.
    const memento = new RecordingMemento();
    const clock = new FixedClock();
    const scheduler = new NoopScheduler();
    const hostA = new WorkspaceStateStore(memento);
    const hostB = new WorkspaceStateStore(memento);
    await hostA.initialize();
    await hostB.initialize();

    const results = await Promise.all([
      new WorkspaceLockManager(hostA, 'host-a', clock, scheduler).tryAcquire(),
      new WorkspaceLockManager(hostB, 'host-b', clock, scheduler).tryAcquire()
    ]);
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
    const winner = results.find((r) => r.acquired)!.ownerId;
    expect(results.filter((r) => !r.acquired)[0].ownerId).toBe(winner);
  });
});
