import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { createQueue } from '../../../src/queue/queue-registry';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import {
  appendAttempt,
  createConnectedRun
} from '../../../src/state/connected-workflow-run';
import type { Memento } from '../../../src/state/workspace-state';

class FakeMemento implements Memento {
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

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
});

describe('QueueManager.enqueue', () => {
  it('appends a pending request and assigns position', async () => {
    const a = await queue.enqueue('feature A');
    const b = await queue.enqueue('feature B');
    expect(a.position).toBe(0);
    expect(b.position).toBe(1);
    expect(queue.list()).toHaveLength(2);
    expect(a.status).toBe('pending');
  });

  it('rejects empty descriptions', async () => {
    await expect(queue.enqueue('   ')).rejects.toThrow(/non-empty/);
  });

  it('rejects descriptions exceeding the cap', async () => {
    const huge = 'x'.repeat(33_000);
    await expect(queue.enqueue(huge)).rejects.toThrow(/exceeds/);
  });

  it('persists pipelineId when supplied via options (T033, T040, US2)', async () => {
    const a = await queue.enqueue('feature A', { pipelineId: 'security' });
    expect(a.pipelineId).toBe('security');
    expect(queue.findById(a.id)?.pipelineId).toBe('security');
  });

  it('omits pipelineId when no options are provided (T033, US2)', async () => {
    const a = await queue.enqueue('feature A');
    expect(a.pipelineId).toBeUndefined();
    expect(queue.findById(a.id)?.pipelineId).toBeUndefined();
  });

  it('omits pipelineId when options.pipelineId is undefined (T033, US2)', async () => {
    const a = await queue.enqueue('feature A', { pipelineId: undefined });
    expect(a.pipelineId).toBeUndefined();
  });
});

describe('QueueManager.peekNextPending', () => {
  it('returns the first pending request', async () => {
    const a = await queue.enqueue('A');
    await queue.enqueue('B');
    expect(queue.peekNextPending()?.id).toBe(a.id);
  });

  it('skips in-flight and completed requests', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    await queue.markInFlight(a.id, 'run-1');
    expect(queue.peekNextPending()?.id).toBe(b.id);
  });

  it('returns null when nothing is pending', async () => {
    expect(queue.peekNextPending()).toBeNull();
  });
});

describe('QueueManager.markInFlight', () => {
  it('sets request status to in-flight and records runId', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    const found = queue.findById(a.id)!;
    expect(found.status).toBe('in-flight');
    expect(found.runId).toBe('run-1');
    expect(queue.hasInFlight()).toBe(true);
  });

  it('throws when another request is already in-flight', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    await queue.markInFlight(a.id, 'run-1');
    await expect(queue.markInFlight(b.id, 'run-2')).rejects.toThrow(/already in flight/);
  });

  it('is idempotent for the same featureId', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await expect(queue.markInFlight(a.id, 'run-1')).resolves.toBeUndefined();
  });
});

describe('QueueManager.finish', () => {
  it('clears in-flight when finishing the active request', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    expect(queue.hasInFlight()).toBe(false);
    expect(queue.findById(a.id)?.status).toBe('completed');
  });

  it('preserves in-flight when finishing a non-active request', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(b.id, 'canceled');
    expect(queue.hasInFlight()).toBe(true);
  });
});

