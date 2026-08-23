import { beforeEach, describe, expect, it } from 'vitest';
import { ExecutionLeaseManager } from '../../../src/state/execution-lease';
import {
  createHosts,
  ManualClock,
  ManualScheduler,
  SharedOwnershipFs,
  type Host
} from '../../fixtures/state/ownership-harness';
import type { OwnershipRegistry } from '../../../src/state/ownership-registry';
import type { ExecutionLease } from '../../../src/state/execution-lease';

/**
 * A Record lookup can miss, but `getExecutionLeases()` types its index as
 * non-optional (`noUncheckedIndexedAccess` is off repo-wide), so every
 * `=== undefined` and `?.` on the result reads to lint as dead code. Saying so in
 * one place is honest; sprinkling `eslint-disable` over the assertions is not.
 */
const leaseFor = (
  leases: Record<string, ExecutionLease>,
  queueId: string
): ExecutionLease | undefined =>
  (leases as Record<string, ExecutionLease | undefined>)[queueId];

/**
 * FR-R3-055 (H-06) — a delayed heartbeat can resurrect a released holder.
 *
 * `startHeartbeat` arms `setInterval(() => { void this.heartbeat(); })`, and
 * `release()` clears that interval but does not wait for a beat already in
 * flight. So a beat that passed its ownership check before the release, and
 * reaches `setExecutionLease` after it, writes this window back in as the
 * holder of a lease it has given up.
 *
 * Nothing here is left to timing. The ownership registry is wrapped so the
 * heartbeat's own call can be held open, the release run to completion, and the
 * beat then let go -- the exact interleaving, forced.
 */
let fs: SharedOwnershipFs;
let hosts: readonly Host[];
let clock: ManualClock;
let scheduler: ManualScheduler;

beforeEach(async () => {
  fs = new SharedOwnershipFs();
  hosts = await createHosts(1, fs);
  clock = new ManualClock();
  scheduler = new ManualScheduler();
});

interface Deferred {
  readonly hold: () => void;
  readonly release: () => void;
  readonly entered: () => boolean;
}

function wrap(host: Host): { store: Host['store']; deferred: Deferred } {
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  let didEnter = false;
  const real = host.store.ownership as OwnershipRegistry;
  const wrapped: OwnershipRegistry = {
    ...real,
    acquire: real.acquire.bind(real),
    verify: real.verify.bind(real),
    release: real.release.bind(real),
    heartbeat: async (...args: Parameters<OwnershipRegistry['heartbeat']>) => {
      const verdict = await real.heartbeat(...args);
      didEnter = true;
      if (gate) await gate;
      return verdict;
    }
  } as OwnershipRegistry;
  const store = Object.create(host.store) as Host['store'];
  Object.defineProperty(store, 'ownership', { get: () => wrapped });
  return {
    store,
    deferred: {
      hold: () => {
        gate = new Promise<void>((resolve) => {
          open = resolve;
        });
      },
      release: () => open?.(),
      entered: () => didEnter
    }
  };
}

describe('release drains in-flight heartbeat work (H-06)', () => {
  it('a heartbeat overlapping release cannot restore a released holder', async () => {
    const { store, deferred } = wrap(hosts[0]!);
    const manager = new ExecutionLeaseManager(store, 'window-a', clock, scheduler);

    expect((await manager.tryAcquire('queue-a')).acquired).toBe(true);

    // A beat is in flight, parked just past its ownership check.
    deferred.hold();
    const beat = manager.heartbeat();
    await spin(() => deferred.entered());

    // The release cannot COMPLETE while that beat is parked -- that is the drain.
    let releaseSettled = false;
    const release = manager.release('queue-a').then(() => {
      releaseSettled = true;
    });

    // Wait until the release has actually removed the record, THEN let the beat
    // go. Pinning that order is the whole test: released first, beat resumes
    // second. Without it the release's own delete can land AFTER the beat's
    // write and clean up the resurrection, so the test passes against source
    // that resurrects -- which is exactly what it did before this was pinned.
    await spin(() => leaseFor(store.getExecutionLeases(), 'queue-a') === undefined);
    expect(releaseSettled).toBe(false);

    deferred.release();
    await Promise.all([beat, release]);

    expect(releaseSettled).toBe(true);
    expect(leaseFor(store.getExecutionLeases(), 'queue-a')).toBeUndefined();
  });

  it('a beat with no release in play still refreshes the lease', async () => {
    // The epoch check must not turn every heartbeat into a no-op. Without this,
    // "the lease is never resurrected" would be satisfied by never writing at all,
    // and the holder would look stale to the next window inside 30 seconds.
    const { store } = wrap(hosts[0]!);
    const manager = new ExecutionLeaseManager(store, 'window-a', clock, scheduler);
    await manager.tryAcquire('queue-a');
    clock.advance(1_000);
    await manager.heartbeat();
    const lease = leaseFor(store.getExecutionLeases(), 'queue-a');
    expect(lease?.ownerId).toBe('window-a');
    expect(lease?.heartbeatAt).toBe(clock.now());
  });
});

/** Minimal poll: the harness has no fake timers, so a real macrotask spin is it. */
async function spin(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('condition never became true');
}
