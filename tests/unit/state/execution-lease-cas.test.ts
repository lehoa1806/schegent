// Feature FR-R3-003 (T304) — interleaved per-queue lease acquisition.
//
// The same defect as primacy, with a different cardinality: the execution lease
// admits one holder *per queue* and several across queues, so the property under
// test is "exactly one winner per queue" rather than "exactly one winner". Both
// halves are asserted, because a mechanism that closed the race by serialising
// queues would pass the first and break concurrency outright.
//
// The other half of the acceptance criterion is what the loser does next: "the
// loser's drain treats the queue as owned elsewhere". A refusal — from
// contention, from a live holder, or from storage that cannot answer — reaches
// the drain as `acquired: false`, which is the one thing it needs to know.

import { beforeEach, describe, expect, it } from 'vitest';
import { ExecutionLeaseManager } from '../../../src/state/execution-lease';
import { STALENESS_THRESHOLD_MS } from '../../../src/state/lock';
import { queueResource } from '../../../src/state/ownership-registry';
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

function manager(host: Host, ownerId: string): ExecutionLeaseManager {
  return new ExecutionLeaseManager(host.store, ownerId, clock, scheduler);
}

describe('execution-lease acquisition is compare-and-swap (T304)', () => {
  it('elects exactly one winner per queue when two hosts interleave', async () => {
    const a = manager(hosts[0]!, 'window-a');
    const b = manager(hosts[1]!, 'window-b');

    let bResult: { acquired: boolean; ownerId: string } | null = null;
    interleaveOnce(fs, async () => {
      bResult = await b.tryAcquire('queue-b');
    });
    const aResult = await a.tryAcquire('queue-b');

    const results = [aResult, bResult!];
    expect(results.filter((result) => result.acquired)).toHaveLength(1);
    const winner = results.find((result) => result.acquired)!.ownerId;
    expect(results.find((result) => !result.acquired)!.ownerId).toBe(winner);
  });

  it('leaves the loser reading its own claim as absent', async () => {
    const a = manager(hosts[0]!, 'window-a');
    const b = manager(hosts[1]!, 'window-b');
    interleaveOnce(fs, async () => {
      await b.tryAcquire('queue-b');
    });
    await a.tryAcquire('queue-b');

    expect(a.isHeld('queue-b')).toBe(false);
    expect(await a.hasLease('queue-b')).toBe(false);
    expect(a.fenceOfRecord('queue-b')).toBeNull();
    expect(a.heldQueueIds()).toEqual([]);
    expect(b.isHeld('queue-b')).toBe(true);
    expect(await b.hasLease('queue-b')).toBe(true);
  });

  it('still lets two hosts hold different queues at the same time', async () => {
    // The cardinality rule that separates this lease from primacy. A fix that
    // made queue acquisition mutually exclusive would pass every race test above
    // and remove concurrency altogether.
    const a = manager(hosts[0]!, 'window-a');
    const b = manager(hosts[1]!, 'window-b');
    expect((await a.tryAcquire('queue-one')).acquired).toBe(true);
    expect((await b.tryAcquire('queue-two')).acquired).toBe(true);
    expect(await a.hasLease('queue-one')).toBe(true);
    expect(await b.hasLease('queue-two')).toBe(true);
    // …and neither can take the other's.
    expect((await a.tryAcquire('queue-two')).ownerId).toBe('window-b');
    expect((await b.tryAcquire('queue-one')).ownerId).toBe('window-a');
  });

  it('counts generations per queue, not per workspace', async () => {
    const a = manager(hosts[0]!, 'window-a');
    await a.tryAcquire('queue-one');
    await a.tryAcquire('queue-two');
    expect(a.fenceOfRecord('queue-one')).toBe(1);
    expect(a.fenceOfRecord('queue-two')).toBe(1);

    // Cycle queue-one three times. queue-two's counter must not move.
    for (let round = 0; round < 2; round += 1) {
      await a.release('queue-one');
      await a.tryAcquire('queue-one');
    }
    expect(a.fenceOfRecord('queue-one')).toBe(3);
    expect(a.fenceOfRecord('queue-two')).toBe(1);
  });

  it('reclaims a stale queue at the next generation and locks the predecessor out', async () => {
    const a = manager(hosts[0]!, 'window-a');
    await a.tryAcquire('queue-b');
    clock.advance(STALENESS_THRESHOLD_MS + 1);

    const b = manager(hosts[1]!, 'window-b');
    expect((await b.tryAcquire('queue-b')).acquired).toBe(true);
    expect(b.fenceOfRecord('queue-b')).toBe(2);
    // A still carries generation 1 and still believes it holds the queue. The
    // fenced check is what tells it otherwise.
    expect(a.fenceOfRecord('queue-b')).toBe(1);
    expect(await a.hasLease('queue-b')).toBe(false);
  });

  it('refuses rather than assumes when storage cannot answer', async () => {
    const a = manager(hosts[0]!, 'window-a');
    fs.faults.failList = true;
    const result = await a.tryAcquire('queue-b');
    expect(result.acquired).toBe(false);
    expect(a.fenceOfRecord('queue-b')).toBeNull();
    // The drain reads `acquired: false` as "another window has this queue", waits,
    // and tries again on the next sweep — the correct response to contention and
    // to unreadable storage alike.
    expect(await a.hasLease('queue-b')).toBe(false);
  });

  it('drops a reclaimed queue on the next beat and does not re-acquire it', async () => {
    const a = manager(hosts[0]!, 'window-a');
    await a.tryAcquire('queue-b');
    clock.advance(STALENESS_THRESHOLD_MS + 1);
    const b = manager(hosts[1]!, 'window-b');
    await b.tryAcquire('queue-b');

    await a.heartbeat();
    // Unlike primacy, a rejected execution beat stands down. A reclaimed queue is
    // being drained by another window, and the drain's step 6 is the only place
    // allowed to decide to contend for it.
    expect(a.fenceOfRecord('queue-b')).toBeNull();
    expect(await b.hasLease('queue-b')).toBe(true);
    expect((await hosts[1]!.store.ownership.read(queueResource('queue-b')))?.holder?.ownerId).toBe(
      'window-b'
    );
  });

  it('lets a second manager over one store release what the first claimed', async () => {
    // The production shape: `AutoDrainCoordinator` claims through one instance and
    // the controller's terminal transition releases through another, built over the
    // same store with the same owner id. Without the owner-of-record fallback the
    // release would find no fence and strand the queue until the 15 s reclaim.
    const drain = manager(hosts[0]!, 'window-a');
    const controller = manager(hosts[0]!, 'window-a');
    await drain.tryAcquire('queue-b');

    await controller.release('queue-b');
    expect(await drain.hasLease('queue-b')).toBe(false);
    const record = await hosts[0]!.store.ownership.read(queueResource('queue-b'));
    expect(record?.holder).toBeNull();
    // Released, not deleted: the generation it issued must never be re-issued.
    expect(record?.fence).toBe(1);

    const b = manager(hosts[1]!, 'window-b');
    expect((await b.tryAcquire('queue-b')).acquired).toBe(true);
    expect(b.fenceOfRecord('queue-b')).toBe(2);
  });

  it('gives back a claim whose mirror entry has already gone', async () => {
    const a = manager(hosts[0]!, 'window-a');
    await a.tryAcquire('queue-b');
    await hosts[0]!.store.setExecutionLease('queue-b', null);

    await a.releaseAll();
    const record = await hosts[0]!.store.ownership.read(queueResource('queue-b'));
    expect(record?.holder).toBeNull();
    expect(a.fenceOfRecord('queue-b')).toBeNull();
  });

  it('stops the heartbeat once no claim is left', async () => {
    const a = manager(hosts[0]!, 'window-a');
    await a.tryAcquire('queue-one');
    await a.tryAcquire('queue-two');
    expect(scheduler.intervals).toHaveLength(1);
    await a.release('queue-one');
    expect(scheduler.intervals).toHaveLength(1);
    await a.release('queue-two');
    expect(scheduler.intervals).toHaveLength(0);
  });
});