describe('QueueManager.cancel', () => {
  it('cancels a pending request and returns true', async () => {
    const a = await queue.enqueue('A');
    expect(await queue.cancel(a.id)).toBe(true);
    expect(queue.findById(a.id)?.status).toBe('canceled');
  });

  it('refuses to cancel an in-flight request', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    expect(await queue.cancel(a.id)).toBe(false);
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  it('returns false for unknown id', async () => {
    expect(await queue.cancel('unknown')).toBe(false);
  });
});

describe('QueueManager.setQueuePausedState', () => {
  it('toggles the paused flag', async () => {
    await queue.setQueuePausedState(true);
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(true);
    await queue.setQueuePausedState(false);
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(false);
  });

  it('is a no-op when state already matches', async () => {
    await queue.enqueue('feature A');
    await queue.setQueuePausedState(true);
    const before = store.getQueue(DEFAULT_QUEUE_ID).updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await queue.setQueuePausedState(true);
    expect(store.getQueue(DEFAULT_QUEUE_ID).updatedAt).toBe(before);
  });
});

describe('QueueManager.findById', () => {
  it('returns the matching request', async () => {
    const a = await queue.enqueue('A');
    expect(queue.findById(a.id)?.id).toBe(a.id);
  });

  it('returns null for unknown id', () => {
    expect(queue.findById('missing')).toBeNull();
  });
});

describe('QueueManager.remove', () => {
  it('removes a pending request entirely and renumbers positions', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    const c = await queue.enqueue('C');
    expect(await queue.remove(b.id)).toBe(true);
    const remaining = queue.list();
    expect(remaining.map((r) => r.id)).toEqual([a.id, c.id]);
    expect(remaining[0].position).toBe(0);
    expect(remaining[1].position).toBe(1);
  });

  it('returns false and is a no-op for in-flight items', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    expect(await queue.remove(a.id)).toBe(false);
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  it('returns false for unknown id', async () => {
    expect(await queue.remove('missing')).toBe(false);
  });

  it('returns false for completed or canceled items', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    expect(await queue.remove(a.id)).toBe(false);
    expect(queue.findById(a.id)?.status).toBe('completed');
  });
});

// BUG-002 (T118) — `removeTask` is the audit-aware sibling of `remove`.
// Returns the canonical `{ ok, reason?, queueId? }` mutation detail so
// the router can audit `task-removed` with `queueId` and differentiate
// rejection causes between `unknown-task-id` and `task-not-in-pending-state`.
describe('QueueManager.removeTask (BUG-002 T118)', () => {
  it('returns ok with queueId and compacts positions for a pending task', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    const c = await queue.enqueue('C');
    const result = await queue.removeTask(b.id);
    expect(result.ok).toBe(true);
    expect(result.queueId).toBe(DEFAULT_QUEUE_ID);
    const remaining = queue.list();
    expect(remaining.map((r) => r.id)).toEqual([a.id, c.id]);
    expect(remaining[0].position).toBe(0);
    expect(remaining[1].position).toBe(1);
  });

  it('returns unknown-task-id for a missing id', async () => {
    const result = await queue.removeTask('missing');
    expect(result).toEqual({ ok: false, reason: 'unknown-task-id' });
  });

  it('removes an in-flight task and reports prior status', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    const result = await queue.removeTask(a.id);
    expect(result).toMatchObject({ ok: true, priorStatus: 'in-flight', runId: 'run-1' });
    expect(queue.findById(a.id)).toBeNull();
  });

  it('removes a completed task and reports prior status', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    const result = await queue.removeTask(a.id);
    expect(result).toMatchObject({ ok: true, priorStatus: 'completed', runId: 'run-1' });
    expect(queue.findById(a.id)).toBeNull();
  });

  // Feature 030 (US3, T046) — the "resolves queueId from the task before
  // removal" case was deleted. It relied on `queue.createNamedQueue()` to
  // build a secondary queue and then asserted the removal payload carried
  // that non-default queueId. With the v5 → v6 migration the registry is
  // constrained to exactly one entry (`id === 'default'`) and the
  // multi-queue management surface is gone, so the audit path always
  // resolves `queueId: 'default'` and there is no second queue to test.
});

