// FR-R3-024 (FR-015, SC-003) — the ordering invariant that makes the advisory
// mirror safe to read at all.
//
// `WorkspaceLockManager` splits its predicates by purpose: `hasPrimacy()` awaits
// the fenced ownership record and is authoritative; `isHeld()` reads the
// `KEYS.lock` Memento mirror synchronously and is advisory, for projection paths
// that cannot await. FR-R3-024 moved every *decision* onto the authoritative
// side, but `isForeignLockHeld()` still reads the mirror on a genuine projection
// path, so the mirror still has to be trustworthy.
//
// What makes it trustworthy is an ordering, in two halves:
//
//   1. `writeGuarded` refreshes the ownership record BEFORE it runs the mirror
//      write, so the mirror can never be fresher than the record it mirrors.
//   2. A refused or unanswerable refresh returns BEFORE the mirror write, so a
//      beat that lost the resource cannot leave a fresh mirror entry behind it.
//
// Together with the reclaim rule and `isHeld()`'s freshness check sharing one
// `STALENESS_THRESHOLD_MS`, those two give `mirror.heartbeatAt <=
// record.heartbeatAt` always — so whenever a rival may reclaim, the mirror is
// already stale. `isHeld()` can therefore be falsely negative and never falsely
// positive.
//
// That guarantee was emergent: a property of statement order in two functions in
// two modules, required by no comment and asserted by no test. Moving the mirror
// write above the refresh looks like a harmless reordering and silently
// introduces a real race. These tests make the reordering fail.

import { beforeEach, describe, expect, it } from 'vitest';
import { STALENESS_THRESHOLD_MS, WorkspaceLockManager } from '../../../src/state/lock';
import {
  createHosts,
  ManualClock,
  ManualScheduler,
  SharedOwnershipFs,
  type Host
} from '../../fixtures/state/ownership-harness';

let fs: SharedOwnershipFs;
let hosts: readonly Host[];
let clock: ManualClock;
let scheduler: ManualScheduler;

beforeEach(async () => {
  fs = new SharedOwnershipFs();
  hosts = await createHosts(2, fs);
  clock = new ManualClock();
  scheduler = new ManualScheduler();
});

/**
 * Records the order in which a host's ownership refresh and mirror write run,
 * by wrapping both and delegating. The wrappers observe; they change nothing.
 *
 * FR-R3-077 (T1041) — the mirror half is now observed at the memento update for
 * the lock key rather than at `setLock`. `writeGuarded` used to verify and then
 * await a caller's callback, and that callback was `setLock`; the replacement
 * performs the write inside the serialized link itself, which is the whole
 * point of the change. Probing the storage write is also the more faithful
 * observation: it cannot be satisfied by a method that no longer writes.
 */
function traceOrder(host: Host): string[] {
  const calls: string[] = [];
  const registry = host.store.ownership as unknown as {
    heartbeat: (...args: unknown[]) => Promise<unknown>;
  };
  const store = host.store as unknown as {
    memento: { update: (key: string, value: unknown) => Promise<void> };
  };
  const realHeartbeat = registry.heartbeat.bind(registry);
  const realUpdate = store.memento.update.bind(store.memento);
  registry.heartbeat = async (...args: unknown[]) => {
    calls.push('record-refresh');
    return realHeartbeat(...args);
  };
  store.memento.update = async (key: string, value: unknown) => {
    if (key === 'schegent.lock') calls.push('mirror-write');
    return realUpdate(key, value);
  };
  return calls;
}

describe('the mirror-write ordering invariant (FR-R3-024 FR-015)', () => {
  it('refreshes the ownership record before writing the advisory mirror', async () => {
    const lock = new WorkspaceLockManager(hosts[0]!.store, 'window-a', clock, scheduler);
    expect((await lock.tryAcquire()).acquired).toBe(true);

    const calls = traceOrder(hosts[0]!);
    clock.advance(1_000);
    await lock.heartbeat();

    // Both halves ran, and the refresh came first. Hoisting the mirror write
    // above the refresh flips this array.
    expect(calls).toEqual(['record-refresh', 'mirror-write']);
  });

  it('does not write the mirror when the refresh is refused', async () => {
    const lockA = new WorkspaceLockManager(hosts[0]!.store, 'window-a', clock, scheduler);
    expect((await lockA.tryAcquire()).acquired).toBe(true);
    const mirrorBefore = hosts[0]!.store.getLock();
    expect(mirrorBefore?.ownerId).toBe('window-a');

    // A stalls past the threshold and B reclaims, so A's fence is superseded.
    clock.advance(STALENESS_THRESHOLD_MS + 1);
    const lockB = new WorkspaceLockManager(hosts[1]!.store, 'window-b', clock, scheduler);
    expect((await lockB.tryAcquire()).acquired).toBe(true);

    // A resumes and beats. From the inside nothing happened.
    const calls = traceOrder(hosts[0]!);
    const beatAt = clock.now();
    await lockA.heartbeat();

    // The refresh ran and was refused; no mirror write followed it. Deleting
    // the short-circuit in `writeGuarded` lands a mirror write here, stamped
    // with `beatAt`, and every synchronous reader would then see a fresh entry
    // for a window that no longer holds the resource.
    expect(calls).toContain('record-refresh');
    expect(calls).not.toContain('mirror-write');
    const mirrorAfter = hosts[0]!.store.getLock();
    expect(mirrorAfter?.heartbeatAt).not.toBe(beatAt);
    expect(mirrorAfter?.heartbeatAt).toBe(mirrorBefore?.heartbeatAt);
  });

  it('leaves the advisory predicate reading false for the superseded holder', async () => {
    const lockA = new WorkspaceLockManager(hosts[0]!.store, 'window-a', clock, scheduler);
    await lockA.tryAcquire();
    clock.advance(STALENESS_THRESHOLD_MS + 1);
    const lockB = new WorkspaceLockManager(hosts[1]!.store, 'window-b', clock, scheduler);
    await lockB.tryAcquire();
    await lockA.heartbeat();

    // The conservative direction: falsely negative is allowed, falsely positive
    // is not. Both predicates agree here, which is the point — the advisory one
    // cannot lead the authoritative one.
    expect(lockA.isHeld()).toBe(false);
    expect(await lockA.hasPrimacy()).toBe(false);
    expect(await lockB.hasPrimacy()).toBe(true);
  });
});
