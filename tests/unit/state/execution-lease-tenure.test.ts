// FR-R4-F01 (spec 239, US1, T007) — a rejected or superseded claim stays LOST.
//
// Before this feature `ExecutionLeaseManager` answered a rejected heartbeat by
// deleting the queue's fence, so `claimFor` returned null, `runCommitClaim` fell
// back to `unfencedCommit('lease-not-held')`, and the loser's next write was
// accepted with no check at all. These cases pin the replacement
// (data-model §1, contract C1 G1 to G4): the manager remembers the tenure it
// lost, hands the OLD generation to the commit point, and tells its listeners
// once.
//
// Every doubled seam is one the production class already takes: the `Clock`,
// the `Scheduler` and the `OwnershipFs`. No real time passes and nothing is on
// disk.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionLeaseManager, type ExecutionLease } from '../../../src/state/execution-lease';
import { STALENESS_THRESHOLD_MS, WorkspaceLockManager } from '../../../src/state/lock';
import { OwnershipRegistry, queueResource } from '../../../src/state/ownership-registry';
import {
  ManualClock,
  ManualScheduler,
  OWNERSHIP_DIR,
  SharedOwnershipFs
} from '../../fixtures/state/ownership-harness';

/** The narrow store surface the manager needs, over one shared registry. */
class TenureStore {
  private leases: Record<string, ExecutionLease> = {};
  public readonly ownership: OwnershipRegistry;
  constructor(public readonly fs: SharedOwnershipFs) {
    this.ownership = new OwnershipRegistry(fs, OWNERSHIP_DIR);
  }
  getExecutionLeases(): Record<string, ExecutionLease> {
    return this.leases;
  }
  async setExecutionLease(queueId: string, lease: ExecutionLease | null): Promise<void> {
    const next = { ...this.leases };
    if (lease === null) delete next[queueId];
    else next[queueId] = lease;
    this.leases = next;
  }
}

let fs: SharedOwnershipFs;
let store: TenureStore;
let clock: ManualClock;
let scheduler: ManualScheduler;

function manager(ownerId: string): ExecutionLeaseManager {
  return new ExecutionLeaseManager(store, ownerId, clock, scheduler);
}

/** A holds `queueId`, goes stale, and B reclaims it. A has not noticed yet. */
async function reclaimedByRival(
  a: ExecutionLeaseManager,
  b: ExecutionLeaseManager,
  queueId: string
): Promise<number> {
  expect((await a.tryAcquire(queueId)).acquired).toBe(true);
  const fence = a.fenceOfRecord(queueId)!;
  clock.advance(STALENESS_THRESHOLD_MS + 1);
  expect((await b.tryAcquire(queueId)).acquired).toBe(true);
  return fence;
}