describe('QueueManager.moveTask (Feature 092 T028, FR-017)', () => {
  const OTHER_QUEUE_ID = '5ec04d00-2222-4333-8444-555555555555';

  async function addOtherQueue(): Promise<void> {
    await store.setQueueRegistry(
      createQueue(store.getQueueRegistry(), {
        id: OTHER_QUEUE_ID,
        name: 'Other',
        now: 1_700_000_000_000
      })
    );
  }

  it('re-files a pending task onto another queue', async () => {
    await addOtherQueue();
    const task = await queue.enqueue('re-file me');

    const result = await queue.moveTask(task.id, OTHER_QUEUE_ID);

    expect(result).toMatchObject({ ok: true, taskId: task.id, queueId: OTHER_QUEUE_ID });
    expect(store.getQueue(OTHER_QUEUE_ID).requests.map((request) => request.id)).toEqual([task.id]);
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toEqual([]);
  });

  it('refuses to move a task that a connected Workflow run owns (FR-042)', async () => {
    // The one refusal this layer owns rather than delegating: a child Task's
    // queue is fixed by its aggregate's binding, so moving it alone would put
    // the child on a queue the aggregate is not bound to.
    await addOtherQueue();
    const task = await queue.enqueue('child of a workflow');
    // Built and written through the production constructors, so the record has
    // to satisfy the same invariants a real aggregate does.
    const written = await store.compareAndSetConnectedRun(
      appendAttempt(
        createConnectedRun({
          connectedRunId: 'connected-1',
          workflowId: 'wf-1',
          graph: {
            workflowId: 'wf-1',
            name: 'Release',
            version: 1,
            nodes: [{ nodeId: 'n-a', pipelineId: 'p-a' }],
            connections: [],
            startNodeIds: ['n-a']
          },
          pipelines: { 'p-a': { id: 'p-a', name: 'A', phases: [{ id: 'done', name: 'Done' }] } },
          startedAt: 1_700_000_000_000
        }),
        'n-a',
        { queueItemId: task.id, startedAt: 1_700_000_000_001 }
      ),
      0
    );
    // Guard the fixture: a record the migrator drops would make the refusal
    // below pass for the wrong reason.
    expect(written.outcome).toBe('written');
    expect(Object.keys(store.getConnectedRuns())).toEqual(['connected-1']);

    const result = await queue.moveTask(task.id, OTHER_QUEUE_ID);

    expect(result).toMatchObject({ ok: false, reason: 'task-bound-to-connected-run' });
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests.map((request) => request.id)).toEqual([
      task.id
    ]);
  });

  it('reports the store’s refusals as reasons rather than throwing', async () => {
    await addOtherQueue();
    const running = await queue.enqueue('already started');
    await queue.markInFlight(running.id, 'run-1');

    await expect(queue.moveTask(running.id, OTHER_QUEUE_ID)).resolves.toMatchObject({
      ok: false,
      reason: 'task-not-in-pending-state'
    });
    await expect(queue.moveTask('no-such-task', OTHER_QUEUE_ID)).resolves.toMatchObject({
      ok: false,
      reason: 'unknown-task-id'
    });
  });
});

describe('QueueManager.markInFlight extended fields', () => {
  it('sets startedAt and updatedAt', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    const found = queue.findById(a.id)!;
    expect(found.startedAt).not.toBeNull();
    expect(found.updatedAt).toBeGreaterThanOrEqual(found.enqueuedAt);
  });
});

describe('QueueManager.finish extended fields', () => {
  it('records lastError on failure', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'failed', 'boom');
    expect(queue.findById(a.id)?.lastError).toBe('boom');
    expect(queue.findById(a.id)?.completedAt).not.toBeNull();
  });

  it('does not record lastError on completed', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    expect(queue.findById(a.id)?.lastError).toBeNull();
  });
});

describe('QueueManager.setQueuePausedState extended', () => {
  it('records pausedReason', async () => {
    await queue.setQueuePausedState(true, undefined, 'credit-recovery');
    expect(store.getQueue(DEFAULT_QUEUE_ID).pausedReason).toBe('credit-recovery');
    await queue.setQueuePausedState(false, undefined, null);
    expect(store.getQueue(DEFAULT_QUEUE_ID).pausedReason).toBeNull();
  });
});

