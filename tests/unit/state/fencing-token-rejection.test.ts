// Feature FR-R3-003 (T305) — the revived stale holder cannot act.
//
// This is the half a compare-and-swap alone does not close. A host stalls past
// the 15 s threshold, a rival reclaims, and then the first host resumes still
// believing it holds the resource — because from the inside nothing happened. It
// will act on that belief. Without a fencing token its writes are merely *late*,
// and late writes land: the record says one thing and the working tree gets
// another.
//
// The token is issued at acquisition, carried by the holder, and checked at the
// point of effect, so the revived host's write is rejected. `writeGuarded` is
// where that check lives, and these tests are about its typed outcome rather than
// about a boolean: a caller told "you are not the holder" has to know *which*
// generation superseded it and *who* holds the resource now, or it cannot tell a
// reclaim apart from a storage hiccup and will surrender a claim it still has.

import { beforeEach, describe, expect, it } from 'vitest';
import { ExecutionLeaseManager } from '../../../src/state/execution-lease';
import { STALENESS_THRESHOLD_MS, WorkspaceLockManager } from '../../../src/state/lock';
import { PRIMACY_RESOURCE, queueResource } from '../../../src/state/ownership-registry';
import type { OwnershipClaim } from '../../../src/state/workspace-state';
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

function lockManager(host: Host, ownerId: string): WorkspaceLockManager {
  return new WorkspaceLockManager(host.store, ownerId, clock, scheduler);
}

function leaseManager(host: Host, ownerId: string): ExecutionLeaseManager {
  return new ExecutionLeaseManager(host.store, ownerId, clock, scheduler);
}

function primacyClaim(ownerId: string, fence: number): OwnershipClaim {
  return { resource: PRIMACY_RESOURCE, ownerId, fence };
}

/** Drive a resource from unheld to "A stalled, B reclaimed", and hand back A's token. */
async function reclaimedFromUnder(
  resource: string
): Promise<{ readonly staleFence: number; readonly currentFence: number }> {
  const a = await hosts[0]!.store.ownership.acquire(
    resource,
    'window-a',
    clock.now(),
    STALENESS_THRESHOLD_MS
  );
  expect(a.outcome).toBe('acquired');
  clock.advance(STALENESS_THRESHOLD_MS + 1);
  const b = await hosts[1]!.store.ownership.acquire(
    resource,
    'window-b',
    clock.now(),
    STALENESS_THRESHOLD_MS
  );
  expect(b.outcome).toBe('acquired');
  return {
    staleFence: a.outcome === 'acquired' ? a.fence : -1,
    currentFence: b.outcome === 'acquired' ? b.fence : -1
  };
}

describe('a guarded write from a revived stale holder is rejected (T305)', () => {
  it('rejects on the token, naming the generation and the owner of record', async () => {
    const { staleFence, currentFence } = await reclaimedFromUnder(PRIMACY_RESOURCE);
    let ran = false;
    const outcome = await hosts[0]!.store.writeGuarded(
      primacyClaim('window-a', staleFence),
      async () => {
        ran = true;
      }
    );
    expect(outcome).toEqual({
      outcome: 'rejected',
      reason: 'stale-fence',
      currentFence,
      ownerOfRecord: 'window-b'
    });
    // Rejected, not merely reported: the write must not have happened.
    expect(ran).toBe(false);
  });

  it('performs the write for the holder of the current generation', async () => {
    const { currentFence } = await reclaimedFromUnder(PRIMACY_RESOURCE);
    let ran = false;
    const outcome = await hosts[1]!.store.writeGuarded(
      primacyClaim('window-b', currentFence),
      async () => {
        ran = true;
      }
    );
    expect(outcome).toEqual({ outcome: 'written' });
    expect(ran).toBe(true);
  });

  it('distinguishes a released generation from a superseded one', async () => {
    const acquired = await hosts[0]!.store.ownership.acquire(
      PRIMACY_RESOURCE,
      'window-a',
      clock.now(),
      STALENESS_THRESHOLD_MS
    );
    const fence = acquired.outcome === 'acquired' ? acquired.fence : -1;
    await hosts[0]!.store.ownership.release(PRIMACY_RESOURCE, 'window-a', fence);

    let ran = false;
    const outcome = await hosts[0]!.store.writeGuarded(
      primacyClaim('window-a', fence),
      async () => {
        ran = true;
      }
    );
    // The generation is still current — release keeps the record so the token is
    // never re-issued — but the holder slot is empty. `not-holder` is a different
    // fact from `stale-fence` and a caller may reasonably act differently on it.
    expect(outcome).toEqual({
      outcome: 'rejected',
      reason: 'not-holder',
      currentFence: fence,
      ownerOfRecord: null
    });
    expect(ran).toBe(false);
  });

  it('reports unavailable, not rejected, when storage cannot answer', async () => {
    const { staleFence } = await reclaimedFromUnder(PRIMACY_RESOURCE);
    fs.faults.failList = true;
    let ran = false;
    const outcome = await hosts[0]!.store.writeGuarded(
      primacyClaim('window-a', staleFence),
      async () => {
        ran = true;
      }
    );
    // A caller that conflated the two would surrender a live claim on a failed
    // read. The write still does not happen — that half is the same.
    expect(outcome).toEqual({ outcome: 'unavailable' });
    expect(ran).toBe(false);
  });

  it('reports unavailable when the claim was good and the write failed', async () => {
    const acquired = await hosts[0]!.store.ownership.acquire(
      PRIMACY_RESOURCE,
      'window-a',
      clock.now(),
      STALENESS_THRESHOLD_MS
    );
    const fence = acquired.outcome === 'acquired' ? acquired.fence : -1;
    const outcome = await hosts[0]!.store.writeGuarded(primacyClaim('window-a', fence), () =>
      Promise.reject(new Error('memento write failed'))
    );
    // It says nothing about who holds the resource, so it must not read as a lost
    // claim.
    expect(outcome).toEqual({ outcome: 'unavailable' });
    expect(await hosts[0]!.store.verifyClaim(primacyClaim('window-a', fence))).toEqual({
      outcome: 'valid',
      fence
    });
  });

  it('gives verifyClaim the same verdicts without performing a write', async () => {
    const { staleFence, currentFence } = await reclaimedFromUnder(PRIMACY_RESOURCE);
    expect(await hosts[0]!.store.verifyClaim(primacyClaim('window-a', staleFence))).toEqual({
      outcome: 'rejected',
      reason: 'stale-fence',
      currentFence,
      ownerOfRecord: 'window-b'
    });
    expect(await hosts[1]!.store.verifyClaim(primacyClaim('window-b', currentFence))).toEqual({
      outcome: 'valid',
      fence: currentFence
    });
  });
});

