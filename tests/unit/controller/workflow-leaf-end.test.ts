// What a Workflow control does to the one Phase leaf it is ending.
//
// Pause and Cancel commit their own record of the attempt; this table is about
// the queue row and the leaf `WorkflowRun` underneath it. Real store and real
// queue, so a row or Run that "ended" is one the store reads back that way; the
// controller's seams are recorded, because who answers for the lease is the
// question most of these cases ask.

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import {
  endWorkflowLeaf,
  type WorkflowLeafEndDeps
} from '../../../src/controller/workflow-leaf-end';
import { QueueManager } from '../../../src/queue/queue-manager';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import type { WorkflowRun, WorkflowRunStatus } from '../../../src/state/workflow-run';
import {
  QueueMutationRejected,
  WorkspaceStateStore,
  type Memento
} from '../../../src/state/workspace-state';

class FakeMemento implements Memento {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

type RunShape = 'driven' | 'backoff' | 'phase-paused';

const SHAPE_STATUS: Readonly<Record<RunShape, WorkflowRunStatus>> = {
  driven: 'running',
  backoff: 'paused',
  'phase-paused': 'paused'
};

function runFor(taskId: string, shape: RunShape): WorkflowRun {
  const now = Date.now();
  return {
    id: `run-of-${taskId}`,
    featureId: taskId,
    featureDir: 'specs/000',
    status: SHAPE_STATUS[shape],
    currentPhase: 'speckit-plan',
    currentIteration: 1,
    startedAt: now,
    lastTransitionAt: now,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: shape === 'backoff' ? 1 : 0,
    pendingRetryAt: shape === 'backoff' ? now + 60_000 : null,
    pendingRetryCause: shape === 'backoff' ? 'rate_limit' : null,
    phaseOverrides: [],
    manualPauseAt: shape === 'phase-paused' ? now : null,
    manualPauseCause: shape === 'phase-paused' ? 'operator-paused' : null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
}

async function makeWorld() {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const queue = new QueueManager(store);
  const calls: string[] = [];
  const warn = vi.fn();
  const flags = { driving: false, claimLost: false };
  const deps: WorkflowLeafEndDeps = {
    logger: { warn },
    queue,
    store,
    cancelActive: (queueId) => {
      calls.push(`cancelActive:${queueId}`);
    },
    isDriving: () => flags.driving,
    cancelPendingRetry: (queueId) => {
      calls.push(`cancelPendingRetry:${queueId}`);
    },
    isClaimLostToRival: () => flags.claimLost,
    releaseExecutionLeaseForRun: (run) => {
      const rowPresent = queue.findById(run.featureId) !== null;
      calls.push(`release:${run.status}:row-${rowPresent ? 'present' : 'gone'}`);
      return Promise.resolve();
    },
    completeTerminalRun: (run, description) => {
      calls.push(`complete:${run.status}:${description}`);
      return Promise.resolve();
    },
    auditLeafCanceled: (row, run) => {
      calls.push(`audit:${row.id}:${run?.id ?? 'no-run'}`);
      return Promise.resolve();
    }
  };

  const enqueue = async (description: string): Promise<string> =>
    (await queue.enqueue(description)).id;

  /** A row in flight on this queue, with the Run of that shape as the queue's Run. */
  const seedLeaf = async (shape: RunShape, rowStatus: 'in-flight' | 'paused'): Promise<string> => {
    const taskId = await enqueue('the leaf');
    await queue.markInFlight(taskId, `run-of-${taskId}`);
    if (rowStatus === 'paused') await queue.pause(taskId, 'phase-paused');
    await store.setRun(DEFAULT_QUEUE_ID, runFor(taskId, shape), unfencedCommit('test-fixture'));
    return taskId;
  };

  return { store, queue, calls, warn, flags, deps, enqueue, seedLeaf };
}

const target = (taskId: string) => ({ queueId: DEFAULT_QUEUE_ID, taskId });

describe('endWorkflowLeaf', () => {
  it('does nothing when the row is gone', async () => {
    const world = await makeWorld();

    await endWorkflowLeaf(world.deps, target('no-such-row'));

    expect(world.calls).toEqual([]);
    expect(world.warn).not.toHaveBeenCalled();
  });

  it('does nothing when the row has already ended', async () => {
    const world = await makeWorld();
    const taskId = await world.enqueue('the leaf');
    await world.queue.finish(taskId, 'canceled');
    const before = world.queue.findById(taskId);

    await endWorkflowLeaf(world.deps, target(taskId));

    expect(world.calls).toEqual([]);
    expect(world.queue.findById(taskId)).toEqual(before);
  });

  it('cancels a pending row, or the drain would start it after the control', async () => {
    const world = await makeWorld();
    const taskId = await world.enqueue('the leaf');

    await endWorkflowLeaf(world.deps, target(taskId));

    expect(world.queue.findById(taskId)?.status).toBe('canceled');
    expect(world.queue.peekNextPending(DEFAULT_QUEUE_ID)).toBeFalsy();
    expect(world.calls).toEqual([`audit:${taskId}:no-run`]);
  });

  it('leaves a driven leaf to its driver: signaled and written, the funnel releases and records', async () => {
    const world = await makeWorld();
    const taskId = await world.seedLeaf('driven', 'in-flight');
    world.flags.driving = true;

    await endWorkflowLeaf(world.deps, target(taskId));

    expect(world.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('canceled');
    expect(world.queue.findById(taskId)?.status).toBe('canceled');
    expect(world.calls).toEqual([
      `cancelActive:${DEFAULT_QUEUE_ID}`,
      `cancelPendingRetry:${DEFAULT_QUEUE_ID}`,
      `audit:${taskId}:run-of-${taskId}`
    ]);
  });

  it('decides who answers for the lease before it signals, because a driver can finish during the writes', async () => {
    const world = await makeWorld();
    const taskId = await world.seedLeaf('driven', 'in-flight');
    world.flags.driving = true;
    // The driver's whole finally runs inside this call in the worst case: its release has
    // landed and a successor may hold the queue, so a second release here would clear that.
    world.deps = {
      ...world.deps,
      cancelActive: () => {
        world.flags.driving = false;
      }
    };

    await endWorkflowLeaf(world.deps, target(taskId));

    expect(world.calls.filter((call) => call.startsWith('release:'))).toEqual([]);
    expect(world.calls.filter((call) => call.startsWith('complete:'))).toEqual([]);
  });

  it('settles a leaf in backoff itself, since no driver will: timer, Run, row, lease, history', async () => {
    const world = await makeWorld();
    const taskId = await world.seedLeaf('backoff', 'in-flight');

    await endWorkflowLeaf(world.deps, target(taskId));

    const run = world.store.getRun(DEFAULT_QUEUE_ID);
    expect(run?.status).toBe('canceled');
    expect(run?.pendingRetryAt).toBeNull();
    expect(run?.pendingRetryCause).toBeNull();
    expect(world.queue.findById(taskId)?.status).toBe('canceled');
    expect(world.calls).toEqual([
      `cancelActive:${DEFAULT_QUEUE_ID}`,
      `cancelPendingRetry:${DEFAULT_QUEUE_ID}`,
      `audit:${taskId}:run-of-${taskId}`,
      'release:canceled:row-present',
      'complete:canceled:the leaf'
    ]);
  });

  it('settles a phase-paused leaf: a paused row cannot be finished, so it goes, after the lease', async () => {
    const world = await makeWorld();
    const taskId = await world.seedLeaf('phase-paused', 'paused');

    await endWorkflowLeaf(world.deps, target(taskId));

    expect(world.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('canceled');
    expect(world.queue.findById(taskId)).toBeNull();
    // With no row the queue cannot be resolved, so the release has to come first.
    expect(world.calls).toEqual([
      `cancelActive:${DEFAULT_QUEUE_ID}`,
      `cancelPendingRetry:${DEFAULT_QUEUE_ID}`,
      `audit:${taskId}:run-of-${taskId}`,
      'release:canceled:row-present',
      'complete:canceled:the leaf'
    ]);
  });

  it('removes a paused row that has no live Run', async () => {
    const world = await makeWorld();
    const taskId = await world.enqueue('the leaf');
    await world.queue.markInFlight(taskId, 'an-earlier-run');
    await world.queue.pause(taskId, 'phase-paused');

    await endWorkflowLeaf(world.deps, target(taskId));

    expect(world.queue.findById(taskId)).toBeNull();
    expect(world.calls).toEqual([`audit:${taskId}:no-run`]);
  });

  it('settles a paused Run a driver is on its way out of, because that driver answers for nothing paused', async () => {
    const world = await makeWorld();
    const taskId = await world.seedLeaf('backoff', 'in-flight');
    world.flags.driving = true;

    await endWorkflowLeaf(world.deps, target(taskId));

    expect(world.calls).toContain('release:canceled:row-present');
    expect(world.calls).toContain('complete:canceled:the leaf');
  });

  it('settles a Run that reads live with nothing driving it', async () => {
    const world = await makeWorld();
    const taskId = await world.seedLeaf('driven', 'in-flight');

    await endWorkflowLeaf(world.deps, target(taskId));

    expect(world.calls).toContain('release:canceled:row-present');
    expect(world.calls).toContain('complete:canceled:the leaf');
  });

  it("never touches a sibling's Run: the queue's Run has to be this leaf's", async () => {
    const world = await makeWorld();
    const sibling = await world.enqueue('a sibling');
    await world.queue.markInFlight(sibling, `run-of-${sibling}`);
    await world.store.setRun(
      DEFAULT_QUEUE_ID,
      runFor(sibling, 'driven'),
      unfencedCommit('test-fixture')
    );
    const leaf = await world.enqueue('the leaf');
    world.flags.driving = true;

    await endWorkflowLeaf(world.deps, target(leaf));

    expect(world.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('running');
    expect(world.queue.findById(sibling)?.status).toBe('in-flight');
    expect(world.queue.findById(leaf)?.status).toBe('canceled');
    expect(world.calls).toEqual([`audit:${leaf}:no-run`]);
  });

  it('stops only the child when the claim is lost, and writes nothing the winner owns', async () => {
    const world = await makeWorld();
    const taskId = await world.seedLeaf('driven', 'in-flight');
    world.flags.claimLost = true;
    world.flags.driving = true;

    await endWorkflowLeaf(world.deps, target(taskId));

    expect(world.calls).toEqual([`cancelActive:${DEFAULT_QUEUE_ID}`]);
    expect(world.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('running');
    expect(world.queue.findById(taskId)?.status).toBe('in-flight');
  });

  it("does not stop a sibling's child on a lost claim", async () => {
    const world = await makeWorld();
    const sibling = await world.enqueue('a sibling');
    await world.queue.markInFlight(sibling, `run-of-${sibling}`);
    await world.store.setRun(
      DEFAULT_QUEUE_ID,
      runFor(sibling, 'driven'),
      unfencedCommit('test-fixture')
    );
    const leaf = await world.enqueue('the leaf');
    world.flags.claimLost = true;

    await endWorkflowLeaf(world.deps, target(leaf));

    expect(world.calls).toEqual([]);
    expect(world.queue.findById(leaf)?.status).toBe('pending');
  });

  it('finishes the row when the Run moved first, and leaves the lease to whoever moved it', async () => {
    const world = await makeWorld();
    const taskId = await world.seedLeaf('backoff', 'in-flight');
    const deps: WorkflowLeafEndDeps = {
      ...world.deps,
      store: {
        getRun: (queueId) => world.store.getRun(queueId),
        runCommitClaim: (queueId) => world.store.runCommitClaim(queueId),
        updateRun: () =>
          Promise.reject(new QueueMutationRejected('stale-run-id', 'the Run moved first'))
      }
    };

    await endWorkflowLeaf(deps, target(taskId));

    expect(world.queue.findById(taskId)?.status).toBe('canceled');
    expect(world.calls.filter((call) => call.startsWith('release:'))).toEqual([]);
    expect(world.calls.filter((call) => call.startsWith('complete:'))).toEqual([]);
    expect(world.warn).not.toHaveBeenCalled();
  });

  it('never throws: a refused write is logged by reason, and the row stays for the next control', async () => {
    const world = await makeWorld();
    const taskId = await world.seedLeaf('backoff', 'in-flight');
    const deps: WorkflowLeafEndDeps = {
      ...world.deps,
      store: {
        getRun: (queueId) => world.store.getRun(queueId),
        runCommitClaim: (queueId) => world.store.runCommitClaim(queueId),
        updateRun: () =>
          Promise.reject(new QueueMutationRejected('ownership-lost', 'the claim was lost'))
      }
    };

    await expect(endWorkflowLeaf(deps, target(taskId))).resolves.toBeUndefined();

    expect(world.queue.findById(taskId)?.status).toBe('in-flight');
    expect(world.warn).toHaveBeenCalledTimes(1);
    expect(String(world.warn.mock.calls.at(0)?.at(0))).toContain('the claim was lost');
    expect(world.calls.filter((call) => call.startsWith('release:'))).toEqual([]);
  });

  it('says so when the queue refuses the row', async () => {
    const world = await makeWorld();
    const taskId = await world.enqueue('the leaf');
    const deps: WorkflowLeafEndDeps = {
      ...world.deps,
      queue: {
        findById: (id) => world.queue.findById(id),
        removeTask: (id) => world.queue.removeTask(id),
        finish: () => Promise.resolve({ ok: false, reason: 'illegal-source-status' })
      }
    };

    await endWorkflowLeaf(deps, target(taskId));

    expect(world.warn).toHaveBeenCalledTimes(1);
    expect(String(world.warn.mock.calls.at(0)?.at(0))).toContain('illegal-source-status');
  });
});