describe('QueueManager.setQueuePausedState BUG-001 self-heal', () => {
  it('resume clears a stale legacy paused=true, which now reads as one paused queue', async () => {
    // BUG-001 was a divergent state: the legacy boolean stuck `true` (from a
    // pre-fix retry-cap-exhausted write) while the registry entry read
    // 'active', so the dispatcher and the submit gate disagreed about whether
    // work could start. FR-R3-011 removed the divergence rather than the
    // symptom — the registry no longer stores a pause at all, it projects one
    // from this queue record — so the half of the original scenario that set
    // the two sides against each other is unrepresentable, and this test now
    // asserts what is left of it:
    //
    //   the legacy boolean is lifted to `operator-paused` on read,
    //   the projection agrees because it is derived from that same read, and
    //   resume visibly succeeds and clears it.
    //
    // Keeping the legacy write is the point: an operator's disk still holds
    // records in that shape, and resume has to work on them.
    //
    // The record is seeded and then *reopened*, because the lift happens at
    // activation. `getQueue` normalises a record that has no `queueLifecycle`
    // at all, but it will not overrule one that disagrees with the mirror —
    // resolving that disagreement is `migrateV12ToV13()`'s job and it runs
    // once, in `initialize()`. Writing the legacy pair mid-session and reading
    // it back would test a path no workspace takes.
    const memento = new FakeMemento();
    const seedStore = new WorkspaceStateStore(memento);
    await seedStore.initialize();
    const initialQueue = seedStore.getQueue(DEFAULT_QUEUE_ID);
    await memento.update('schegent.queue', {
      [DEFAULT_QUEUE_ID]: {
        ...initialQueue,
        paused: true,
        pausedReason: 'retry-cap-exhausted:r-old'
      }
    });

    const store = new WorkspaceStateStore(memento);
    await store.initialize();
    const queue = new QueueManager(store);

    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(true);
    expect(store.getProjectedQueueRegistry().entries[0]?.state).toBe('manually-paused');

    const result = await queue.setQueuePausedState(false, undefined, null, 'operator');

    expect(result.ok).toBe(true);
    expect(result.queueId).toBe(DEFAULT_QUEUE_ID);
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(false);
    expect(store.getQueue(DEFAULT_QUEUE_ID).pausedReason).toBeNull();
    expect(store.getProjectedQueueRegistry().entries[0]?.state).toBe('active');
  });

  it('returns not-paused when both legacy and registry are already consistent-active', async () => {
    const result = await queue.setQueuePausedState(false, undefined, null, 'operator');
    expect(result).toEqual({ ok: false, reason: 'not-paused' });
  });
});

describe('QueueManager.retry', () => {
  it('rejects unknown id', async () => {
    expect(await queue.retry('missing')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('rejects pending', async () => {
    const a = await queue.enqueue('A');
    expect(await queue.retry(a.id)).toEqual({ ok: false, reason: 'illegal-state' });
  });

  it('rejects in-flight', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    expect(await queue.retry(a.id)).toEqual({ ok: false, reason: 'illegal-state' });
  });

  it('accepts failed and resets to pending with retryCount++', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'failed', 'boom');
    expect(queue.findById(a.id)?.retryCount).toBe(0);
    const result = await queue.retry(a.id);
    expect(result.ok).toBe(true);
    const reset = queue.findById(a.id)!;
    expect(reset.status).toBe('pending');
    expect(reset.retryCount).toBe(1);
    expect(reset.lastError).toBeNull();
    expect(reset.completedAt).toBeNull();
    expect(reset.runId).toBeNull();
  });

  it('accepts canceled', async () => {
    const a = await queue.enqueue('A');
    await queue.cancel(a.id);
    expect((await queue.retry(a.id)).ok).toBe(true);
    expect(queue.findById(a.id)?.status).toBe('pending');
  });

  it('places retried item at head of pending region (after in-flight)', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    const c = await queue.enqueue('C');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'failed', 'boom');
    await queue.retry(a.id);
    const positions = queue.list().map((r) => ({ id: r.id, position: r.position }));
    expect(positions.find((p) => p.id === a.id)!.position).toBe(0);
    expect(positions.find((p) => p.id === b.id)!.position).toBe(1);
    expect(positions.find((p) => p.id === c.id)!.position).toBe(2);
  });
});

