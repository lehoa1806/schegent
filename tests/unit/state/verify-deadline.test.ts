// FR-R4-F01 (spec 239, US5, T040, FR-021 to FR-023, SC-005, contract C3) — ownership
// verification fails closed within a time limit.
//
// `checkCommitFence` awaits `registry.verify` INSIDE the `KEYS.run` or `KEYS.queue` link, and
// `serialize` chains every later write on that key behind the link. A verify that never settles
// (a filesystem that hangs rather than fails) therefore wedged every later Run write in the
// window, and the drain's `hasLease` and the lock mirror's guarded refresh waited on it too.
//
// Every wait here is on an injected scheduler: no real time passes, and the verify that never
// settles is a gate the test owns.

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { ExecutionLeaseManager } from '../../../src/state/execution-lease';
import { HEARTBEAT_INTERVAL_MS, WorkspaceLockManager } from '../../../src/state/lock';
import { OWNERSHIP_VERIFY_DEADLINE_MS, verifyWithin } from '../../../src/state/ownership-claim';
import { PRIMACY_RESOURCE, type FenceCheck } from '../../../src/state/ownership-registry';
import { QueueMutationRejected, WorkspaceStateStore } from '../../../src/state/workspace-state';
import {
  FakeMemento,
  ManualClock,
  ManualScheduler,
  OWNERSHIP_DIR,
  SharedOwnershipFs
} from '../../fixtures/state/ownership-harness';
import { buildWorkflowRun } from '../../fixtures/state/queue-fixtures';

/** An ownership filesystem whose directory listing can be made to wait, and let go. */
class HangingFs extends SharedOwnershipFs {
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  hang(): void {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    const open = this.open;
    this.gate = null;
    this.open = null;
    open?.();
  }

