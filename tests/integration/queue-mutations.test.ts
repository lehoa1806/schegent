import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { MessageRouter } from '../../src/ui/sidebar/message-router';
import { SanitizedLogger } from '../../src/lib/logger';
import type { CommandAckMessage, SidebarCommand } from '../../src/ui/sidebar/messages';
import {
  CMD_RETRY_QUEUE_ITEM,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_QUEUE_ITEM_DOWN,
  CMD_PAUSE_QUEUE,
  CMD_RESUME_QUEUE,
  CMD_CLEAR_FAILED,
  CMD_CLEAR_COMPLETED,
  CMD_CREATE_QUEUE,
  CMD_RENAME_QUEUE,
  CMD_DELETE_QUEUE,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_MOVE_TASK
} from '../../src/ui/sidebar/messages';
import { DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import {
  appendAttempt,
  createConnectedRun,
  type ConnectedWorkflowRun
} from '../../src/state/connected-workflow-run';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import type { WorkflowRunPipeline } from '../../src/state/workflow-run';

class MockMemento implements Memento {
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

interface BuiltSystem {
  store: WorkspaceStateStore;
  queue: QueueManager;
  router: MessageRouter;
  acks: CommandAckMessage[];
  warnings: string[];
  postAck: (m: CommandAckMessage) => Promise<boolean>;
  isPrimary: { value: boolean };
}

async function build(): Promise<BuiltSystem> {
  const memento = new MockMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  const acks: CommandAckMessage[] = [];
  const warnings: string[] = [];
  const isPrimary = { value: true };
  const router = new MessageRouter({
    executeCommand: <T>(): Promise<T> => Promise.resolve(undefined as unknown as T),
    queueRemover: queue,
    queueOps: queue,
    isPrimary: () => isPrimary.value,
    isTrusted: () => true,
    notifyWarning: (m) => warnings.push(m),
    logger: new SanitizedLogger()
  });
  const postAck = async (m: CommandAckMessage): Promise<boolean> => {
    acks.push(m);
    return true;
  };
  return { store, queue, router, acks, warnings, postAck, isPrimary };
}

describe('Queue mutations integration (T044)', () => {
  let sys: BuiltSystem;

  beforeEach(async () => {
    sys = await build();
  });

  it('end-to-end: enqueue, fail, retry, reorder, pause, resume, clearFailed', async () => {
    const a = await sys.queue.enqueue('feature A — first');
    const b = await sys.queue.enqueue('feature B — second');
    const c = await sys.queue.enqueue('feature C — third');
    expect(sys.queue.list().map((r) => r.id)).toEqual([a.id, b.id, c.id]);

    // Mark A in-flight, fail it
    await sys.queue.markInFlight(a.id, 'run-A');
    await sys.queue.finish(a.id, 'failed', 'simulated stub failure');
    let aRow = sys.queue.findById(a.id);
    expect(aRow?.status).toBe('failed');
    expect(aRow?.lastError).toBe('simulated stub failure');

    // Retry A via router
    await sys.router.dispatch(
      { type: CMD_RETRY_QUEUE_ITEM, correlationId: 'r1', payload: { id: a.id } },
      sys.postAck
    );
    expect(sys.acks.at(-1)?.status).toBe('accepted');
    aRow = sys.queue.findById(a.id);
    expect(aRow?.status).toBe('pending');
    expect(aRow?.retryCount).toBe(1);
    expect(aRow?.lastError).toBeNull();
    // A must be at head of pending (no in-flight, so position 0)
    expect(sys.queue.list()[0].id).toBe(a.id);

    // Reorder: move B up (B is at position 1, A at 0). After Feature 030
    // (US2) the up/down handlers route through `reorderTaskInUnifiedQueue`,
    // which mutates the `position` field rather than the underlying array
    // order. Operators see the queue sorted by `position` everywhere, so
    // assertions compare the position-sorted view.
    await sys.router.dispatch(
      { type: CMD_MOVE_QUEUE_ITEM_UP, correlationId: 'mu1', payload: { id: b.id } },
      sys.postAck
    );
    expect(sys.acks.at(-1)?.status).toBe('accepted');
    const sortedAfterMoveUp = sys.queue
      .list()
      .slice()
      .sort((x, y) => x.position - y.position);
    expect(sortedAfterMoveUp.map((r) => r.id)).toEqual([b.id, a.id, c.id]);
    expect(sortedAfterMoveUp.map((r) => r.position)).toEqual([0, 1, 2]);

    // Move A down (A was at position 1 after the previous moveUp; moving
    // down swaps with C and produces [b, c, a] by position).
    await sys.router.dispatch(
      { type: CMD_MOVE_QUEUE_ITEM_DOWN, correlationId: 'md1', payload: { id: a.id } },
      sys.postAck
    );
    const sortedAfterMoveDown = sys.queue
      .list()
      .slice()
      .sort((x, y) => x.position - y.position);
    expect(sortedAfterMoveDown.map((r) => r.id)).toEqual([b.id, c.id, a.id]);

    // Pause queue via router
    await sys.router.dispatch(
      { type: CMD_PAUSE_QUEUE, correlationId: 'pq1' },
      sys.postAck
    );
    expect(sys.acks.at(-1)?.status).toBe('accepted');
    expect(sys.store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(true);

    // Mark B in-flight then finish completed (in-flight isn't started by router; the controller
    // would orchestrate this; for the contract, we just verify pause does NOT mutate inFlightId)
    await sys.queue.markInFlight(b.id, 'run-B');
    await sys.queue.finish(b.id, 'completed');
    expect(sys.store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(true); // still paused

    // Resume queue
    await sys.router.dispatch(
      { type: CMD_RESUME_QUEUE, correlationId: 'rq1' },
      sys.postAck
    );
    expect(sys.acks.at(-1)?.status).toBe('accepted');
    expect(sys.store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(false);

    // Fail C, then clearFailed
    await sys.queue.markInFlight(c.id, 'run-C');
    await sys.queue.finish(c.id, 'failed', 'oops');
    await sys.router.dispatch({ type: CMD_CLEAR_FAILED, correlationId: 'cf1' }, sys.postAck);
    expect(sys.acks.at(-1)?.status).toBe('accepted');
    const remainingIds = sys.queue.list().map((r) => r.id);
    expect(remainingIds).not.toContain(c.id);

    // clearCompleted removes B
    await sys.router.dispatch({ type: CMD_CLEAR_COMPLETED, correlationId: 'cc1' }, sys.postAck);
    expect(sys.acks.at(-1)?.status).toBe('accepted');
    expect(sys.queue.list().map((r) => r.id)).toEqual([a.id]);
  });

  it('rejects mutations on secondary window with reason secondary-window-readonly', async () => {
    sys.isPrimary.value = false;
    const a = await sys.queue.enqueue('feature A');
    await sys.router.dispatch(
      { type: CMD_RETRY_QUEUE_ITEM, correlationId: 'sec1', payload: { id: a.id } },
      sys.postAck
    );
    expect(sys.acks.at(-1)?.status).toBe('rejected');
    expect(sys.acks.at(-1)?.reason).toBe('secondary-window-readonly');
    // queue state unchanged
    expect(sys.queue.findById(a.id)?.retryCount).toBe(0);
  });

  it('illegal-state retry of completed item: notifies + rejects, no exception', async () => {
    const a = await sys.queue.enqueue('feature A');
    await sys.queue.markInFlight(a.id, 'run-A');
    await sys.queue.finish(a.id, 'completed');
    await expect(
      sys.router.dispatch(
        { type: CMD_RETRY_QUEUE_ITEM, correlationId: 'illeg1', payload: { id: a.id } },
        sys.postAck
      )
    ).resolves.toBeUndefined();
    expect(sys.acks.at(-1)?.status).toBe('rejected');
    expect(sys.acks.at(-1)?.reason).toBe('illegal-state');
    expect(sys.warnings.length).toBe(1);
  });

  it('moveUp at the head of pending surfaces structured rejection', async () => {
    const a = await sys.queue.enqueue('feature A');
    const b = await sys.queue.enqueue('feature B');
    void b;
    // A is at index 0, can't move up further. Feature 030 (US2, T032)
    // unified the arrow + drag handlers; the canonical rejection cause
    // for an out-of-range new position is `invalid-position`, replacing
    // the legacy `at-edge` token.
    await sys.router.dispatch(
      { type: CMD_MOVE_QUEUE_ITEM_UP, correlationId: 'mu-edge', payload: { id: a.id } },
      sys.postAck
    );
    expect(sys.acks.at(-1)?.status).toBe('rejected');
    expect(sys.acks.at(-1)?.reason).toBe('invalid-position');
    expect(sys.warnings.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Feature 092 (US1) — the seven queue commands feature 030 removed.
// ---------------------------------------------------------------------------

/** The last ack's `result`, typed for the assertions that read into it. */
function lastResult<T>(sys: BuiltSystem): T {
  return sys.acks.at(-1)?.result as T;
}

async function createQueue(sys: BuiltSystem, name: string): Promise<string> {
  await sys.router.dispatch(
    { type: CMD_CREATE_QUEUE, correlationId: `create-${name}`, payload: { name } },
    sys.postAck
  );
  expect(sys.acks.at(-1)?.status, `create ${name}`).toBe('accepted');
  return lastResult<{ queueId: string }>(sys).queueId;
}

function graph(): WorkflowDefinition {
  return {
    workflowId: 'wf-triage',
    name: 'Triage',
    version: 1,
    nodes: [{ nodeId: 'n-triage', pipelineId: 'p-triage' }],
    connections: [],
    startNodeIds: ['n-triage']
  };
}

function pipelines(): Record<string, WorkflowRunPipeline> {
  return {
    'p-triage': { id: 'p-triage', name: 'Triage', phases: [{ id: 'specify', name: 'Specify' }] }
  };
}

/**
 * A connected run bound to `queueId`, holding `taskId` as the child of its only
 * node's attempt.
 *
 * Feature 092 (T077, FR-041) — the binding is now a declared field, so it is
 * supplied rather than inferred from the child. Which of the two the deletion
 * impact reads is the point of the between-nodes case below: a run's children
 * come and go, its binding does not.
 */
function connectedRunOwning(
  taskId: string,
  connectedRunId: string,
  queueId: string
): ConnectedWorkflowRun {
  return appendAttempt(
    createConnectedRun({
      connectedRunId,
      workflowId: 'wf-triage',
      graph: graph(),
      pipelines: pipelines(),
      startedAt: 1_000,
      queueId
    }),
    'n-triage',
    { queueItemId: taskId, startedAt: 1_001 }
  );
}

describe('reinstated queue commands are refused in a secondary window (T013b, FR-021)', () => {
  it('rejects all five with secondary-window-readonly and writes nothing', async () => {
    const sys = await build();
    const target = await createQueue(sys, 'Docs');
    const task = await sys.queue.enqueue('feature A');
    const registryBefore = JSON.stringify(sys.store.getQueueRegistry());

    sys.isPrimary.value = false;

    // The gate is registration in `MUTATING_COMMANDS`, and only two of the
    // five names match a `mutating-command-name-gate` verb pattern. This
    // exercises all five behaviourally so the three the lint cannot see
    // (`CREATE`, `RENAME`, `DELETE`) are covered by something.
    const commands: SidebarCommand[] = [
      { type: CMD_CREATE_QUEUE, correlationId: 's1', payload: { name: 'Nope' } },
      { type: CMD_RENAME_QUEUE, correlationId: 's2', payload: { queueId: target, name: 'Nope' } },
      { type: CMD_DELETE_QUEUE, correlationId: 's3', payload: { queueId: target, confirmed: true } },
      {
        type: CMD_SAVE_QUEUE_SETTINGS,
        correlationId: 's4',
        payload: { globalConcurrencyCap: 3, defaultQueueId: DEFAULT_QUEUE_ID }
      },
      {
        type: CMD_MOVE_TASK,
        correlationId: 's7',
        payload: { taskId: task.id, targetQueueId: target }
      }
    ];

    for (const command of commands) {
      await sys.router.dispatch(command, sys.postAck);
      expect(sys.acks.at(-1)?.status, command.type).toBe('rejected');
      expect(sys.acks.at(-1)?.reason, command.type).toBe('secondary-window-readonly');
    }

    expect(JSON.stringify(sys.store.getQueueRegistry())).toBe(registryBefore);
    expect(sys.queue.findById(task.id)?.queueId).toBe(DEFAULT_QUEUE_ID);
  });
});

describe('queue deletion refusals are ordered (T014, FR-004, FR-014 – FR-016a)', () => {
  it('refuses the default queue first, before any in-flight or impact check', async () => {
    const sys = await build();
    // The default queue also holds an in-flight Task, so a handler that
    // checked in-flight first would answer with the wrong reason.
    const task = await sys.queue.enqueue('feature A');
    await sys.queue.markInFlight(task.id, 'run-A');

    await sys.router.dispatch(
      {
        type: CMD_DELETE_QUEUE,
        correlationId: 'd1',
        payload: { queueId: DEFAULT_QUEUE_ID, confirmed: true }
      },
      sys.postAck
    );

    expect(sys.acks.at(-1)?.status).toBe('rejected');
    expect(sys.acks.at(-1)?.reason).toBe('default-queue-undeletable');
    expect(sys.store.getQueueRegistry().entries.map((e) => e.id)).toContain(DEFAULT_QUEUE_ID);
  });

  it('refuses an in-flight queue second, ahead of the confirmation gate', async () => {
    const sys = await build();
    const target = await createQueue(sys, 'Docs');
    const task = await sys.queue.enqueue('feature A', { queueId: target });
    await sys.queue.markInFlight(task.id, 'run-A');

    // `confirmed: true` supplied: the in-flight refusal is not a confirmation
    // prompt the operator can answer past.
    await sys.router.dispatch(
      { type: CMD_DELETE_QUEUE, correlationId: 'd2', payload: { queueId: target, confirmed: true } },
      sys.postAck
    );

    expect(sys.acks.at(-1)?.status).toBe('rejected');
    expect(sys.acks.at(-1)?.reason).toBe('queue-has-in-flight-task');
    expect(sys.store.getQueueRegistry().entries.map((e) => e.id)).toContain(target);
  });

  it('asks for confirmation naming the pending count and each bound connected run', async () => {
    const sys = await build();
    const target = await createQueue(sys, 'Docs');
    const first = await sys.queue.enqueue('feature A', { queueId: target });
    await sys.queue.enqueue('feature B', { queueId: target });
    const bound = connectedRunOwning(first.id, 'cr-1', target);
    expect((await sys.store.compareAndSetConnectedRun(bound, 0)).outcome).toBe('written');

    await sys.router.dispatch(
      { type: CMD_DELETE_QUEUE, correlationId: 'd3', payload: { queueId: target } },
      sys.postAck
    );

    expect(sys.acks.at(-1)?.status).toBe('rejected');
    expect(sys.acks.at(-1)?.reason).toBe('confirmation-required');
    expect(
      lastResult<{
        queueId: string;
        pendingTaskCount: number;
        boundConnectedRunIds: readonly string[];
      }>(sys)
    ).toEqual({ queueId: target, pendingTaskCount: 2, boundConnectedRunIds: ['cr-1'] });
    // Nothing was discarded by the prompt itself.
    expect(sys.store.getRequestsForQueue(target)).toHaveLength(2);
  });

  it('deletes on confirmation, dropping execution state and compacting positions', async () => {
    const sys = await build();
    const target = await createQueue(sys, 'Docs');
    const survivor = await createQueue(sys, 'Research');
    await sys.queue.enqueue('feature A', { queueId: target });
    expect(sys.store.hasQueueState(target)).toBe(true);
    const survivorPositionBefore = sys.store
      .getQueueRegistry()
      .entries.find((e) => e.id === survivor)?.position;
    expect(survivorPositionBefore).toBe(2);

    await sys.router.dispatch(
      { type: CMD_DELETE_QUEUE, correlationId: 'd4', payload: { queueId: target, confirmed: true } },
      sys.postAck
    );

    expect(sys.acks.at(-1)?.status).toBe('accepted');
    const entries = sys.store.getQueueRegistry().entries;
    expect(entries.map((e) => e.id)).toEqual([DEFAULT_QUEUE_ID, survivor]);
    expect(entries.map((e) => e.position)).toEqual([0, 1]);
    expect(sys.store.hasQueueState(target)).toBe(false);
    // The registry is the authority on existence, so a read against the
    // deleted id is a refusal rather than an empty list.
    expect(() => sys.store.getRequestsForQueue(target)).toThrow(/unknown-queue-id|Unknown queue id/);
  });
});

describe('deleting a queue that holds a between-nodes connected run (T077, FR-016a, US3 scenario 5)', () => {
  /**
   * A run bound to `queueId` that is BETWEEN nodes: its first child has
   * finished and left the queue, and no successor has been started.
   *
   * This is the case a Task-scan oracle misses. Nothing the queue holds points
   * at this run, so deriving the impact from the queue's rows would report the
   * queue as free of connected runs and delete it out from under one.
   */
  function betweenNodes(connectedRunId: string, queueId: string): ConnectedWorkflowRun {
    return connectedRunOwning('task-already-gone', connectedRunId, queueId);
  }

  it('names the between-nodes run in the impact even though the queue holds no task for it', async () => {
    const sys = await build();
    const target = await createQueue(sys, 'Docs');
    const run = betweenNodes('cr-between', target);
    expect((await sys.store.compareAndSetConnectedRun(run, 0)).outcome).toBe('written');
    expect(sys.store.getRequestsForQueue(target)).toHaveLength(0);

    await sys.router.dispatch(
      { type: CMD_DELETE_QUEUE, correlationId: 'b1', payload: { queueId: target } },
      sys.postAck
    );

    expect(sys.acks.at(-1)?.status).toBe('rejected');
    expect(sys.acks.at(-1)?.reason).toBe('confirmation-required');
    expect(
      lastResult<{
        queueId: string;
        pendingTaskCount: number;
        boundConnectedRunIds: readonly string[];
      }>(sys)
    ).toEqual({ queueId: target, pendingTaskCount: 0, boundConnectedRunIds: ['cr-between'] });
  });

  it('terminates the bound run on confirmation rather than rebinding it', async () => {
    const sys = await build();
    const target = await createQueue(sys, 'Docs');
    const survivor = await createQueue(sys, 'Research');
    expect(
      (await sys.store.compareAndSetConnectedRun(betweenNodes('cr-between', target), 0)).outcome
    ).toBe('written');
    // A second run, bound elsewhere, to prove the termination is scoped.
    expect(
      (await sys.store.compareAndSetConnectedRun(betweenNodes('cr-other', survivor), 0)).outcome
    ).toBe('written');

    await sys.router.dispatch(
      { type: CMD_DELETE_QUEUE, correlationId: 'b2', payload: { queueId: target, confirmed: true } },
      sys.postAck
    );

    expect(sys.acks.at(-1)?.status).toBe('accepted');
    // Terminated: the record is gone. Not rebound: it did not reappear under
    // the default queue or under the surviving one.
    expect(sys.store.getConnectedRun('cr-between')).toBeNull();
    expect(sys.store.getConnectedRun('cr-other')?.queueId).toBe(survivor);
  });

  it('leaves no aggregate pointing at a queue that no longer exists', async () => {
    const sys = await build();
    const target = await createQueue(sys, 'Docs');
    const pending = await sys.queue.enqueue('feature A', { queueId: target });
    // Two runs bound to the doomed queue: one mid-node, one between nodes.
    expect(
      (await sys.store.compareAndSetConnectedRun(
        connectedRunOwning(pending.id, 'cr-mid', target),
        0
      )).outcome
    ).toBe('written');
    expect(
      (await sys.store.compareAndSetConnectedRun(betweenNodes('cr-between', target), 0)).outcome
    ).toBe('written');

    await sys.router.dispatch(
      { type: CMD_DELETE_QUEUE, correlationId: 'b3', payload: { queueId: target, confirmed: true } },
      sys.postAck
    );

    expect(sys.acks.at(-1)?.status).toBe('accepted');
    const liveQueueIds = new Set(sys.store.getQueueRegistry().entries.map((entry) => entry.id));
    for (const run of Object.values(sys.store.getConnectedRuns())) {
      expect(liveQueueIds.has(run.queueId ?? DEFAULT_QUEUE_ID), run.connectedRunId).toBe(true);
    }
    expect(Object.values(sys.store.getConnectedRuns()).map((run) => run.connectedRunId)).toEqual(
      []
    );
  });
});

describe('tasks move between queues (T015, FR-017, FR-042)', () => {
  it('preserves description, ordering and the frozen run plan across the move', async () => {
    const sys = await build();
    const target = await createQueue(sys, 'Docs');
    const runPlan = {
      pipeline: pipelines()['p-triage'],
      inputs: [],
      supplemental: [],
      outputs: [],
      frozenAt: 1_700_000_000_000
    };
    await sys.queue.enqueue('feature A', { queueId: target });
    const moved = await sys.queue.enqueue('feature B — carries a frozen plan', { runPlan });

    await sys.router.dispatch(
      {
        type: CMD_MOVE_TASK,
        correlationId: 'mt1',
        payload: { taskId: moved.id, targetQueueId: target, position: 0 }
      },
      sys.postAck
    );

    expect(sys.acks.at(-1)?.status).toBe('accepted');
    const after = sys.queue.findById(moved.id);
    expect(after?.queueId).toBe(target);
    expect(after?.description).toBe('feature B — carries a frozen plan');
    expect(after?.status).toBe('pending');
    expect(after?.runPlan).toEqual(runPlan);
    // Inserted at the head; the incumbent shifted down rather than being
    // overwritten, and the source queue no longer lists it.
    const targetOrder = sys.store
      .getRequestsForQueue(target)
      .slice()
      .sort((a, b) => a.position - b.position);
    expect(targetOrder.map((r) => r.description)).toEqual([
      'feature B — carries a frozen plan',
      'feature A'
    ]);
    expect(targetOrder.map((r) => r.position)).toEqual([0, 1]);
    expect(sys.store.getRequestsForQueue(DEFAULT_QUEUE_ID)).toEqual([]);
  });

  it('refuses to move a Task that is the child of a connected run', async () => {
    const sys = await build();
    const target = await createQueue(sys, 'Docs');
    const child = await sys.queue.enqueue('child of a connected run');
    const bound = connectedRunOwning(child.id, 'cr-1', DEFAULT_QUEUE_ID);
    expect((await sys.store.compareAndSetConnectedRun(bound, 0)).outcome).toBe('written');

    await sys.router.dispatch(
      {
        type: CMD_MOVE_TASK,
        correlationId: 'mt2',
        payload: { taskId: child.id, targetQueueId: target }
      },
      sys.postAck
    );

    expect(sys.acks.at(-1)?.status).toBe('rejected');
    expect(sys.acks.at(-1)?.reason).toBe('task-bound-to-connected-run');
    expect(sys.queue.findById(child.id)?.queueId).toBe(DEFAULT_QUEUE_ID);
  });
});
