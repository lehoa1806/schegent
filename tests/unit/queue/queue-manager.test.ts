import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { createQueue } from '../../../src/queue/queue-registry';
import { KEYS, WorkspaceStateStore } from '../../../src/state/workspace-state';
import {
  appendAttempt,
  createConnectedRun
} from '../../../src/state/connected-workflow-run';
import type { Memento } from '../../../src/state/workspace-state';
import type { PhaseResult, WorkflowRun } from '../../../src/state/workflow-run';
import type { DegradedPhaseEntry } from '../../../src/contracts/snapshot-projections';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { buildWorkflowRun } from '../../fixtures/state/queue-fixtures';

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
    expect(a.pipelineId).toBeUndefined(); // 2026-09-06 coincidental: a queue request, not a phase.retry_evaluated payload
    expect(queue.findById(a.id)?.pipelineId).toBeUndefined(); // 2026-09-06 coincidental: a queue request, not a phase.retry_evaluated payload
  });

  it('omits pipelineId when options.pipelineId is undefined (T033, US2)', async () => {
    const a = await queue.enqueue('feature A', { pipelineId: undefined });
    expect(a.pipelineId).toBeUndefined(); // 2026-09-06 coincidental: a queue request, not a phase.retry_evaluated payload
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
    await expect(queue.markInFlight(b.id, 'run-2')).rejects.toThrow(/in-flight-ownership-conflict/);
  });

  // FR-R3-153 (T1636, corrected during implementation) — a second
  // `markInFlight` call for the SAME featureId is a legal idempotent
  // re-affirmation, not a duplicate admission: `WorkflowController
  // #resumeExistingOnQueue` re-marks a Task in-flight on the same Run after
  // a delayed-retry countdown elapses, and the Task row never left
  // `in-flight` while the Run was paused waiting to retry (see
  // task-transition-decision.ts's `mark-in-flight` branch comment). Only a
  // genuinely DIFFERENT task is refused (asserted above).
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

// FR-R3-153 (T1637, research.md grounding facts) — no describe block for
// `QueueManager.pause` existed before this feature.
describe('QueueManager.pause', () => {
  it('accepts in-flight -> paused and clears the in-flight pointer', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    const result = await queue.pause(a.id, 'manually-paused-task');
    expect(result).toEqual({ ok: true });
    expect(queue.findById(a.id)?.status).toBe('paused');
    expect(queue.hasInFlight()).toBe(false);
  });

  it('preserves the in-flight pointer when preserveInFlightForRestore is set', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.pause(a.id, 'manually-paused-task', true);
    expect(store.getQueue(DEFAULT_QUEUE_ID).inFlightId).toBe(a.id);
  });

  it('refuses pending -> paused', async () => {
    const a = await queue.enqueue('A');
    const result = await queue.pause(a.id);
    expect(result).toEqual({ ok: false, reason: 'illegal-source-status' });
    expect(queue.findById(a.id)?.status).toBe('pending');
  });

  it('refuses completed -> paused', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    const result = await queue.pause(a.id);
    expect(result).toEqual({ ok: false, reason: 'illegal-source-status' });
  });

  it('refuses failed -> paused', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'failed');
    const result = await queue.pause(a.id);
    expect(result).toEqual({ ok: false, reason: 'illegal-source-status' });
  });

  it('refuses canceled -> paused', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'canceled');
    const result = await queue.pause(a.id);
    expect(result).toEqual({ ok: false, reason: 'illegal-source-status' });
  });

  it('refuses an unknown task id', async () => {
    const result = await queue.pause('missing');
    expect(result).toEqual({ ok: false, reason: 'task-not-found' });
  });
});

