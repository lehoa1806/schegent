// The hooks a Workflow control needs from this window, built from the controller and the
// store. Each is about one thing the control service cannot know on its own.

import { describe, expect, it, vi } from 'vitest';
import {
  createWorkflowLeafControlHooks,
  createWorkflowQueueWake,
  type WorkflowLeafControlDeps
} from '../../../../src/services/workflow-execution/workflow-leaf-control';
import type { ConnectedWorkflowRun } from '../../../../src/state/connected-workflow-run';
import type { ClaimTenure } from '../../../../src/state/execution-lease';

const QUEUE = 'q-main';
const LEAF_TASK = 'task-of-the-leaf';

function connectedRun(queueItemIds: readonly string[]): ConnectedWorkflowRun {
  return {
    connectedRunId: 'crun',
    nodes: {},
    invocations: {
      root: {
        attemptsByNodeId: {
          draft: queueItemIds.map((queueItemId) => ({ queueItemId }))
        }
      }
    }
  } as unknown as ConnectedWorkflowRun;
}

function makeHooks(overrides: { readonly currentTask?: string | null; readonly queues?: readonly string[] } = {}) {
  const controller = {
    cancelPendingRetry: vi.fn(),
    isDriving: vi.fn(() => false),
    drainQueuedWork: vi.fn(() => Promise.resolve())
  };
  const endLeaf = vi.fn((_queueId: string, _taskId: string) => Promise.resolve());
  const executionLease = {
    tenureOf: vi.fn((_queueId: string): ClaimTenure => ({ state: 'never-held' })),
    isForeignLeaseHeld: vi.fn((_queueId: string) => false)
  };
  const warn = vi.fn();
  const currentTask = overrides.currentTask === undefined ? LEAF_TASK : overrides.currentTask;
  const deps: WorkflowLeafControlDeps = {
    controller,
    endLeaf,
    executionLease,
    logger: { warn },
    store: {
      getRun: (queueId) =>
        currentTask === null || queueId !== QUEUE ? null : ({ featureId: currentTask } as never),
      getConnectedRun: (id) => (id === 'crun' ? connectedRun([LEAF_TASK]) : null),
      getQueueRegistry: () =>
        ({ entries: (overrides.queues ?? [QUEUE]).map((id) => ({ id })) }) as never
    }
  };
  return { hooks: createWorkflowLeafControlHooks(deps), controller, endLeaf, executionLease, warn };
}

const LEAF_INPUT = {
  runId: 'crun',
  queueId: QUEUE,
  invocationId: 'root',
  nodeId: 'draft',
  attemptId: 'root:draft:attempt-1'
};

describe('abortActiveLeaf', () => {
  it('ends the leaf the attempt names, on the queue the run is bound to', async () => {
    const { hooks, endLeaf } = makeHooks();

    await hooks.abortActiveLeaf({ ...LEAF_INPUT, queueItemId: LEAF_TASK });

    expect(endLeaf).toHaveBeenCalledWith(QUEUE, LEAF_TASK);
  });

  it('has nothing to end for an attempt that never got a queue row', async () => {
    const { hooks, endLeaf } = makeHooks();

    await hooks.abortActiveLeaf(LEAF_INPUT);

    expect(endLeaf).not.toHaveBeenCalled();
  });
});

describe('cancelRetryTimer', () => {
  it("cancels the timer when the queue's Run is a leaf of this Workflow run", () => {
    const { hooks, controller } = makeHooks();

    hooks.cancelRetryTimer(QUEUE, 'crun', 'root');

    expect(controller.cancelPendingRetry).toHaveBeenCalledWith(QUEUE);
  });

  it("leaves an unrelated Task's countdown alone", () => {
    const { hooks, controller } = makeHooks({ currentTask: 'someone-else' });

    hooks.cancelRetryTimer(QUEUE, 'crun', 'root');

    expect(controller.cancelPendingRetry).not.toHaveBeenCalled();
  });

  it('does nothing when the queue holds no Run, or the Workflow run is unknown', () => {
    const idle = makeHooks({ currentTask: null });
    idle.hooks.cancelRetryTimer(QUEUE, 'crun', 'root');
    expect(idle.controller.cancelPendingRetry).not.toHaveBeenCalled();

    const unknown = makeHooks();
    unknown.hooks.cancelRetryTimer(QUEUE, 'another-run', 'root');
    expect(unknown.controller.cancelPendingRetry).not.toHaveBeenCalled();
  });
});