describe('QueueManager.moveUp / moveDown', () => {
  it('rejects unknown id', async () => {
    expect(await queue.moveUp('missing')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('rejects non-pending', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    expect(await queue.moveUp(a.id)).toEqual({ ok: false, reason: 'illegal-state' });
  });

  it('rejects when no peer pending exists', async () => {
    const a = await queue.enqueue('A');
    expect(await queue.moveUp(a.id)).toEqual({ ok: false, reason: 'no-peer' });
  });

  it('rejects at top edge for moveUp', async () => {
    const a = await queue.enqueue('A');
    await queue.enqueue('B');
    expect(await queue.moveUp(a.id)).toEqual({ ok: false, reason: 'at-edge' });
  });

  it('rejects at bottom edge for moveDown', async () => {
    await queue.enqueue('A');
    const b = await queue.enqueue('B');
    expect(await queue.moveDown(b.id)).toEqual({ ok: false, reason: 'at-edge' });
  });

  // Feature 065 BUG-009 T078 (FR-030) — arrow-move now routes through the
  // unified reorder helper, which interprets positions in the global
  // `orderedItems` index space and reshuffles ONLY pending rows within
  // their existing global position slots. The in-flight row's `.position`
  // is therefore stable. The requests array order is no longer rewritten
  // in lockstep with `.position`, so the assertion sorts the list by
  // position to match the projector's view of row order.
  it('reorders only pending items, preserving in-flight in place', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    const c = await queue.enqueue('C');
    await queue.markInFlight(a.id, 'run-1');
    expect((await queue.moveDown(b.id)).ok).toBe(true);
    const orderedByPosition = queue
      .list()
      .slice()
      .sort((x, y) => x.position - y.position)
      .map((r) => r.id);
    expect(orderedByPosition).toEqual([a.id, c.id, b.id]);
    const aRow = queue.list().find((r) => r.id === a.id);
    expect(aRow?.status).toBe('in-flight');
    expect(aRow?.position).toBe(0);
  });
});

describe('QueueManager.clearCompleted / clearFailed', () => {
  it('clearCompleted removes only completed', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    const c = await queue.enqueue('C');
    await queue.markInFlight(a.id, 'r-a');
    await queue.finish(a.id, 'completed');
    await queue.markInFlight(b.id, 'r-b');
    await queue.finish(b.id, 'failed', 'boom');
    const result = await queue.clearCompleted();
    expect(result.removed).toBe(1);
    const ids = queue.list().map((r) => r.id);
    expect(ids).toContain(b.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(a.id);
  });

  it('clearFailed removes only failed', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'r-a');
    await queue.finish(a.id, 'failed', 'boom');
    const result = await queue.clearFailed();
    expect(result.removed).toBe(1);
    expect(queue.list()).toHaveLength(0);
  });

  it('protects in-flight', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'r-a');
    // markInFlight does not change status to completed/failed; protection check is structural.
    const result = await queue.clearCompleted();
    expect(result.removed).toBe(0);
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  it('renumbers positions after clear', async () => {
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    const c = await queue.enqueue('C');
    await queue.markInFlight(a.id, 'r-a');
    await queue.finish(a.id, 'completed');
    await queue.clearCompleted();
    const positions = queue.list().map((r) => ({ id: r.id, position: r.position }));
    expect(positions.find((p) => p.id === b.id)!.position).toBe(0);
    expect(positions.find((p) => p.id === c.id)!.position).toBe(1);
  });

  it('clearCompleted also clears a lingering pause when no in-flight remains', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'r-a');
    await queue.finish(a.id, 'completed');
    // Simulate a lingering retry-cap pause whose originating run is gone.
    await queue.setQueuePausedState(true, undefined, 'retry-cap-exhausted:r-a', 'retry-cap');
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(true);
    const result = await queue.clearCompleted();
    expect(result.removed).toBe(1);
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(false);
    expect(store.getQueue(DEFAULT_QUEUE_ID).pausedReason).toBeNull();
    expect(store.getProjectedQueueRegistry().entries[0]?.state).toBe('active');
    expect(store.getProjectedQueueRegistry().entries[0]?.pauseSource).toBeNull();
  });

  it('clearFailed also clears a lingering pause when no in-flight remains', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'r-a');
    await queue.finish(a.id, 'failed', 'boom');
    await queue.setQueuePausedState(true, undefined, 'retry-cap-exhausted:r-a', 'retry-cap');
    const result = await queue.clearFailed();
    expect(result.removed).toBe(1);
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(false);
    expect(store.getProjectedQueueRegistry().entries[0]?.state).toBe('active');
  });

  it('clear preserves the pause state when an in-flight task remains', async () => {
    // Two in-flight is impossible (cap-of-1), but the protection invariant
    // is: if ANY in-flight task exists, the pause stays so the dispatcher
    // does not promote the next pending task behind the running one.
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    await queue.markInFlight(a.id, 'r-a');
    await queue.finish(a.id, 'completed');
    await queue.markInFlight(b.id, 'r-b');
    // b is in-flight; pause the queue.
    await queue.setQueuePausedState(true, undefined, 'operator-paused', 'operator');
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(true);
    await queue.clearCompleted();
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(true);
    expect(store.getProjectedQueueRegistry().entries[0]?.state).toBe('manually-paused');
  });

  it('clear is a no-op on pause state when nothing was removed', async () => {
    await queue.setQueuePausedState(true, undefined, 'operator-paused', 'operator');
    // No completed/failed items present.
    const result = await queue.clearCompleted();
    expect(result.removed).toBe(0);
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle === 'operator-paused').toBe(true);
    expect(store.getProjectedQueueRegistry().entries[0]?.state).toBe('manually-paused');
  });
});

