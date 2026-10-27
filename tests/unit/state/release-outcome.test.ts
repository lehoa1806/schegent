// FR-R4-F01 (spec 239, US6, T074 to T077, FR-033, contract C7) — a release answers with what it
// came to, and the sites that can say so do.
//
// `ExecutionLeaseManager.release` and `WorkspaceLockManager.release` both read the registry's
// verdict on the release and threw it away, so a refused or unwritable release looked the same
// as one that worked. `tests/lint/swallowed-release-census.test.ts` counts the call sites; this
// file is the behaviour behind them.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionLeaseManager, releaseLeaseLogged } from '../../../src/state/execution-lease';
import { STALENESS_THRESHOLD_MS, WorkspaceLockManager } from '../../../src/state/lock';
import type { ReleaseOutcome } from '../../../src/state/ownership-registry';
import {
  createHosts,
  ManualClock,
  ManualScheduler,
  SharedOwnershipFs,
  type Host
} from '../../fixtures/state/ownership-harness';

const QUEUE = 'queue-a';

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

const leaseManager = (host: Host, owner: string): ExecutionLeaseManager =>
  new ExecutionLeaseManager(host.store, owner, clock, scheduler);

describe('ExecutionLeaseManager.release names its outcome', () => {
  it('released: the claim was held and given back', async () => {
    const manager = leaseManager(hosts[0]!, 'window-a');
    await manager.tryAcquire(QUEUE);

    expect(await manager.release(QUEUE)).toBe('released');
  });

  it('not-holder: the queue was never held by this owner', async () => {
    const manager = leaseManager(hosts[0]!, 'window-a');

    expect(await manager.release('queue-never-held')).toBe('not-holder');
  });

  it('not-holder: another window reclaimed the queue after this one went stale', async () => {
    const holder = leaseManager(hosts[0]!, 'window-a');
    const rival = leaseManager(hosts[1]!, 'window-b');
    await holder.tryAcquire(QUEUE);
    clock.advance(STALENESS_THRESHOLD_MS + 1);
    expect((await rival.tryAcquire(QUEUE)).acquired).toBe(true);

    expect(await holder.release(QUEUE)).toBe('not-holder');
  });

  it('unavailable: the registry could not be read or written', async () => {
    const manager = leaseManager(hosts[0]!, 'window-a');
    await manager.tryAcquire(QUEUE);
    fs.faults.failList = true;

    expect(await manager.release(QUEUE)).toBe('unavailable');
  });
});

describe('withLease keeps its release silent (C7)', () => {
  it('returns the function\'s own result when the release cannot be written', async () => {
    const manager = leaseManager(hosts[0]!, 'window-a');

    const result = await manager.withLease(QUEUE, async () => {
      fs.faults.failList = true;
      return 'the result';
    });

    expect(result).toBe('the result');
  });
});

describe('releaseLeaseLogged', () => {
  const warn = vi.fn();
  const logger = { warn };

  beforeEach(() => {
    warn.mockClear();
  });

  it.each<[string, () => Promise<ReleaseOutcome | void> | ReleaseOutcome | void]>([
    ['released', () => 'released'],
    ['a double that returns nothing', () => undefined],
    ['a double that returns a resolved nothing', () => Promise.resolve()]
  ])('is silent for %s', async (_name, release) => {
    await releaseLeaseLogged({ release }, QUEUE, logger);

    expect(warn).not.toHaveBeenCalled();
  });

  it.each<ReleaseOutcome>(['not-holder', 'unavailable'])('logs the queue and the outcome for %s', async (outcome) => {
    await releaseLeaseLogged({ release: async () => outcome }, QUEUE, logger);

    expect(warn).toHaveBeenCalledExactlyOnceWith('execution lease release failed', {
      queueId: QUEUE,
      outcome
    });
  });

  it('reads a throw as unavailable, and does not throw itself', async () => {
    const release = (): Promise<void> => Promise.reject(new Error('Memento write failed: /secret/path'));

    await expect(releaseLeaseLogged({ release }, QUEUE, logger)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledExactlyOnceWith('execution lease release failed', {
      queueId: QUEUE,
      outcome: 'unavailable'
    });
  });

  it('tolerates a missing logger', async () => {
    await expect(
      releaseLeaseLogged({ release: async () => 'not-holder' as const }, QUEUE, null)
    ).resolves.toBeUndefined();
  });
});

describe('WorkspaceLockManager.release logs what it discards today (T077)', () => {
  const warn = vi.fn();

  beforeEach(() => {
    warn.mockClear();
  });

  const lockManager = (host: Host, owner: string): WorkspaceLockManager =>
    new WorkspaceLockManager(host.store, owner, clock, scheduler, { warn });

  it('is silent when the claim is given back', async () => {
    const lock = lockManager(hosts[0]!, 'window-a');
    await lock.tryAcquire();

    await lock.release();

    expect(warn).not.toHaveBeenCalled();
  });

  it('names the outcome, and only the outcome, when the registry cannot write it', async () => {
    const lock = lockManager(hosts[0]!, 'window-a');
    await lock.tryAcquire();
    fs.faults.failList = true;

    await lock.release();

    expect(warn).toHaveBeenCalledExactlyOnceWith('workspace lock release failed', {
      outcome: 'unavailable'
    });
  });

  it('still clears the lock mirror: primacy\'s tenure is unchanged (hard rule 4)', async () => {
    const host = hosts[0]!;
    const lock = lockManager(host, 'window-a');
    await lock.tryAcquire();
    fs.faults.failList = true;

    await lock.release();

    expect(host.store.getLock()).toBeNull();
  });
});
