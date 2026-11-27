// FR-R4-F01 (spec 239, US1, T008, SC-001) — a superseded window can never
// overwrite the winner.
//
// The real `WorkspaceStateStore` over an in-memory `Memento`, one real
// `OwnershipRegistry` (through the production `useOwnershipStorage()` seam), and
// two real `ExecutionLeaseManager`s with different owner ids. Owner A holds the
// queue, goes stale, and owner B reclaims it. A's heartbeat then runs.
//
// At `ebf589fa` the heartbeat answered a rejected beat by DELETING A's fence, so
// `claimFor` returned null, `runCommitClaim` fell back to
// `unfencedCommit('lease-not-held')`, and A's next `setRun` was accepted with no
// check at all. The ordered assertions below pin the replacement: the claim stays
// LOST, every later commit from that tenure is refused `ownership-lost`, and
// nothing A does moves a byte of B's state.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionLeaseManager } from '../../../src/state/execution-lease';
import { STALENESS_THRESHOLD_MS, WorkspaceLockManager } from '../../../src/state/lock';
import { queueResource } from '../../../src/state/ownership-registry';
import {
  KEYS,
  QueueMutationRejected,
  WorkspaceStateStore,
  type QueueMutationRejectReason
} from '../../../src/state/workspace-state';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import {
  FakeMemento,
  ManualClock,
  ManualScheduler,
  OWNERSHIP_DIR,
  SharedOwnershipFs
} from '../../fixtures/state/ownership-harness';
import { buildWorkflowRun } from '../../fixtures/state/queue-fixtures';

const QUEUE = 'default';
const SIBLING = 'docs';

let fs: SharedOwnershipFs;
let memento: FakeMemento;
let store: WorkspaceStateStore;
let clock: ManualClock;
let scheduler: ManualScheduler;
let leaseA: ExecutionLeaseManager;
let leaseB: ExecutionLeaseManager;
let primacyA: WorkspaceLockManager;

beforeEach(async () => {
  fs = new SharedOwnershipFs();
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  store.useOwnershipStorage(fs, OWNERSHIP_DIR);
  clock = new ManualClock();
  scheduler = new ManualScheduler();
  leaseA = new ExecutionLeaseManager(store, 'window-a', clock, scheduler);
  leaseB = new ExecutionLeaseManager(store, 'window-b', clock, scheduler);
  primacyA = new WorkspaceLockManager(store, 'window-a', clock, scheduler);
  // The store answers `runCommitClaim` from whoever is bound: this window is A.
  store.bindRunClaimSource(leaseA);
});

const runOf = (id: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  ...buildWorkflowRun({ id, featureId: `task-${id}` }),
  ...overrides
});

/** The refusal a write ends in, or a failure naming that it was accepted. */
async function refusalOf(write: () => Promise<unknown>): Promise<QueueMutationRejectReason> {
  try {
    await write();
  } catch (error) {
    if (error instanceof QueueMutationRejected) return error.reason;
    throw error;
  }
  throw new Error('the write was accepted');
}

const writeRun = (run: WorkflowRun) => async () =>
  store.setRun(QUEUE, run, store.runCommitClaim(QUEUE));

const writeQueue = async () =>
  store.updateQueue((current) => ({ queue: current, result: undefined }), QUEUE, store.runCommitClaim(QUEUE));

/** A holds the queue and its sibling, goes stale, and B reclaims the queue and writes. */
async function supersededByB(): Promise<void> {
  expect((await primacyA.tryAcquire()).acquired).toBe(true);
  expect((await leaseA.tryAcquire(QUEUE)).acquired).toBe(true);
  expect((await leaseA.tryAcquire(SIBLING)).acquired).toBe(true);
  await writeRun(runOf('run-a'))();

  clock.advance(STALENESS_THRESHOLD_MS + 1);
  expect((await leaseB.tryAcquire(QUEUE)).acquired).toBe(true);
  await store.setRun(QUEUE, runOf('run-b'), leaseB.claimFor(QUEUE)!);
}

const winnerBytes = () => JSON.stringify([memento.get(KEYS.run), memento.get(KEYS.queue)]);

describe('a superseded window cannot write (US1 #1, #2, #4, #5; SC-001)', () => {
  it('refuses every later write of the lost tenure and leaves the winner byte-equal', async () => {
    await supersededByB();
    const listener = vi.fn();
    leaseA.onClaimLost(listener);

    await leaseA.heartbeat();
    const before = winnerBytes();

    // 1. Each commit point refuses `ownership-lost` BEFORE any read of the record.
    expect(await refusalOf(writeRun(runOf('run-a2')))).toBe('ownership-lost');
    expect(await refusalOf(writeQueue)).toBe('ownership-lost');
    expect(
      await refusalOf(writeRun(runOf('run-a', { status: 'canceled', lastTransitionAt: 2 })))
    ).toBe('ownership-lost');

    // 2. Nothing A did moved a byte of B's state.
    expect(winnerBytes()).toBe(before);
    expect(store.getRun(QUEUE)?.id).toBe('run-b');

    // 3. The loss was announced once, for this queue.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(QUEUE, 'rejected');

    // 4. A lost ONE queue: primacy and the sibling's lease are untouched.
    expect(await primacyA.hasPrimacy()).toBe(true);
    expect(leaseA.tenureOf(SIBLING).state).toBe('held');
    expect(store.runCommitClaim(SIBLING)).toMatchObject({
      resource: queueResource(SIBLING),
      ownerId: 'window-a'
    });
  });

  it('accepts A again after B releases and A acquires anew (US1 #5)', async () => {
    await supersededByB();
    await leaseA.heartbeat();
    expect(await refusalOf(writeRun(runOf('run-a2')))).toBe('ownership-lost');

    await leaseB.release(QUEUE);
    expect((await leaseA.tryAcquire(QUEUE)).acquired).toBe(true);

    await writeRun(runOf('run-a3'))();
    expect(store.getRun(QUEUE)?.id).toBe('run-a3');
  });

  it('refuses a loss the commit point sees before the heartbeat does, then refuses as lost', async () => {
    await supersededByB();
    const listener = vi.fn();
    leaseA.onClaimLost(listener);
    const before = winnerBytes();

    // No heartbeat has run: A still believes it holds the queue, so the first
    // write is refused by the fence itself (contract C2 G8)...
    expect(await refusalOf(writeRun(runOf('run-a2')))).toBe('fence-superseded');
    // ...and that refusal is what moves the tenure to lost.
    expect(leaseA.tenureOf(QUEUE).state).toBe('lost');
    expect(await refusalOf(writeRun(runOf('run-a3')))).toBe('ownership-lost');
    expect(await refusalOf(writeQueue)).toBe('ownership-lost');

    await leaseA.heartbeat();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(QUEUE, 'superseded');
    expect(winnerBytes()).toBe(before);
  });
});