// Feature 030 (US3, T046) — the `QueueManager multi-queue support`
// describe block was deleted as part of the v5 → v6 single-queue
// migration, because the collapse to one queue left it nothing to
// exercise.
//
// FR-R3-145 (T1569) corrected the rest of what stood here. It said six
// methods "no longer exist"; three of them do — `saveQueueSettings`,
// `setGlobalConcurrencyCap`, and `setQueuePausedState`, whose second
// parameter is still an optional `queueId`. Only `createNamedQueue`,
// `renameNamedQueue` and `deleteNamedQueue` are actually gone. It also
// said `MAX_QUEUES = 1`, that the registry "is constrained to exactly one
// entry", and that concurrency "is implicitly capped at 1": Feature 092
// restored `MAX_QUEUES` to 20 (`src/contracts/queue-bounds.ts:40`), so
// none of the three holds. And it pointed at two files that do not exist
// in this tree, `queue-manager-single-queue.test.ts` and
// `queue-registry-single-queue.test.ts` — a dead citation is worse than
// none, because it reads as coverage.
//
// Multi-queue behavior is exercised by the `QueueManager capacity
// predicates (T040)` block immediately below, which creates a second
// queue, and by `tests/integration/per-queue-snapshot-isolation.test.ts`.

// ---------------------------------------------------------------------------
// Feature 092 (T040, US2, FR-025/FR-026) — two capacity predicates.
//
// `hasCapacity()` answered one question because, at a cap of 1 with a single
// queue, "is this queue free?" and "is the workspace under its ceiling?" had the
// same answer. With N queues they diverge, and the drain needs both separately:
// failing the first means *this queue is busy*, failing the second means the
// queue is *waiting* for workspace room. Collapsing them again would report the
// wrong reason to the operator even when the promotion decision came out right.
// ---------------------------------------------------------------------------
describe('QueueManager capacity predicates (T040)', () => {
  const QUEUE_B = '11111111-2222-4333-8444-555555555555';

  beforeEach(async () => {
    await store.setQueueRegistry(
      createQueue(store.getQueueRegistry(), { id: QUEUE_B, name: 'Second', now: Date.now() })
    );
  });

  it('hasQueueCapacity is per queue: a busy queue is full while its sibling is free', async () => {
    const a = await queue.enqueue('on default');
    await queue.enqueue('on b', { queueId: QUEUE_B });
    await queue.markInFlight(a.id, 'run-1');

    expect(queue.hasQueueCapacity(DEFAULT_QUEUE_ID)).toBe(false);
    expect(queue.hasQueueCapacity(QUEUE_B)).toBe(true);
  });

  it('hasWorkspaceCapacity counts every queue against the one ceiling', async () => {
    await store.setGlobalConcurrencyCap(2);
    const a = await queue.enqueue('on default');
    const b = await queue.enqueue('on b', { queueId: QUEUE_B });

    expect(queue.hasWorkspaceCapacity()).toBe(true);
    await queue.markInFlight(a.id, 'run-1');
    expect(queue.hasWorkspaceCapacity()).toBe(true);
    await queue.markInFlight(b.id, 'run-2');
    expect(queue.hasWorkspaceCapacity()).toBe(false);
  });

  it('the two predicates disagree, and that disagreement is the point', async () => {
    // Ceiling of 1, one Run in flight on the default queue: queue B is itself
    // free (nothing in flight on it) but the workspace has no room.
    await store.setGlobalConcurrencyCap(1);
    const a = await queue.enqueue('on default');
    await queue.markInFlight(a.id, 'run-1');

    expect(queue.hasQueueCapacity(QUEUE_B)).toBe(true);
    expect(queue.hasWorkspaceCapacity()).toBe(false);
  });

  it('hasWorkspaceCapacity keeps the pre-split body: in-flight count vs the cap', async () => {
    await store.setGlobalConcurrencyCap(3);
    expect(queue.hasWorkspaceCapacity()).toBe(true);
    const a = await queue.enqueue('one');
    const b = await queue.enqueue('two', { queueId: QUEUE_B });
    await queue.markInFlight(a.id, 'run-1');
    await queue.markInFlight(b.id, 'run-2');
    expect(queue.inFlightCount()).toBe(2);
    expect(queue.hasWorkspaceCapacity()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Feature 093 (T072, FR-014, RS-1) — the third predicate: the cap read as a
// counting semaphore over the Runs a window is actually driving.
//
// FR-014 is explicit that the cap must bound Runs *concurrently executing*,
// "not merely the number of accounted slots". `hasWorkspaceCapacity` counts
// persisted in-flight Task rows, which is the workspace-wide reading; this one
// is handed the live-Run count and compares it to the same setting. It takes
// the count rather than reading it, because the sessions live in the controller
// and the queue model holds no handle to it.
// ---------------------------------------------------------------------------
describe('QueueManager.hasExecutionCapacity (T072)', () => {
  it('admits below the cap and refuses at it', async () => {
    await store.setGlobalConcurrencyCap(3);
    expect(queue.hasExecutionCapacity(0)).toBe(true);
    expect(queue.hasExecutionCapacity(2)).toBe(true);
    expect(queue.hasExecutionCapacity(3)).toBe(false);
  });

  it('refuses above the cap, which is how a lowered cap stops admitting', async () => {
    // FR-016: lowering the cap terminates nothing, so a window can legitimately
    // hold more live Runs than the new setting. The predicate must refuse rather
    // than wrap or throw, and admission stays closed until enough Runs end.
    await store.setGlobalConcurrencyCap(1);
    expect(queue.hasExecutionCapacity(3)).toBe(false);
    expect(queue.hasExecutionCapacity(1)).toBe(false);
    expect(queue.hasExecutionCapacity(0)).toBe(true);
  });

  it('reads the setting live, so a raised cap opens admission with no restart', async () => {
    await store.setGlobalConcurrencyCap(1);
    expect(queue.hasExecutionCapacity(1)).toBe(false);
    await store.setGlobalConcurrencyCap(2);
    expect(queue.hasExecutionCapacity(1)).toBe(true);
  });

  it('answers independently of the in-flight row count the other predicate reads', async () => {
    // Two in-flight rows and a cap of 2: the workspace reading is full while the
    // execution reading — a window driving nothing — is open. Neither subsumes
    // the other, which is why the drain gate needs both. The rows sit on two
    // queues because one queue admits one in-flight Task.
    const second = '11111111-2222-4333-8444-666666666666';
    await store.setQueueRegistry(
      createQueue(store.getQueueRegistry(), { id: second, name: 'Second', now: Date.now() })
    );
    await store.setGlobalConcurrencyCap(2);
    const a = await queue.enqueue('one');
    const b = await queue.enqueue('two', { queueId: second });
    await queue.markInFlight(a.id, 'run-1');
    await queue.markInFlight(b.id, 'run-2');

    expect(queue.hasWorkspaceCapacity()).toBe(false);
    expect(queue.hasExecutionCapacity(0)).toBe(true);
  });
});