describe('QueueManager.finish — cancellation', () => {
  it('cancels a pending request', async () => {
    const a = await queue.enqueue('A');
    expect(await queue.finish(a.id, 'canceled')).toEqual({ ok: true });
    expect(queue.findById(a.id)?.status).toBe('canceled');
  });

  // FR-R3-161 (T034) — 2026-09-04. **Deliberate removal 1 of 4.**
  // `it('refuses to cancel an in-flight request')` stood here: it enqueued a
  // task, marked it in-flight, and asserted `queue.cancel()` returned `false`
  // and left the row `in-flight`.
  //
  // It is removed rather than re-expressed because the product no longer has
  // the behaviour it asserted. That refusal was `QueueManager.cancel`'s own
  // inline rule, and it was the divergence this feature exists to close: the
  // closed table admits `in-flight → canceled` under `finish`, which is what
  // the operator's cancel does and always did. Re-expressing the assertion
  // against `finish` would assert the opposite of what `finish` does; leaving
  // it green would require keeping the routine.
  //
  // Nothing is left unpinned. The admitted edge is asserted directly in
  // `tests/integration/task-transition-decision.test.ts` — as a cell of the
  // `finish → canceled` table, so it cannot be dropped without failing that
  // file's coverage pin — and end to end through the operator's route
  // (research F1, F17; spec FR-016 deliberately removed, 1 of 4).

  it('refuses an unknown task id', async () => {
    // FR-R3-161 (T031) — `cancel` answered `false` for both "no such task" and
    // "wrong status", so the assertion could not tell them apart. `finish`
    // names the reason, which is the same behaviour reported at the width the
    // closed table already decides it at.
    expect(await queue.finish('unknown', 'canceled')).toEqual({
      ok: false,
      reason: 'task-not-found'
    });
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

// FR-R3-161 (T041/T042, FR-016) — 2026-09-04. `describe('QueueManager.remove')`
// stood here, with four assertions on the cleanup-free removal routine T043
// deletes. Their dispositions, one category each, per FR-016:
//
//   * 'returns false and is a no-op for in-flight items' and 'returns false for
//     completed or canceled items' — **deliberately removed**, 2 and 3 of 4.
//     Both pinned the deleted primitive's own `status !== 'pending'` guard,
//     which the surviving route deliberately does not have: `removeTask` removes
//     a row in any status and the block below asserts so at two of them. Their
//     subject is gone with their subject's method, so re-expressing them is
//     impossible rather than inconvenient. The protection they were reaching
//     for — nothing deletes a live Task without cancelling its Run first — is
//     one layer up and is pinned by **FR-008a / T004** in
//     tests/integration/task-deletion-cancel-before-remove.test.ts, which landed
//     before this deletion so the area was never uncovered (research F16).
//   * 'removes a pending request entirely and renumbers positions' and 'returns
//     false for unknown id' — **re-expressed, and the re-expression already
//     existed**: the block below asserts both claims against `removeTask`, each
//     strictly more than its counterpart here did (the first also pins
//     `queueId`, the second names `unknown-task-id` where this one accepted a
//     bare `false`). Recorded because FR-016's enumeration counted twelve call
//     sites and these two were not among them — the same planning-time
//     undercount T056 records for `queueOwnsTask`. Nothing was rewritten for
//     them and nothing needed to be.

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

  // FR-R3-153 (T1640/T1637, research.md R6) — `removeTask` used to also mark
  // an in-flight task's Run `canceled` in the store directly, as a weaker,
  // second cancellation path that never called `cancelActive` or released
  // the execution lease. That fallback is now removed: this is the single
  // remaining path, and it leaves an owned Run entirely untouched —
  // cancellation and lease release are `task-deletion.ts`'s job, which runs
  // BEFORE calling this method.
  it('leaves an in-flight task\'s Run record completely untouched (no fallback cancellation)', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    const run = {
      id: 'run-1',
      featureId: a.id,
      featureDir: 'specs/000',
      status: 'running' as const,
      currentPhase: 'speckit-plan',
      currentIteration: 0,
      startedAt: Date.now(),
      lastTransitionAt: Date.now(),
      phasesCompleted: [],
      lastError: null,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    };
    await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
    await queue.removeTask(a.id);
    expect(store.getRun(DEFAULT_QUEUE_ID)).toEqual(run);
  });

  // Feature 030 (US3, T046) — the "resolves queueId from the task before
  // removal" case was deleted. It relied on `queue.createNamedQueue()` to
  // build a secondary queue and then asserted the removal payload carried
  // that non-default queueId. With the v5 → v6 migration the registry is
  // constrained to exactly one entry (`id === 'default'`) and the
  // multi-queue management surface is gone, so the audit path always
  // resolves `queueId: 'default'` and there is no second queue to test.
});

// FR-R4-F16 (spec 244, contract P5.3, FR-001, FR-002) — `removeTask` returns the removed row's
// `completionProvenance` from the same object as `priorStatus`, so the two cannot disagree. The value
// is passed on as stored: `null` for a row that holds none, and an out-of-vocabulary value unchanged,
// because the audit projection is the one place that decides what reaches disk.
describe('QueueManager.removeTask — completionProvenance (FR-R4-F16)', () => {
  /** Rewrites one stored row's provenance in the memento, as an older or newer build might have. */
  async function seedProvenance(id: string, value: unknown): Promise<void> {
    const map = memento.get<Record<string, { requests: Array<Record<string, unknown>> } | undefined>>(KEYS.queue) ?? {};
    const queueState = map[DEFAULT_QUEUE_ID];
    if (queueState === undefined) throw new Error('the default queue must be persisted');
    const requests = queueState.requests.map((row) =>
      row.id === id ? { ...row, completionProvenance: value } : row
    );
    await memento.update(KEYS.queue, { ...map, [DEFAULT_QUEUE_ID]: { ...queueState, requests } });
  }

  it("returns 'operator-attested' for a failed row the operator attested completed", async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'failed');
    await queue.attestCompleted(a.id);
    const result = await queue.removeTask(a.id);
    expect(result).toMatchObject({
      ok: true,
      priorStatus: 'completed',
      runId: 'run-1',
      completionProvenance: 'operator-attested'
    });
  });

  it.each([
    ['a host-completed row', 'completed'],
    ['a failed row', 'failed'],
    ['a canceled row', 'canceled']
  ] as const)('returns null for %s', async (_name, finishStatus) => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, finishStatus);
    const result = await queue.removeTask(a.id);
    expect(result).toMatchObject({ ok: true, priorStatus: finishStatus });
    expect(result.completionProvenance).toBeNull();
  });

  it('returns null for a pending row', async () => {
    const a = await queue.enqueue('A');
    const result = await queue.removeTask(a.id);
    expect(result).toMatchObject({ ok: true, priorStatus: 'pending' });
    expect(result.completionProvenance).toBeNull();
  });

  it('returns a stored value outside the vocabulary unchanged, without normalizing it', async () => {
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-1');
    await queue.finish(a.id, 'completed');
    await seedProvenance(a.id, 'host-verified');
    const result = await queue.removeTask(a.id);
    expect(result).toMatchObject({ ok: true, priorStatus: 'completed', completionProvenance: 'host-verified' });
  });

  it('carries no completionProvenance on a refusal', async () => {
    const result = await queue.removeTask('missing');
    expect(result).toEqual({ ok: false, reason: 'unknown-task-id' });
  });
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
    expect(reset.runId).toBeNull(); // 2026-09-06 coincidental: a queue task, not the audit envelope
  });

  it('accepts canceled', async () => {
    const a = await queue.enqueue('A');
    await queue.finish(a.id, 'canceled');
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

// FR-R3-158 (T012, T013, T014, US1) — `finish()` records the settled-phase pair
// on the Task, in the same write that sets the terminal status.
//
// It has to happen here rather than at read time because runs are held one per
// queue (`ctx.runs[queueId]`): the moment a second task in the same queue
// starts, the first task's run is gone, and with it every trace of how far that
// task got. A row that lost its count when a sibling started is the reported
// defect. So the pair is captured at the one transition every terminal status
// passes through, and no signature change carries it — a new parameter would
// let a terminal path forget it and blank the row (D2).
describe('FR-R3-158 — QueueManager.finish captures the settled-phase pair', () => {
  const PHASE_IDS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] as const;

  function settled(phase: string): PhaseResult {
    return {
      phase,
      iteration: 1,
      startedAt: 10,
      endedAt: 20,
      result: 'clean',
      terminationReason: 'deadline',
      exitCode: 0,
      stdoutSummary: '',
      stderrSummary: '',
      auditEntryId: null
    };
  }

  function failedIn(phase: string): PhaseResult {
    return { ...settled(phase), result: 'failed', terminationReason: 'error', exitCode: 1 };
  }

  /** A Run over the seven-phase plan, with whatever it managed to settle. */
  function runFor(
    featureId: string,
    completed: readonly PhaseResult[],
    withPlan = true
  ): WorkflowRun {
    // Omitted rather than `undefined` — `exactOptionalPropertyTypes` reads the
    // two differently, and a run with no frozen plan is the case being built.
    const plan = withPlan
      ? {
          pipeline: {
            id: 'seven-phase',
            name: 'Seven Phase',
            phases: PHASE_IDS.map((id) => ({ id, name: id, instruction: `${id} prompt.` }))
          },
          plannedTotal: {
            phaseCount: PHASE_IDS.length,
            iterationCap: 10,
            maxPhaseInvocations: PHASE_IDS.length
          }
        }
      : {};
    return {
      id: 'run-1',
      featureId,
      featureDir: 'specs/198',
      status: 'failed',
      currentPhase: 'p6',
      currentIteration: 1,
      startedAt: Date.now(),
      lastTransitionAt: Date.now(),
      phasesCompleted: [...completed],
      lastError: null,
      ...plan,
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    };
  }

  it('writes the pair the run reached when a task fails partway (T012)', async () => {
    const a = await queue.enqueue('fails in the sixth phase');
    await queue.markInFlight(a.id, 'run-1');
    await store.setRun(
      DEFAULT_QUEUE_ID,
      runFor(a.id, [
        settled('p1'),
        settled('p2'),
        settled('p3'),
        settled('p4'),
        settled('p5'),
        failedIn('p6')
      ]),
      unfencedCommit('test-fixture')
    );

    await queue.finish(a.id, 'failed', 'boom');

    expect(queue.findById(a.id)?.phaseProgress).toEqual({ settled: 5, total: 7 });
  });

  it('writes a real zero for a task that failed in its first phase (T012, FR-010)', async () => {
    // Zero against a real total, never absence. The distinction is the whole
    // point: this task and a task with no record of a plan must not read alike.
    const a = await queue.enqueue('fails immediately');
    await queue.markInFlight(a.id, 'run-1');
    await store.setRun(DEFAULT_QUEUE_ID, runFor(a.id, [failedIn('p1')]), unfencedCommit('test-fixture'));

    await queue.finish(a.id, 'failed', 'boom');

    expect(queue.findById(a.id)?.phaseProgress).toEqual({ settled: 0, total: 7 });
  });

  it('captures on every terminal status, with no branch on which one (T012, FR-008)', async () => {
    for (const status of ['completed', 'failed', 'canceled'] as const) {
      const task = await queue.enqueue(`ends ${status}`);
      await queue.markInFlight(task.id, 'run-1');
      await store.setRun(
        DEFAULT_QUEUE_ID,
        runFor(task.id, [settled('p1'), settled('p2'), settled('p3'), settled('p4')]),
        unfencedCommit('test-fixture')
      );

      await queue.finish(task.id, status);

      expect(queue.findById(task.id)?.phaseProgress, status).toEqual({ settled: 4, total: 7 });
    }
  });

  it('leaves a refused finish wholly untouched (T013)', async () => {
    // `pending -> completed` is the refused edge: a task that never ran cannot
    // have completed (`task-transition-decision.ts:164-167`; the neighbouring
    // pre-start edges to `canceled` and `failed` are both admitted). The
    // refusal throws before the mutation, so no field is written, this one
    // included. A capture bolted on outside the transition callback would
    // stamp a record the refusal was supposed to leave alone.
    const a = await queue.enqueue('never started');
    const before = queue.findById(a.id);
    await store.setRun(DEFAULT_QUEUE_ID, runFor(a.id, [settled('p1')]), unfencedCommit('test-fixture'));

    const result = await queue.finish(a.id, 'completed');

    expect(result.ok).toBe(false);
    expect(queue.findById(a.id)).toEqual(before);
    expect(queue.findById(a.id)).not.toHaveProperty('phaseProgress');
  });

  it('writes nothing when the task has no run at all (T014)', async () => {
    // Absence means unknown. A zero pair here would claim a plan existed and
    // nothing in it ran, which is a different and false statement.
    const a = await queue.enqueue('run already disposed of');
    await queue.markInFlight(a.id, 'run-1');

    await queue.finish(a.id, 'failed', 'boom');

    expect(queue.findById(a.id)).not.toHaveProperty('phaseProgress');
  });

  it('writes nothing when the run froze no plan (T014)', async () => {
    const a = await queue.enqueue('run without a frozen plan');
    await queue.markInFlight(a.id, 'run-1');
    await store.setRun(
      DEFAULT_QUEUE_ID,
      runFor(a.id, [settled('p1')], false),
      unfencedCommit('test-fixture')
    );

    await queue.finish(a.id, 'failed', 'boom');

    expect(queue.findById(a.id)).not.toHaveProperty('phaseProgress');
  });

  it('does not borrow a sibling task\'s run (T014)', async () => {
    // `findRunByTask` is named after the Task for this reason. A lookup that
    // read "the queue's run" would hand the finishing task whatever its
    // neighbour happened to be doing, and the row would report a number it
    // never earned.
    const a = await queue.enqueue('the one that finishes');
    const b = await queue.enqueue('the one that owns the run');
    await queue.markInFlight(b.id, 'run-1');
    await store.setRun(
      DEFAULT_QUEUE_ID,
      runFor(b.id, [settled('p1'), settled('p2'), settled('p3')]),
      unfencedCommit('test-fixture')
    );

    await queue.finish(a.id, 'canceled');

    expect(queue.findById(a.id)).not.toHaveProperty('phaseProgress');
    expect(queue.findById(b.id)).not.toHaveProperty('phaseProgress');
  });

  /**
   * FR-R3-158 (T030, FR-009b, D3) — retry discards the pair.
   *
   * The recorded pair describes **one attempt**. A retried task starts a new
   * attempt, and if the old pair survived, the row would show the previous
   * attempt's `5 of 7` while the new run worked its way up from nothing — a
   * number that is not merely stale but actively contradicts what the operator
   * can see happening.
   *
   * Clearing it returns the row to the source chain's third step, which reads
   * `0 of 7` from the catalog: honest for work that has restarted. This is the
   * one thing that resets the pair, which is why it needs its own test rather
   * than being implied by the capture's.
   */
  describe('FR-R3-158 (T030) — retry discards the recorded pair', () => {
    it('leaves no phaseProgress on a task returned to pending (FR-009b)', async () => {
      const a = await queue.enqueue('fails, then is retried');
      await queue.markInFlight(a.id, 'run-1');
      await store.setRun(
        DEFAULT_QUEUE_ID,
        runFor(a.id, [settled('p1'), settled('p2'), settled('p3'), settled('p4'), settled('p5')]),
        unfencedCommit('test-fixture')
      );
      await queue.finish(a.id, 'failed', 'boom');
      expect(queue.findById(a.id)?.phaseProgress).toEqual({ settled: 5, total: 7 });

      const result = await queue.retry(a.id);

      expect(result.ok).toBe(true);
      expect(queue.findById(a.id)?.status).toBe('pending');
      // Absent, not zeroed. `{ settled: 0, total: 7 }` would be a recorded claim
      // that a new attempt has already run and settled nothing; absence sends the
      // row back to the catalog for its total, which is what "not started" means.
      expect(queue.findById(a.id)).not.toHaveProperty('phaseProgress');
    });

    it('leaves the record untouched when the retry is refused', async () => {
      // A pending task cannot be returned to pending. `decideTaskTransition`
      // refuses and the mutation throws before any write, so a task that somehow
      // carried a pair would keep it — the clear belongs to the transition, not
      // to the call.
      const a = await queue.enqueue('never failed');
      const before = queue.findById(a.id);

      const result = await queue.retry(a.id);

      expect(result.ok).toBe(false);
      expect(queue.findById(a.id)).toEqual(before);
    });
  });
});

// FR-R3-157 (T035, T036, T039, US2, contracts C3.5/C3.8/C3.9) — `finish()`
// records the run's degraded phases on the Task, in the same write that sets the
// terminal status; `retry()` clears them.
//
// It is the FR-R3-158 argument directly above, for a second field, and the reason
// is not that the two are similar: it is that the same disposal destroys both.
// Runs are held one per queue, so the moment a sibling starts, the failed task's
// run — and the record of which phases it carried past their cap — is gone. A
// degraded row that reads clean the instant the next task begins is precisely the
// "never indistinguishable from a clean one" that FR-006 forbids, and it would
// pass every unit test that keeps the run alive. T037 is the test that catches it
// with the disposal actually performed; these are the narrower ones that fix the
// capture's shape.
describe('FR-R3-157 — QueueManager.finish captures the degraded phases', () => {
  const DEGRADED_AUDIT: DegradedPhaseEntry = {
    phaseId: 'audit',
    condition: 'open_questions > 0'
  };
  const DEGRADED_VERIFY: DegradedPhaseEntry = {
    phaseId: 'verify',
    condition: 'coverage < 80'
  };

  /** A Run for `featureId`, carrying whatever degradation it accumulated. */
  function runFor(featureId: string, degradedPhases?: readonly DegradedPhaseEntry[]): WorkflowRun {
    // Omitted rather than set to `undefined`: `exactOptionalPropertyTypes` reads
    // the two differently, and "the field was never written" is one of the cases
    // under test.
    return {
      id: 'run-1',
      featureId,
      featureDir: 'specs/199',
      status: 'failed',
      currentPhase: 'verify',
      currentIteration: 1,
      startedAt: Date.now(),
      lastTransitionAt: Date.now(),
      phasesCompleted: [],
      lastError: null,
      ...(degradedPhases === undefined ? {} : { degradedPhases }),
      delayedRetryCount: 0,
      pendingRetryAt: null,
      pendingRetryCause: null,
      phaseOverrides: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      resumeTargetPhaseId: null
    };
  }

  it('writes the phases the run carried past their cap (T035, FR-011a)', async () => {
    const a = await queue.enqueue('degrades twice, then fails');
    await queue.markInFlight(a.id, 'run-1');
    await store.setRun(
      DEFAULT_QUEUE_ID,
      runFor(a.id, [DEGRADED_AUDIT, DEGRADED_VERIFY]),
      unfencedCommit('test-fixture')
    );

    await queue.finish(a.id, 'failed', 'boom');

    // Order is the record of which phase degraded first, so it is asserted.
    expect(queue.findById(a.id)?.degradedPhases).toEqual([DEGRADED_AUDIT, DEGRADED_VERIFY]);
  });

  it('captures on every terminal status, with no branch on which one (T039, C3.9, FR-012)', async () => {
    // A degraded run that later fails carries both facts, and neither displaces
    // the other: the row says failed AND says which phase was let through. A
    // capture that ran only on `completed` would erase the mark from exactly the
    // rows an operator is most likely to be reading.
    for (const status of ['completed', 'failed', 'canceled'] as const) {
      const task = await queue.enqueue(`ends ${status}`);
      await queue.markInFlight(task.id, 'run-1');
      await store.setRun(DEFAULT_QUEUE_ID, runFor(task.id, [DEGRADED_AUDIT]), unfencedCommit('test-fixture'));

      await queue.finish(task.id, status, status === 'failed' ? 'boom' : null);

      const row = queue.findById(task.id);
      expect(row?.status, status).toBe(status);
      expect(row?.degradedPhases, status).toEqual([DEGRADED_AUDIT]);
    }
  });

  it('writes no key for a run that degraded nowhere (T035, C3.6)', async () => {
    // Absence means NOT degraded — the one place this field's semantics differ
    // from `phaseProgress` above, where absence means unknown. So the clean case
    // must leave the record alone rather than stamp an empty list on every task
    // the product ever finishes.
    for (const [label, degraded] of [
      ['an empty list', [] as readonly DegradedPhaseEntry[]],
      ['no field at all', undefined]
    ] as const) {
      const a = await queue.enqueue(`clean run with ${label}`);
      await queue.markInFlight(a.id, 'run-1');
      await store.setRun(DEFAULT_QUEUE_ID, runFor(a.id, degraded), unfencedCommit('test-fixture'));

      await queue.finish(a.id, 'completed');

      expect(queue.findById(a.id), label).not.toHaveProperty('degradedPhases');
    }
  });

  it('writes nothing when the task has no run at all (T035)', async () => {
    const a = await queue.enqueue('run already disposed of');
    await queue.markInFlight(a.id, 'run-1');

    await queue.finish(a.id, 'failed', 'boom');

    expect(queue.findById(a.id)).not.toHaveProperty('degradedPhases');
  });

  it('does not borrow a sibling task\'s run (T035, C3.5)', async () => {
    // The contract behind the `findRunByTask` lookup. A capture that read "the
    // queue's current run" would stamp the finishing task with whatever its
    // neighbour was doing — and this is the field where that is worst: the row
    // would accuse a task of a degradation that happened to a different one.
    const a = await queue.enqueue('the one that finishes');
    const b = await queue.enqueue('the one that owns the run');
    await queue.markInFlight(b.id, 'run-1');
    await store.setRun(DEFAULT_QUEUE_ID, runFor(b.id, [DEGRADED_AUDIT]), unfencedCommit('test-fixture'));

    await queue.finish(a.id, 'canceled');

    expect(queue.findById(a.id)).not.toHaveProperty('degradedPhases');
    expect(queue.findById(b.id)).not.toHaveProperty('degradedPhases');
  });

  it('leaves a refused finish wholly untouched (T035)', async () => {
    // `pending -> completed` is the refused edge. The refusal throws before the
    // mutation, so the capture must sit inside the transition callback and not
    // beside the call.
    const a = await queue.enqueue('never started');
    const before = queue.findById(a.id);
    await store.setRun(DEFAULT_QUEUE_ID, runFor(a.id, [DEGRADED_AUDIT]), unfencedCommit('test-fixture'));

    const result = await queue.finish(a.id, 'completed');

    expect(result.ok).toBe(false);
    expect(queue.findById(a.id)).toEqual(before);
    expect(queue.findById(a.id)).not.toHaveProperty('degradedPhases');
  });

  /**
   * FR-R3-157 (T036, FR-013, C3.8) — retry clears the mark.
   *
   * The mark describes **one attempt**. A retried task starts a new one, and a
   * surviving mark would report a degradation the current attempt has not had —
   * accusing a run that is at that moment working correctly. FR-013 fixes the
   * moment as well as the fact: the clear happens when the retry is requested,
   * not when the new attempt reaches a terminal status, so there is no window in
   * which a pending task still shows the previous attempt's doubt.
   */
  describe('FR-R3-157 (T036) — retry clears the mark', () => {
    it('leaves no degradedPhases on a task returned to pending (FR-013)', async () => {
      const a = await queue.enqueue('degrades, fails, is retried');
      await queue.markInFlight(a.id, 'run-1');
      await store.setRun(DEFAULT_QUEUE_ID, runFor(a.id, [DEGRADED_AUDIT]), unfencedCommit('test-fixture'));
      await queue.finish(a.id, 'failed', 'boom');
      expect(queue.findById(a.id)?.degradedPhases).toEqual([DEGRADED_AUDIT]);

      const result = await queue.retry(a.id);

      expect(result.ok).toBe(true);
      expect(queue.findById(a.id)?.status).toBe('pending');
      // Removed, never emptied. `degradedPhases: []` reads the same to a correct
      // reader but puts the key on the record permanently, and the absent case
      // then has nothing left to test.
      expect(queue.findById(a.id)).not.toHaveProperty('degradedPhases');
    });

    it('clears it before the new attempt starts, not at its terminal status (FR-013)', async () => {
      // The moment matters on its own. Between the retry and the new run's first
      // phase the task is pending and visible, and if the mark were cleared only
      // at the next `finish()` it would sit on a queued row describing a run that
      // no longer exists. Asserted with nothing started after the retry.
      const a = await queue.enqueue('retried and left pending');
      await queue.markInFlight(a.id, 'run-1');
      await store.setRun(DEFAULT_QUEUE_ID, runFor(a.id, [DEGRADED_AUDIT]), unfencedCommit('test-fixture'));
      await queue.finish(a.id, 'failed', 'boom');

      await queue.retry(a.id);

      expect(queue.findById(a.id)?.status).toBe('pending');
      expect(queue.findById(a.id)).not.toHaveProperty('degradedPhases');
    });
  });
});

/**
 * FR-R4-F01 (spec 239, US3, T034, FR-012, data-model §3) — deleting a queue refuses a
 * nonterminal Run.
 *
 * At `ebf589fa` a queue whose Run was paused deleted without complaint, and the Run stayed
 * readable in `KEYS.run`: nothing owned it, nothing could cancel it, and it held a slot under
 * the concurrency cap for ever. The refusal order is the contract and the first match wins.
 * The three existing reasons keep their positions; the three new ones come after
 * `queue-has-in-flight-task`.
 */
describe('QueueManager.queueDeletionImpact — a nonterminal Run (spec 239, US3)', () => {
  const OTHER_QUEUE_ID = '5ec04d00-2222-4333-8444-555555555555';
  const claim = unfencedCommit('test-fixture');

  async function addQueue(): Promise<void> {
    await store.setQueueRegistry(
      createQueue(store.getQueueRegistry(), {
        id: OTHER_QUEUE_ID,
        name: 'Other',
        now: 1_700_000_000_000
      })
    );
  }

  const run = (overrides: Partial<WorkflowRun>): WorkflowRun => ({
    ...buildWorkflowRun({ id: 'run-1', featureId: 'task-0' }),
    ...overrides
  });

  /** Seed a Run on the other queue, with the Task row it advances (when one is asked for). */
  async function seed(
    overrides: Partial<WorkflowRun>,
    row?: 'pending' | 'in-flight' | 'paused'
  ): Promise<void> {
    await addQueue();
    if (row !== undefined) {
      const task = await queue.enqueue('the Task', { queueId: OTHER_QUEUE_ID });
      if (row !== 'pending') await queue.markInFlight(task.id, 'run-1');
      if (row === 'paused') await queue.pause(task.id, 'manually-paused-task');
    }
    await store.setRun(OTHER_QUEUE_ID, run(overrides), claim);
  }

  const refusalOf = (queueId: string): string => {
    const impact = queue.queueDeletionImpact(queueId);
    return impact.outcome === 'refused' ? impact.reason : `deletable:${impact.outcome}`;
  };

  it('keeps the two existing reasons first: the default queue, then an unknown id (rows 1 and 2)', async () => {
    expect(refusalOf(DEFAULT_QUEUE_ID)).toBe('default-queue-undeletable');
    expect(refusalOf('queue-that-was-never-registered')).toBe('unknown-queue-id');
  });

  it('refuses an in-flight Task row before it looks at the Run (row 3 beats rows 4 to 6)', async () => {
    await seed({ status: 'running' }, 'in-flight');

    expect(refusalOf(OTHER_QUEUE_ID)).toBe('queue-has-in-flight-task');
  });

  it('refuses a running Run whose Task row is not in flight (row 4)', async () => {
    await seed({ status: 'running' }, 'pending');

    expect(refusalOf(OTHER_QUEUE_ID)).toBe('queue-has-running-run');
  });

  it('refuses a Run waiting to retry, before the general paused reason (row 5 beats row 6)', async () => {
    // A retry countdown pauses the Run, and a paused Task row is there too: row 5 names it.
    await seed(
      { status: 'paused', pendingRetryAt: 5_000, pendingRetryCause: 'rate_limit' },
      'paused'
    );

    expect(refusalOf(OTHER_QUEUE_ID)).toBe('queue-has-retry-pending-run');
  });

  it.each([
    ['an operator pause', { manualPauseAt: 1_000, manualPauseCause: 'operator-paused' }],
    ['the spend bound', { manualPauseAt: 1_000, manualPauseCause: 'spend-bound-reached' }],
    [
      'a breakpoint',
      { manualPauseAt: 1_000, manualPauseCause: 'breakpoint-paused', resumeTargetPhaseId: 'finalize' }
    ]
  ] as const)('refuses any other paused Run: %s (row 6)', async (_name, pause) => {
    await seed({ status: 'paused', ...pause }, 'pending');

    expect(refusalOf(OTHER_QUEUE_ID)).toBe('queue-has-paused-run');
  });

  it('refuses a paused Task row with no Run at all (row 6)', async () => {
    await addQueue();
    const task = await queue.enqueue('paused alone', { queueId: OTHER_QUEUE_ID });
    await queue.markInFlight(task.id, 'run-gone');
    await queue.pause(task.id, 'manually-paused-task');

    expect(refusalOf(OTHER_QUEUE_ID)).toBe('queue-has-paused-run');
  });

  it('does not refuse a queue that holds pending Tasks only, or a finished Run', async () => {
    await addQueue();
    await queue.enqueue('pending only', { queueId: OTHER_QUEUE_ID });
    expect(queue.queueDeletionImpact(OTHER_QUEUE_ID)).toMatchObject({
      outcome: 'deletable',
      pendingTaskCount: 1
    });

    await store.setRun(OTHER_QUEUE_ID, run({ status: 'completed' }), claim);
    expect(queue.queueDeletionImpact(OTHER_QUEUE_ID).outcome).toBe('deletable');
  });

  it('runs the same predicate over a view it is handed, which is how the commit link re-checks', async () => {
    await addQueue();
    expect(queue.queueDeletionImpact(OTHER_QUEUE_ID).outcome).toBe('deletable');

    const impact = queue.queueDeletionImpact(OTHER_QUEUE_ID, {
      registry: store.getQueueRegistry(),
      run: run({ status: 'paused', manualPauseAt: 1, manualPauseCause: 'operator-paused' }),
      requests: []
    });

    expect(impact).toEqual({ outcome: 'refused', reason: 'queue-has-paused-run' });
  });

  it('deleteQueue refuses with the reason and changes nothing', async () => {
    await seed({ status: 'paused', manualPauseAt: 1, manualPauseCause: 'operator-paused' }, 'pending');
    const registryBefore = JSON.stringify(store.getQueueRegistry());
    const runBefore = JSON.stringify(store.getRun(OTHER_QUEUE_ID));

    const result = await queue.deleteQueue(OTHER_QUEUE_ID);

    expect(result).toEqual({ ok: false, reason: 'queue-has-paused-run', queueId: OTHER_QUEUE_ID });
    expect(JSON.stringify(store.getQueueRegistry())).toBe(registryBefore);
    expect(JSON.stringify(store.getRun(OTHER_QUEUE_ID))).toBe(runBefore);
    expect(store.getRequestsForQueue(OTHER_QUEUE_ID)).toHaveLength(1);
  });

  it('deleteQueue removes a deletable queue and leaves a sibling Run alone', async () => {
    await addQueue();
    await store.setRun(
      DEFAULT_QUEUE_ID,
      run({ id: 'run-default', status: 'running', featureId: 'task-default' }),
      claim
    );

    const result = await queue.deleteQueue(OTHER_QUEUE_ID);

    expect(result).toMatchObject({ ok: true, queueId: OTHER_QUEUE_ID });
    expect(store.getQueueRegistry().entries.some((entry) => entry.id === OTHER_QUEUE_ID)).toBe(false);
    expect(store.getRun(DEFAULT_QUEUE_ID)?.id).toBe('run-default');
  });
});
