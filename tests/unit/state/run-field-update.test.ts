// FR-R4-F01 (spec 239, US2, T020, contract C2 G6, G7, G9, data-model §2) — a Run
// field update patches the CURRENT Run, inside the `KEYS.run` chain.
//
// Pause and the liveness recorder each used to read the Run on their own, build a
// whole record from that read, and queue `setRun`. The later link then wrote back
// a snapshot that predated the earlier one, and one of the two writes was lost.
// `updateRun` re-reads, checks and patches inside the one link `setRun` already
// uses (hard rule 58), so interleavings commute and nothing is recreated.
//
// Real store, in-memory `Memento`, real lease managers where a fence is involved.
// No timers: the interleavings are forced by the order the writes are queued in.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { ExecutionLeaseManager } from '../../../src/state/execution-lease';
import { STALENESS_THRESHOLD_MS } from '../../../src/state/lock';
import { unfencedCommit, type RunCommitClaim } from '../../../src/state/ownership-claim';
import {
  KEYS,
  QueueMutationRejected,
  WorkspaceStateStore,
  type QueueMutationRejectReason
} from '../../../src/state/workspace-state';
import type { WorkflowRun, WorkflowRunStatus } from '../../../src/state/workflow-run';
import {
  FakeMemento,
  ManualClock,
  ManualScheduler,
  OWNERSHIP_DIR,
  SharedOwnershipFs
} from '../../fixtures/state/ownership-harness';
import {
  buildQueueRegistry,
  buildWorkflowRun,
  fixtureQueueId
} from '../../fixtures/state/queue-fixtures';

const QUEUE = DEFAULT_QUEUE_ID;
const OTHER_QUEUE = fixtureQueueId(2);
const unfenced = unfencedCommit('test-fixture');
const LIVE: readonly WorkflowRunStatus[] = ['running', 'paused'];

let memento: FakeMemento;
let store: WorkspaceStateStore;

beforeEach(async () => {
  memento = new FakeMemento();
  await memento.update(KEYS.queueRegistry, buildQueueRegistry({ count: 2, defaultAtPosition: 0 }));
  await memento.update(KEYS.queueDefaultId, DEFAULT_QUEUE_ID);
  store = new WorkspaceStateStore(memento);
});

/** The run map exactly as persisted, for byte-equality across a refusal. */
const persisted = () => JSON.stringify(memento.get(KEYS.run) ?? null);

const update = (
  run: WorkflowRun,
  overrides: Partial<Parameters<WorkspaceStateStore['updateRun']>[1]> = {}
): Parameters<WorkspaceStateStore['updateRun']>[1] => ({
  runId: run.id,
  allowedStatuses: LIVE,
  label: 'liveness',
  patch: () => ({}),
  ...overrides
});

/** The refusal reason, whether the call throws synchronously or rejects. */
async function reasonOf(call: () => Promise<unknown>): Promise<QueueMutationRejectReason> {
  try {
    await call();
  } catch (error) {
    if (error instanceof QueueMutationRejected) return error.reason;
    throw error;
  }
  throw new Error('the update was accepted');
}

describe('a refused update writes nothing (G7, G9)', () => {
  it('refuses stale-run-id when the queue has no Run, and never recreates the entry', async () => {
    const run = buildWorkflowRun({ id: 'run-a' });
    const patch = vi.fn(() => ({}));

    expect(await reasonOf(async () => store.updateRun(QUEUE, update(run, { patch }), unfenced))).toBe(
      'stale-run-id'
    );

    expect(patch).not.toHaveBeenCalled();
    expect(store.getRun(QUEUE)).toBeNull();
    expect(memento.get(KEYS.run)).toBeUndefined();
  });

  it('refuses stale-run-id when the entry holds another Run', async () => {
    await store.setRun(QUEUE, buildWorkflowRun({ id: 'run-b' }), unfenced);
    const before = persisted();

    expect(
      await reasonOf(async () =>
        store.updateRun(QUEUE, update(buildWorkflowRun({ id: 'run-a' })), unfenced)
      )
    ).toBe('stale-run-id');

    expect(persisted()).toBe(before);
  });

  it('refuses run-status-precondition when the status is outside allowedStatuses', async () => {
    const run = buildWorkflowRun({ id: 'run-a', status: 'completed' });
    await store.setRun(QUEUE, run, unfenced);
    const before = persisted();
    const patch = vi.fn(() => ({ currentIteration: 11 }));

    expect(await reasonOf(async () => store.updateRun(QUEUE, update(run, { patch }), unfenced))).toBe(
      'run-status-precondition'
    );

    expect(patch).not.toHaveBeenCalled();
    expect(persisted()).toBe(before);
  });
});

