// Feature FR-R3-003 (T303) — interleaved primacy acquisition elects one winner.
//
// The pre-feature `tryAcquire()` read `KEYS.lock`, compared heartbeats, and then
// wrote. Two hosts that reached the read before either reached the write both
// found nothing to lose to and both returned `acquired: true`, which is two
// windows each believing it may spawn the CLI against one working tree. These
// tests hold that interleaving open on purpose — `interleaveOnce` suspends the
// first host between its read and its write and drives the second host to
// completion inside the gap — so the race is produced rather than hoped for.
//
// Every assertion is about the *pair*: "exactly one acquired" is the property,
// and which one wins is not. A test that pinned the winner would be asserting an
// ordering the mechanism deliberately does not promise.

import { beforeEach, describe, expect, it } from 'vitest';
import { STALENESS_THRESHOLD_MS, WorkspaceLockManager } from '../../../src/state/lock';
import { PRIMACY_RESOURCE, queueResource } from '../../../src/state/ownership-registry';
import {
  createHosts,
  interleaveOnce,
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

function manager(host: Host, ownerId: string): WorkspaceLockManager {
  return new WorkspaceLockManager(host.store, ownerId, clock, scheduler);
}

describe('primacy acquisition is compare-and-swap (T303)', () => {
  it('elects exactly one winner when two hosts interleave on an unheld workspace', async () => {
    const a = manager(hosts[0]!, 'window-a');
    const b = manager(hosts[1]!, 'window-b');

    // Suspend A after it has read an empty directory. B runs to completion in
    // the gap, so A's create lands into a world it has already lost.
    let bResult: { acquired: boolean; ownerId: string } | null = null;
    interleaveOnce(fs, async () => {
      bResult = await b.tryAcquire();
    });
    const aResult = await a.tryAcquire();

    const results = [aResult, bResult!];
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    const winner = results.find((result) => result.acquired)!.ownerId;
    // The loser learns the *winner's* id, not its own: an operator told "another
    // window is primary" has to be told which one, and a loser that reported
    // itself would be indistinguishable from a success.
    expect(results.find((result) => !result.acquired)!.ownerId).toBe(winner);
  });

  it('leaves the loser unable to prove primacy, by either route', async () => {
    const a = manager(hosts[0]!, 'window-a');
    const b = manager(hosts[1]!, 'window-b');
    interleaveOnce(fs, async () => {
      await b.tryAcquire();
    });
    await a.tryAcquire();

    // A lost. Its synchronous mirror read and its awaited fenced check must
    // agree, because they are consulted from different call sites — the
    // projection path cannot await, the mutating-IPC gate does.
    expect(a.isHeld()).toBe(false);
    expect(await a.hasPrimacy()).toBe(false);
    expect(a.fenceOfRecord()).toBeNull();
    expect(b.isHeld()).toBe(true);
    expect(await b.hasPrimacy()).toBe(true);
  });

  it('issues the first token as generation 1 and does not start over on reclaim', async () => {
    const a = manager(hosts[0]!, 'window-a');
    expect((await a.tryAcquire()).acquired).toBe(true);
    expect(a.fenceOfRecord()).toBe(1);

    // A stalls past the staleness threshold and B reclaims. The token B is
    // issued must be strictly greater, or a revived A could not be told apart
    // from the current holder.
    clock.advance(STALENESS_THRESHOLD_MS + 1);
    const b = manager(hosts[1]!, 'window-b');
    expect((await b.tryAcquire()).acquired).toBe(true);
    expect(b.fenceOfRecord()).toBe(2);
    expect(await a.hasPrimacy()).toBe(false);
  });

  it('keeps the token when the same window re-acquires', async () => {
    const a = manager(hosts[0]!, 'window-a');
    await a.tryAcquire();
    const first = a.fenceOfRecord();
    clock.advance(1_000);
    const again = await a.tryAcquire();
    expect(again.acquired).toBe(true);
    // Nothing changed hands, so nothing should invalidate a token that guarded
    // writes are already carrying.
    expect(a.fenceOfRecord()).toBe(first);
  });

  it('refuses when a live foreign holder is present, without touching its record', async () => {
    const a = manager(hosts[0]!, 'window-a');
    await a.tryAcquire();
    clock.advance(STALENESS_THRESHOLD_MS - 1);

    const b = manager(hosts[1]!, 'window-b');
    const result = await b.tryAcquire();
    expect(result).toEqual({ acquired: false, ownerId: 'window-a' });
    expect(b.fenceOfRecord()).toBeNull();
    expect(await a.hasPrimacy()).toBe(true);
    expect(a.fenceOfRecord()).toBe(1);
  });

  it('refuses rather than assumes when storage cannot answer', async () => {
    const a = manager(hosts[0]!, 'window-a');
    fs.faults.failList = true;
    const result = await a.tryAcquire();
    // The rule is refuse to acquire, never assume acquired. A storage failure
    // that resolved to `acquired: true` would be two windows on one tree in the
    // one situation nobody is watching.
    expect(result.acquired).toBe(false);
    expect(a.fenceOfRecord()).toBeNull();
    expect(await a.hasPrimacy()).toBe(false);
  });

  it('refuses rather than retries forever when every generation is contended', async () => {
    const a = manager(hosts[0]!, 'window-a');
    fs.faults.alwaysContended = true;
    const result = await a.tryAcquire();
    expect(result.acquired).toBe(false);
    // Bounded: a caller that has lost every attempt waits for the next sweep
    // instead of spinning against something that wins every time.
    expect(fs.log.filter((entry) => entry.startsWith('create:')).length).toBeLessThan(20);
  });

  it('does not start the heartbeat for a window that did not acquire', async () => {
    const a = manager(hosts[0]!, 'window-a');
    await a.tryAcquire();
    expect(scheduler.intervals).toHaveLength(1);

    clock.advance(1);
    const b = manager(hosts[1]!, 'window-b');
    await b.tryAcquire();
    // Still one. A heartbeat armed by a losing window would refresh a mirror
    // entry it has no claim behind.
    expect(scheduler.intervals).toHaveLength(1);
  });

  it('keeps primacy and queue counters independent', async () => {
    const a = manager(hosts[0]!, 'window-a');
    await a.tryAcquire();
    // Claim two queues on the same host's registry. Primacy's generation must be
    // untouched: the two resources are two filename prefixes, so nothing has to
    // remember to keep their counters apart.
    for (const queueId of ['default', 'second']) {
      await hosts[0]!.store.ownership.acquire(
        queueResource(queueId),
        'window-a',
        clock.now(),
        STALENESS_THRESHOLD_MS
      );
    }
    expect(a.fenceOfRecord()).toBe(1);
    const primacy = await hosts[0]!.store.ownership.read(PRIMACY_RESOURCE);
    expect(primacy?.fence).toBe(1);
    for (const queueId of ['default', 'second']) {
      const record = await hosts[0]!.store.ownership.read(queueResource(queueId));
      expect(record?.fence).toBe(1);
    }
  });
});