beforeEach(() => {
  fs = new SharedOwnershipFs();
  store = new TenureStore(fs);
  clock = new ManualClock();
  scheduler = new ManualScheduler();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('claim tenure (data-model §1, C1 G1)', () => {
  it('reports never-held for a queue this window has not touched', () => {
    expect(manager('window-a').tenureOf('q')).toEqual({ state: 'never-held' });
  });

  it('reports held with the live claim after an acquisition', async () => {
    const a = manager('window-a');
    await a.tryAcquire('q');
    expect(a.tenureOf('q')).toEqual({
      state: 'held',
      claim: { resource: queueResource('q'), ownerId: 'window-a', fence: a.fenceOfRecord('q')! }
    });
  });

  it('a rejected beat moves the queue to lost and keeps the old generation', async () => {
    const a = manager('window-a');
    const b = manager('window-b');
    const oldFence = await reclaimedByRival(a, b, 'q');

    await a.heartbeat();

    const tenure = a.tenureOf('q');
    expect(tenure.state).toBe('lost');
    if (tenure.state !== 'lost') throw new Error('unreachable');
    expect(tenure.reason).toBe('rejected');
    expect(tenure.claim).toEqual({
      resource: queueResource('q'),
      ownerId: 'window-a',
      fence: oldFence
    });
    expect(tenure.lostAt).toBe(clock.now());
    // The commit point is handed the generation the loser was issued, which is
    // what gets it refused. A claim rebuilt from the record would launder it.
    expect(a.claimFor('q')).toEqual({
      resource: queueResource('q'),
      ownerId: 'window-a',
      fence: oldFence
    });
  });

  it('an unavailable beat leaves the queue held with its fence (FR-005)', async () => {
    const a = manager('window-a');
    await a.tryAcquire('q');
    const fence = a.fenceOfRecord('q');
    const lost = vi.fn();
    a.onClaimLost(lost);

    fs.faults.failList = true;
    await a.heartbeat();
    fs.faults.failList = false;

    expect(a.tenureOf('q').state).toBe('held');
    expect(a.claimFor('q')?.fence).toBe(fence);
    expect(lost).not.toHaveBeenCalled();
  });

  it('does not beat a lost queue again', async () => {
    const a = manager('window-a');
    const b = manager('window-b');
    await reclaimedByRival(a, b, 'q');
    await a.heartbeat();

    const beat = vi.spyOn(store.ownership, 'heartbeat');
    await a.heartbeat();
    await a.heartbeat();

    const beatsForQueue = beat.mock.calls.filter(([resource]) => resource === queueResource('q'));
    expect(beatsForQueue).toHaveLength(0);
  });
});

describe('onClaimLost (C1 G2)', () => {
  it('fires exactly once per transition into lost, with the reason', async () => {
    const a = manager('window-a');
    const b = manager('window-b');
    const listener = vi.fn();
    a.onClaimLost(listener);
    await reclaimedByRival(a, b, 'q');

    await a.heartbeat();
    await a.heartbeat();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('q', 'rejected');
  });

  it('swallows a throwing listener and still tells the others', async () => {
    const a = manager('window-a');
    const b = manager('window-b');
    const after = vi.fn();
    a.onClaimLost(() => {
      throw new Error('listener failure');
    });
    a.onClaimLost(after);
    await reclaimedByRival(a, b, 'q');

    await expect(a.heartbeat()).resolves.toBeUndefined();

    expect(after).toHaveBeenCalledTimes(1);
  });

  it('stops delivery to a disposed listener', async () => {
    const a = manager('window-a');
    const b = manager('window-b');
    const kept = vi.fn();
    const dropped = vi.fn();
    a.onClaimLost(kept);
    a.onClaimLost(dropped).dispose();
    await reclaimedByRival(a, b, 'q');

    await a.heartbeat();

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('markLost moves a held queue to lost as superseded, once', async () => {
    const a = manager('window-a');
    await a.tryAcquire('q');
    const listener = vi.fn();
    a.onClaimLost(listener);

    a.markLost('q', 'superseded');
    a.markLost('q', 'superseded');

    const tenure = a.tenureOf('q');
    expect(tenure.state).toBe('lost');
    if (tenure.state === 'lost') expect(tenure.reason).toBe('superseded');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('q', 'superseded');
  });

  it('markLost on a queue this window never held changes nothing', () => {
    const a = manager('window-a');
    const listener = vi.fn();
    a.onClaimLost(listener);

    a.markLost('q', 'superseded');

    expect(a.tenureOf('q')).toEqual({ state: 'never-held' });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('a loss stays on its own queue (C1 G3, FR-004, hard rule 4)', () => {
  it('leaves a sibling queue held, with its fence and its registry record', async () => {
    const a = manager('window-a');
    const b = manager('window-b');
    await a.tryAcquire('docs');
    const siblingFence = a.fenceOfRecord('docs');
    await reclaimedByRival(a, b, 'q');

    await a.heartbeat();

    expect(a.tenureOf('q').state).toBe('lost');
    expect(a.tenureOf('docs').state).toBe('held');
    expect(a.claimFor('docs')?.fence).toBe(siblingFence);
    const record = await store.ownership.read(queueResource('docs'));
    expect(record?.holder?.ownerId).toBe('window-a');
  });

  it('never reaches window primacy', async () => {
    const primacyRelease = vi.spyOn(WorkspaceLockManager.prototype, 'release');
    const a = manager('window-a');
    const b = manager('window-b');
    await reclaimedByRival(a, b, 'q');

    await a.heartbeat();
    a.markLost('q', 'superseded');

    expect(primacyRelease).not.toHaveBeenCalled();
  });
});

describe('leaving lost or released (C1 G4)', () => {
  it('a tryAcquire that returns acquired clears lost', async () => {
    const a = manager('window-a');
    const b = manager('window-b');
    await reclaimedByRival(a, b, 'q');
    await a.heartbeat();
    expect(a.tenureOf('q').state).toBe('lost');

    await b.release('q');
    expect((await a.tryAcquire('q')).acquired).toBe(true);

    expect(a.tenureOf('q').state).toBe('held');
  });

  it('a tryAcquire that is refused leaves the queue lost', async () => {
    const a = manager('window-a');
    const b = manager('window-b');
    await reclaimedByRival(a, b, 'q');
    await a.heartbeat();

    expect((await a.tryAcquire('q')).acquired).toBe(false);

    expect(a.tenureOf('q').state).toBe('lost');
  });

  it('release records released for a held queue and drops a lost one', async () => {
    const a = manager('window-a');
    const b = manager('window-b');
    await a.tryAcquire('held');
    await reclaimedByRival(a, b, 'q');
    await a.heartbeat();

    await a.release('held');
    await a.release('q');

    expect(a.tenureOf('held')).toEqual({ state: 'released' });
    expect(a.tenureOf('q')).toEqual({ state: 'released' });
    expect(a.claimFor('q')).toBeNull();
  });

  it('releaseAll records released for every queue this window held or lost', async () => {
    const a = manager('window-a');
    const b = manager('window-b');
    await a.tryAcquire('docs');
    await reclaimedByRival(a, b, 'q');
    await a.heartbeat();

    await a.releaseAll();

    expect(a.tenureOf('docs')).toEqual({ state: 'released' });
    expect(a.tenureOf('q')).toEqual({ state: 'released' });
  });

  it('a released queue is held again only by a new acquisition', async () => {
    const a = manager('window-a');
    await a.tryAcquire('q');
    await a.release('q');
    expect(a.tenureOf('q')).toEqual({ state: 'released' });

    expect((await a.tryAcquire('q')).acquired).toBe(true);

    expect(a.tenureOf('q').state).toBe('held');
  });

  it('no timer or beat calls tryAcquire, so a lost queue stays lost after the rival leaves', async () => {
    const a = manager('window-a');
    const b = manager('window-b');
    await reclaimedByRival(a, b, 'q');
    const acquire = vi.spyOn(a, 'tryAcquire');

    await a.heartbeat();
    await b.release('q');
    await a.heartbeat();
    await a.heartbeat();
    for (const interval of scheduler.intervals) interval.fn();

    expect(acquire).not.toHaveBeenCalled();
    expect(a.tenureOf('q').state).toBe('lost');
  });
});