describe('tenure and fence are checked before the patch is applied (G6, G8)', () => {
  let clock: ManualClock;
  let scheduler: ManualScheduler;
  let leaseA: ExecutionLeaseManager;
  let leaseB: ExecutionLeaseManager;
  let run: WorkflowRun;

  beforeEach(async () => {
    store.useOwnershipStorage(new SharedOwnershipFs(), OWNERSHIP_DIR);
    clock = new ManualClock();
    scheduler = new ManualScheduler();
    leaseA = new ExecutionLeaseManager(store, 'window-a', clock, scheduler);
    leaseB = new ExecutionLeaseManager(store, 'window-b', clock, scheduler);
    store.bindRunClaimSource(leaseA);
    await leaseA.tryAcquire(QUEUE);
    run = buildWorkflowRun({ id: 'run-a' });
    await store.setRun(QUEUE, run, store.runCommitClaim(QUEUE));
    clock.advance(STALENESS_THRESHOLD_MS + 1);
    await leaseB.tryAcquire(QUEUE);
  });

  it('refuses fence-superseded for a stale fence, and the refusal marks the tenure lost', async () => {
    const before = persisted();
    const patch = vi.fn(() => ({}));

    const reason = await reasonOf(async () =>
      store.updateRun(QUEUE, update(run, { patch }), leaseA.claimFor(QUEUE) as RunCommitClaim)
    );

    expect(reason).toBe('fence-superseded');
    expect(patch).not.toHaveBeenCalled();
    expect(persisted()).toBe(before);
    expect(leaseA.tenureOf(QUEUE).state).toBe('lost');
  });

  it('refuses ownership-lost for a lost tenure, whichever claim it is handed', async () => {
    await leaseA.heartbeat();
    expect(leaseA.tenureOf(QUEUE).state).toBe('lost');
    const before = persisted();

    expect(await reasonOf(async () => store.updateRun(QUEUE, update(run), store.runCommitClaim(QUEUE)))).toBe(
      'ownership-lost'
    );
    expect(
      await reasonOf(async () =>
        store.updateRun(QUEUE, update(run), leaseA.claimFor(QUEUE) as RunCommitClaim)
      )
    ).toBe('ownership-lost');

    expect(persisted()).toBe(before);
  });
});

describe('the patch is applied to the Run as it is inside the link (G6)', () => {
  it('does not overwrite a setRun queued between the caller\'s read and the update', async () => {
    const run = buildWorkflowRun({ id: 'run-a' });
    await store.setRun(QUEUE, run, unfenced);
    const callersRead = store.getRun(QUEUE)!;
    const liveness = { lastActivityAt: 7_000, stdoutLines: 3, stderrLines: 1 };
    let seen: WorkflowRun | null = null;

    // The liveness write is queued first, built from the same stale read.
    const livenessWrite = store.setRun(QUEUE, { ...callersRead, liveness }, unfenced);
    const pause = store.updateRun(
      QUEUE,
      update(run, {
        label: 'pause',
        patch: (current) => {
          seen = current;
          return { manualPauseAt: 9_000, manualPauseCause: 'operator-paused' };
        }
      }),
      unfenced
    );
    await Promise.all([livenessWrite, pause]);

    expect(seen).toMatchObject({ liveness });
    expect(store.getRun(QUEUE)).toMatchObject({
      liveness,
      manualPauseAt: 9_000,
      manualPauseCause: 'operator-paused'
    });
  });

  it('keeps the other half of a pair the patch does not mention', async () => {
    const run = buildWorkflowRun({ id: 'run-a', manualPauseCause: 'operator-paused' });
    await store.setRun(QUEUE, run, unfenced);

    await store.updateRun(
      QUEUE,
      update(run, { patch: () => ({ currentIteration: 12 }) }),
      unfenced
    );

    expect(store.getRun(QUEUE)).toMatchObject({
      currentIteration: 12,
      manualPauseCause: 'operator-paused'
    });
  });

  it('throws from validateRunInvariants for a one-sided pause/retry pair and writes nothing', async () => {
    const run = buildWorkflowRun({ id: 'run-a' });
    await store.setRun(QUEUE, run, unfenced);
    const before = persisted();

    await expect(
      store.updateRun(QUEUE, update(run, { patch: () => ({ pendingRetryAt: 1_234 }) }), unfenced)
    ).rejects.toThrow(/invariant violation/);

    expect(persisted()).toBe(before);
  });

  it('lets two updates on different queues, started together, keep each other\'s entry', async () => {
    const a = buildWorkflowRun({ id: 'run-a', featureId: 'task-a' });
    const b = buildWorkflowRun({ id: 'run-b', featureId: 'task-b' });
    await store.setRun(QUEUE, a, unfenced);
    await store.setRun(OTHER_QUEUE, b, unfenced);

    await Promise.all([
      store.updateRun(QUEUE, update(a, { patch: () => ({ currentIteration: 21 }) }), unfenced),
      store.updateRun(OTHER_QUEUE, update(b, { patch: () => ({ currentIteration: 22 }) }), unfenced)
    ]);

    expect(store.getRun(QUEUE)).toMatchObject({ id: 'run-a', currentIteration: 21 });
    expect(store.getRun(OTHER_QUEUE)).toMatchObject({ id: 'run-b', currentIteration: 22 });
  });
});

describe('what a successful update returns and stamps (G6)', () => {
  it('resolves to the Run it wrote', async () => {
    const run = buildWorkflowRun({ id: 'run-a' });
    await store.setRun(QUEUE, run, unfenced);

    const written = await store.updateRun(
      QUEUE,
      update(run, { patch: () => ({ currentIteration: 31 }) }),
      unfenced
    );

    expect(written).toEqual(store.getRun(QUEUE));
    expect(written.currentIteration).toBe(31);
  });

  it('stamps writtenAtFence from a fenced claim, and from no other', async () => {
    store.useOwnershipStorage(new SharedOwnershipFs(), OWNERSHIP_DIR);
    const lease = new ExecutionLeaseManager(store, 'window-a', new ManualClock(), new ManualScheduler());
    store.bindRunClaimSource(lease);
    await lease.tryAcquire(QUEUE);
    const run = buildWorkflowRun({ id: 'run-a' });
    await store.setRun(QUEUE, run, unfenced);

    const unstamped = await store.updateRun(QUEUE, update(run), unfenced);
    expect(unstamped.writtenAtFence).toBeUndefined();

    const stamped = await store.updateRun(QUEUE, update(run), store.runCommitClaim(QUEUE));
    expect(stamped.writtenAtFence).toBe(lease.fenceOfRecord(QUEUE));
  });
});