describe('the revived holder observes that it is no longer the holder (T305)', () => {
  it('re-acquires on a rejected primacy beat and never releases', async () => {
    const a = lockManager(hosts[0]!, 'window-a');
    await a.tryAcquire();
    clock.advance(STALENESS_THRESHOLD_MS + 1);
    const b = lockManager(hosts[1]!, 'window-b');
    await b.tryAcquire();

    await a.heartbeat();
    // A tried to re-earn primacy and was refused, because B holds it and B's beat
    // is fresh. What must NOT have happened is a release: primacy's tenure is
    // activation-to-disposal, and a beat is not the end of it. B is untouched.
    expect(await a.hasPrimacy()).toBe(false);
    expect(await b.hasPrimacy()).toBe(true);
    const record = await hosts[1]!.store.ownership.read(PRIMACY_RESOURCE);
    expect(record?.holder?.ownerId).toBe('window-b');
  });

  it('does not leave a fresh mirror entry behind a rejected beat', async () => {
    const a = lockManager(hosts[0]!, 'window-a');
    await a.tryAcquire();
    const before = hosts[0]!.memento.get<{ heartbeatAt: number }>('schegent.lock');
    expect(before).toBeDefined();

    clock.advance(STALENESS_THRESHOLD_MS + 1);
    await lockManager(hosts[1]!, 'window-b').tryAcquire();
    await a.heartbeat();

    // The mirror is what every synchronous reader trusts, so a beat that lost the
    // resource must not refresh it. `isHeld()` reads false through both gates:
    // the fence is gone and the mirror is stale.
    const after = hosts[0]!.memento.get<{ heartbeatAt: number }>('schegent.lock');
    expect(after?.heartbeatAt).toBe(before!.heartbeatAt);
    expect(a.isHeld()).toBe(false);
  });

  it('becomes primary again at a new generation once the rival goes quiet', async () => {
    const a = lockManager(hosts[0]!, 'window-a');
    await a.tryAcquire();
    clock.advance(STALENESS_THRESHOLD_MS + 1);
    await lockManager(hosts[1]!, 'window-b').tryAcquire();

    // B now stalls in turn. A's next beat re-acquires rather than giving up for
    // good, which is the whole reason a rejected beat does not release.
    clock.advance(STALENESS_THRESHOLD_MS + 1);
    await a.heartbeat();
    expect(await a.hasPrimacy()).toBe(true);
    expect(a.fenceOfRecord()).toBe(3);
  });

  it('locks a revived execution-lease holder out of its queue', async () => {
    const a = leaseManager(hosts[0]!, 'window-a');
    await a.tryAcquire('queue-b');
    const staleFence = a.fenceOfRecord('queue-b')!;
    clock.advance(STALENESS_THRESHOLD_MS + 1);
    const b = leaseManager(hosts[1]!, 'window-b');
    await b.tryAcquire('queue-b');

    // A revives. It still carries generation 1 and still reads its own mirror as
    // its own — and it cannot prove the claim, so the drain will not admit a Run
    // on it.
    expect(a.fenceOfRecord('queue-b')).toBe(staleFence);
    expect(await a.hasLease('queue-b')).toBe(false);
    const outcome = await hosts[0]!.store.writeGuarded(
      { resource: queueResource('queue-b'), ownerId: 'window-a', fence: staleFence },
      async () => undefined
    );
    expect(outcome.outcome).toBe('rejected');
  });

  it('keeps tokens strictly increasing across a long reclaim sequence', async () => {
    const seen: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const owner = round % 2 === 0 ? 'window-a' : 'window-b';
      const host = hosts[round % 2]!;
      const outcome = await host.store.ownership.acquire(
        PRIMACY_RESOURCE,
        owner,
        clock.now(),
        STALENESS_THRESHOLD_MS
      );
      expect(outcome.outcome).toBe('acquired');
      if (outcome.outcome === 'acquired') seen.push(outcome.fence);
      clock.advance(STALENESS_THRESHOLD_MS + 1);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    // And every superseded token is refused, not just the most recent one.
    for (const fence of seen.slice(0, -1)) {
      const verdict = await hosts[0]!.store.verifyClaim(primacyClaim('window-a', fence));
      expect(verdict.outcome).toBe('rejected');
    }
  });
});
