import { beforeEach, describe, expect, it } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { ExecutionLeaseManager } from '../../../src/state/execution-lease';
import { QueueMutationRejected } from '../../../src/state/workspace-state';
import { queueResource } from '../../../src/state/ownership-registry';
import {
  createHosts,
  ManualClock,
  ManualScheduler,
  SharedOwnershipFs,
  type Host
} from '../../fixtures/state/ownership-harness';

/**
 * FR-R3-077b (T1045) — the queue mutation path carries the same fence.
 *
 * The second half, and it lands as its own change after the Run commit point's,
 * which is the order the escalated-residuals decision record (`00_INDEX.md` §7)
 * item 2 sets. That sequencing is a requirement rather than a preference: the
 * Run path is the one
 * the 2026-08-24 review measured and the one a revived stale host reaches first,
 * and a single change that moved both would have made the smaller blast radius
 * indistinguishable from the larger one.
 *
 * The interleaving is the same one the Run half asserts, retargeted: a holder
 * verifies, stalls long enough for its lease to be reclaimed, wakes up, and
 * commits. Nothing about its own state told it anything had changed.
 *
 * NON-VACUITY, measured: removing the verification block from `updateQueue`'s
 * serialized link lets the resumed mutation land — the queue's requests are
 * rewritten by a host that no longer owns it. Reverted, and the file re-run
 * green.
 */
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

const noopMutation = (queue: unknown): { queue: unknown; result: number } => ({
  queue,
  result: 1
});

describe('a queue mutation carries its fence to the commit point', () => {
  it('commits while the lease is still held', async () => {
    // The mechanism must not refuse a legitimate mutation, or it is
    // indistinguishable from breaking queue persistence.
    const host = hosts[0]!;
    const lease = new ExecutionLeaseManager(host.store, 'window-a', clock, scheduler);
    expect((await lease.tryAcquire('default')).acquired).toBe(true);

    const result = await host.store.updateQueue(
      noopMutation as never,
      'default',
      lease.claimFor('default')!
    );
    expect(result).toBe(1);
  });

  it('refuses the resumed mutation once the lease has been reclaimed', async () => {
    const a = hosts[0]!;
    const leaseA = new ExecutionLeaseManager(a.store, 'window-a', clock, scheduler);
    expect((await leaseA.tryAcquire('default')).acquired).toBe(true);
    const claimA = leaseA.claimFor('default')!;

    // The stall, and the reclaim underneath it.
    clock.advance(10 * 60 * 1000);
    const leaseB = new ExecutionLeaseManager(hosts[1]!.store, 'window-b', clock, scheduler);
    expect((await leaseB.tryAcquire('default')).acquired).toBe(true);

    await expect(
      a.store.updateQueue(noopMutation as never, 'default', claimA)
    ).rejects.toThrow(QueueMutationRejected);
  });

  it('names the fence rather than reporting a storage error', async () => {
    const a = hosts[0]!;
    const leaseA = new ExecutionLeaseManager(a.store, 'window-a', clock, scheduler);
    await leaseA.tryAcquire('default');
    const claimA = leaseA.claimFor('default')!;
    clock.advance(10 * 60 * 1000);
    await new ExecutionLeaseManager(hosts[1]!.store, 'window-b', clock, scheduler).tryAcquire(
      'default'
    );

    try {
      await a.store.updateQueue(noopMutation as never, 'default', claimA);
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as QueueMutationRejected).reason).toBe('fence-superseded');
      // The resource and the generation, so the record explains itself.
      expect((error as Error).message).toContain(queueResource('default'));
      expect((error as Error).message).toContain(String(claimA.fence));
    }
  });

  it('writes nothing when it refuses', async () => {
    const a = hosts[0]!;
    const leaseA = new ExecutionLeaseManager(a.store, 'window-a', clock, scheduler);
    await leaseA.tryAcquire('default');
    const claimA = leaseA.claimFor('default')!;
    await a.store.updateQueue(
      ((queue: { requests: unknown[] }) => ({
        queue: { ...queue, migrationNotice: 'original' },
        result: 0
      })) as never,
      'default',
      claimA
    );

    clock.advance(10 * 60 * 1000);
    await new ExecutionLeaseManager(hosts[1]!.store, 'window-b', clock, scheduler).tryAcquire(
      'default'
    );

    await a.store
      .updateQueue(
        ((queue: object) => ({ queue: { ...queue, migrationNotice: 'overwrite' }, result: 0 })) as never,
        'default',
        claimA
      )
      .catch(() => undefined);
    expect(
      (a.store.getQueue('default') as unknown as { migrationNotice?: string }).migrationNotice
    ).toBe('original');
  });

  it('leaves an unfenced mutation exactly as it was', async () => {
    // The same reading the Run half takes: an unfenced commit writes, and it
    // carries no stamp, so nothing downstream reads it as superseded.
    const host = hosts[0]!;
    const result = await host.store.updateQueue(
      noopMutation as never,
      'default',
      unfencedCommit('test-fixture')
    );
    expect(result).toBe(1);
  });
});