describe('verifyLeaseFence', () => {
  it('passes a queue no rival took, including one that holds no lease between leaves', () => {
    const { hooks } = makeHooks();

    expect(hooks.verifyLeaseFence(QUEUE, 'crun')).toBe(true);
  });

  it('passes a queue this window holds, or gave back', () => {
    const { hooks, executionLease } = makeHooks();

    executionLease.tenureOf.mockReturnValue({ state: 'held', claim: {} as never });
    expect(hooks.verifyLeaseFence(QUEUE, 'crun')).toBe(true);

    executionLease.tenureOf.mockReturnValue({ state: 'released' });
    expect(hooks.verifyLeaseFence(QUEUE, 'crun')).toBe(true);
  });

  it('refuses a queue whose claim this window lost', () => {
    const { hooks, executionLease } = makeHooks();
    executionLease.tenureOf.mockReturnValue({
      state: 'lost',
      claim: {} as never,
      reason: 'superseded',
      lostAt: 0
    });

    expect(hooks.verifyLeaseFence(QUEUE, 'crun')).toBe(false);
    expect(executionLease.tenureOf).toHaveBeenCalledWith(QUEUE);
  });

  it('refuses a queue another window holds', () => {
    const { hooks, executionLease } = makeHooks();
    executionLease.isForeignLeaseHeld.mockReturnValue(true);

    expect(hooks.verifyLeaseFence(QUEUE, 'crun')).toBe(false);
    expect(executionLease.isForeignLeaseHeld).toHaveBeenCalledWith(QUEUE);
  });
});

describe('isQueuePresent', () => {
  it('reads the registry', () => {
    const { hooks } = makeHooks({ queues: [QUEUE] });

    expect(hooks.isQueuePresent(QUEUE)).toBe(true);
    expect(hooks.isQueuePresent('a-deleted-queue')).toBe(false);
  });
});

describe('createWorkflowQueueWake', () => {
  function makeWake() {
    const controller = {
      cancelPendingRetry: vi.fn(),
      isDriving: vi.fn(() => false),
      drainQueuedWork: vi.fn(() => Promise.resolve())
    };
    const warn = vi.fn();
    return { wake: createWorkflowQueueWake({ controller, logger: { warn } }), controller, warn };
  }

  it('offers the named queue its work', () => {
    const { wake, controller } = makeWake();

    wake(QUEUE);

    expect(controller.drainQueuedWork).toHaveBeenCalledTimes(1);
    expect(controller.drainQueuedWork).toHaveBeenCalledWith(QUEUE);
  });

  it('asks about the named queue, and leaves it to a driver on its way out', () => {
    const { wake, controller } = makeWake();
    controller.isDriving.mockReturnValue(true);

    wake(QUEUE);

    expect(controller.isDriving).toHaveBeenCalledWith(QUEUE);
    expect(controller.drainQueuedWork).not.toHaveBeenCalled();
  });

  it('logs a failed drain and never throws at the caller', async () => {
    const { wake, controller, warn } = makeWake();
    controller.drainQueuedWork.mockRejectedValue(new Error('drain refused'));

    expect(() => wake(QUEUE)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls.at(0)?.at(0))).toContain('drain refused');
  });
});

describe('releaseQueueLease', () => {
  it('releases nothing, and offers the queue its next Task once the Workflow has ended', async () => {
    const { hooks, controller } = makeHooks();

    await hooks.releaseQueueLease(QUEUE, 'crun');

    expect(controller.drainQueuedWork).toHaveBeenCalledWith(QUEUE);
  });

  it("leaves the wake to a driver still on its way out: its funnel owes one", async () => {
    const { hooks, controller } = makeHooks();
    controller.isDriving.mockReturnValue(true);

    await hooks.releaseQueueLease(QUEUE, 'crun');

    expect(controller.drainQueuedWork).not.toHaveBeenCalled();
  });

  it('logs a failed drain rather than failing the command that already committed', async () => {
    const { hooks, controller, warn } = makeHooks();
    controller.drainQueuedWork.mockRejectedValue(new Error('drain refused'));

    await hooks.releaseQueueLease(QUEUE, 'crun');
    await new Promise((resolve) => setImmediate(resolve));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls.at(0)?.at(0))).toContain('drain refused');
  });
});