  override async list(dir: string): Promise<readonly string[]> {
    const gate = this.gate;
    if (gate !== null) await gate;
    return super.list(dir);
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const VALID: FenceCheck = { outcome: 'valid', fence: 1 };

describe('verifyWithin (contract C3 G10 to G12)', () => {
  it('gives up with cause deadline when the read never settles, at the named deadline', async () => {
    const scheduler = new ManualScheduler();
    const registry = { verify: () => new Promise<FenceCheck>(() => undefined) };

    const result = verifyWithin(registry, 'queue:q', 'w', 1, OWNERSHIP_VERIFY_DEADLINE_MS, scheduler);

    expect(scheduler.intervals).toHaveLength(1);
    expect(scheduler.intervals[0]!.ms).toBe(OWNERSHIP_VERIFY_DEADLINE_MS);
    scheduler.intervals[0]!.fn();
    await expect(result).resolves.toEqual({ outcome: 'unavailable', cause: 'deadline' });
    expect(scheduler.intervals, 'the timer is cleared once the deadline has fired').toHaveLength(0);
  });

  it('returns the answer, and clears the timer, when the read settles first', async () => {
    const scheduler = new ManualScheduler();
    const registry = { verify: async (): Promise<FenceCheck> => VALID };

    const result = await verifyWithin(registry, 'queue:q', 'w', 1, 5_000, scheduler);

    expect(result).toEqual(VALID);
    expect(scheduler.intervals).toHaveLength(0);
  });

  it('reads a failed verify as unavailable, with no cause', async () => {
    const registry = {
      verify: (): Promise<FenceCheck> => Promise.reject(new Error('storage fell over'))
    };

    await expect(
      verifyWithin(registry, 'queue:q', 'w', 1, 5_000, new ManualScheduler())
    ).resolves.toEqual({ outcome: 'unavailable' });
  });

  it('is not changed by an answer that arrives after the deadline (FR-022)', async () => {
    const scheduler = new ManualScheduler();
    let answer!: (check: FenceCheck) => void;
    const registry = {
      verify: () =>
        new Promise<FenceCheck>((resolve) => {
          answer = resolve;
        })
    };
    const result = verifyWithin(registry, 'queue:q', 'w', 1, 5_000, scheduler);
    scheduler.intervals[0]!.fn();
    const decided = await result;

    answer(VALID);
    await flush();

    expect(decided).toEqual({ outcome: 'unavailable', cause: 'deadline' });
  });

  it('the deadline is one heartbeat period, imported and not restated', () => {
    expect(OWNERSHIP_VERIFY_DEADLINE_MS).toBe(HEARTBEAT_INTERVAL_MS);
  });
});

describe('the commit points refuse on the deadline and then move on (SC-005)', () => {
  let fs: HangingFs;
  let storeScheduler: ManualScheduler;
  let leaseScheduler: ManualScheduler;
  let store: WorkspaceStateStore;
  let lease: ExecutionLeaseManager;

  beforeEach(async () => {
    fs = new HangingFs();
    storeScheduler = new ManualScheduler();
    leaseScheduler = new ManualScheduler();
    store = new WorkspaceStateStore(new FakeMemento(), undefined, storeScheduler);
    await store.initialize();
    store.useOwnershipStorage(fs, OWNERSHIP_DIR);
    lease = new ExecutionLeaseManager(store, 'window-a', new ManualClock(), leaseScheduler);
    expect((await lease.tryAcquire(DEFAULT_QUEUE_ID)).acquired).toBe(true);
    store.bindRunClaimSource(lease);
  });

  const run = (id: string) => buildWorkflowRun({ id, featureId: `task-${id}` });

  /** Run `write` while the ownership record hangs; fire the deadline; return its refusal. */
  async function refusedOnDeadline(write: () => Promise<unknown>): Promise<unknown> {
    fs.hang();
    const pending = write();
    const outcome = pending.then(
      () => 'accepted',
      (error: unknown) => error
    );
    await flush();
    expect(storeScheduler.intervals, 'the commit is waiting on a deadline timer').toHaveLength(1);
    storeScheduler.intervals[0]!.fn();
    return outcome;
  }

  it('refuses setRun fence-unverifiable, writes nothing, and the next update proceeds', async () => {
    const refusal = await refusedOnDeadline(async () =>
      store.setRun(DEFAULT_QUEUE_ID, run('late'), store.runCommitClaim(DEFAULT_QUEUE_ID))
    );

    expect(refusal).toBeInstanceOf(QueueMutationRejected);
    expect((refusal as QueueMutationRejected).reason).toBe('fence-unverifiable');
    expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();

    // FR-022: the read that was given up on now answers "still owner", and nothing is written.
    fs.release();
    await flush();
    expect(store.getRun(DEFAULT_QUEUE_ID)).toBeNull();

    // The chain moved on: the next update on the same key proceeds.
    await store.setRun(DEFAULT_QUEUE_ID, run('next'), store.runCommitClaim(DEFAULT_QUEUE_ID));
    expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('next');
  });

  it('refuses updateRun fence-unverifiable on the same terms', async () => {
    const first = run('first');
    await store.setRun(DEFAULT_QUEUE_ID, first, store.runCommitClaim(DEFAULT_QUEUE_ID));

    const refusal = await refusedOnDeadline(async () =>
      store.updateRun(
        DEFAULT_QUEUE_ID,
        {
          runId: first.id,
          allowedStatuses: ['running'],
          label: 'liveness',
          patch: () => ({ currentIteration: 9 })
        },
        store.runCommitClaim(DEFAULT_QUEUE_ID)
      )
    );

    expect((refusal as QueueMutationRejected).reason).toBe('fence-unverifiable');
    fs.release();
    await flush();
    expect(store.getRun(DEFAULT_QUEUE_ID)?.currentIteration).toBe(first.currentIteration);
  });

  it('answers false from hasLease when the verify gives up', async () => {
    fs.hang();
    const answer = lease.hasLease(DEFAULT_QUEUE_ID);
    await flush();
    // The heartbeat interval was armed first; the deadline timer is the one added after it.
    const timers = leaseScheduler.intervals;
    expect(timers.length).toBeGreaterThanOrEqual(2);
    timers[timers.length - 1]!.fn();

    await expect(answer).resolves.toBe(false);
    fs.release();
  });

  it('gives up in the lock mirror\'s guarded refresh, and leaves the mirror alone', async () => {
    const lock = new WorkspaceLockManager(store, 'window-a', new ManualClock(), new ManualScheduler());
    expect((await lock.tryAcquire()).acquired).toBe(true);
    const mirrorBefore = JSON.stringify(store.getLock());
    fs.hang();

    const pending = store.refreshLockMirrorGuarded(
      { resource: PRIMACY_RESOURCE, ownerId: 'window-a', fence: lock.fenceOfRecord()! },
      { ownerId: 'window-a', acquiredAt: 1, heartbeatAt: 2 }
    );
    await flush();
    storeScheduler.intervals[0]!.fn();

    await expect(pending).resolves.toEqual({ outcome: 'unavailable' });
    fs.release();
    await flush();
    expect(JSON.stringify(store.getLock())).toBe(mirrorBefore);
  });
});
