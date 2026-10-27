// BUG-004 — end-to-end: the queue a stranded Run holds shut.
//
// docs/features/bugs/DONE_a-deleted-paused-task-strands-its-run-and-deadlocks-
// its-queue.md. A phase-paused Task's ROW reads `paused`; its Run stays
// non-terminal and keeps the queue's one Run slot. Deleting the row used to
// leave that Run behind, and drain step 3 then refused to start anything else
// on the queue — forever, because every route that could end the Run resolves
// the row first and there is none.
//
// `task-deletion-cancel-before-remove.test.ts` pins the deletion sequence, and
// `orphaned-run-reconciler.test.ts` pins the load-time repair. Neither asserts
// the consequence the operator actually reported: whether the queue DRAINS
// afterwards. That is what this file is, and it is the row that would have
// caught the defect — the deletion sequence was green throughout, because the
// case never reached it.
//
// Real store, real `QueueManager`, real `AutoDrainCoordinator`, real
// `QueueStartFailureRegistry` and the real deletion route. The one double is
// `admitNew`, from `queue-halt-fixture.ts`: what is under test is the gate
// chain that decides whether a start is offered, not the spawn behind it.

import { describe, expect, it, vi } from 'vitest';
import { makeHaltHarness, type HaltHarness } from './queue-halt-fixture';
import {
  deleteTaskWithSessionCleanup,
  type TaskDeletionDeps
} from '../../src/controller/task-deletion';
import { runStartQueueCommand } from '../../src/commands/start-queue';
import { SanitizedLogger } from '../../src/lib/logger';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { WorkflowRun } from '../../src/state/workflow-run';

const PAUSED_PHASE = 'speckit-analyze';

/**
 * Two rows, the first phase-paused with a live Run behind it.
 *
 * `markInFlight` then `pause` is the real sequence: the pause moves the row out
 * of `in-flight`, which is what frees `hasQueueCapacity` while the Run map still
 * says the queue is held. The two readings of step 3 disagreeing is the whole
 * mechanism, so the fixture has to produce it rather than assert it.
 */
async function seedPausedHeadAndPendingTail(
  harness: HaltHarness,
  runId: string
): Promise<{ pausedTaskId: string; pendingTaskId: string }> {
  const head = await harness.queue.enqueue('the phase-paused task');
  const tail = await harness.queue.enqueue('the task waiting behind it');
  await harness.queue.markInFlight(head.id, runId);
  await harness.queue.pause(head.id);
  expect(harness.queue.findById(head.id)?.status).toBe('paused');

  const now = Date.now();
  const run: WorkflowRun = {
    id: runId,
    featureId: head.id,
    featureDir: 'specs/000',
    status: 'paused',
    currentPhase: PAUSED_PHASE,
    currentIteration: 1,
    startedAt: now,
    lastTransitionAt: now,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: now,
    manualPauseCause: 'operator-paused',
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
  await harness.store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
  return { pausedTaskId: head.id, pendingTaskId: tail.id };
}

/** The product's real deletion route over the harness's real store and queue. */
function deletionDeps(harness: HaltHarness): TaskDeletionDeps {
  return {
    logger: new SanitizedLogger([]),
    queue: {
      findById: (taskId) => harness.queue.findById(taskId),
      queueIdForTask: (taskId) => harness.queue.queueIdForTask(taskId),
      removeTask: (taskId) => harness.queue.removeTask(taskId)
    },
    store: {
      getRun: (queueId) => harness.store.getRun(queueId),
      updateRun: (queueId, update, claim) => harness.store.updateRun(queueId, update, claim),
      runCommitClaim: (queueId) => harness.store.runCommitClaim(queueId)
    },
    cancelActive: vi.fn(),
    releaseExecutionLeaseForRun: vi.fn(async () => undefined),
    sessionCleanup: async () => ({ cleaned: true }),
    workspaceRoot: '/nonexistent'
  };
}

describe('BUG-004 — a deleted phase-paused task must not hold its queue shut', () => {
  it('drains the pending tail once the paused head is deleted', async () => {
    const harness = await makeHaltHarness();
    const { pausedTaskId, pendingTaskId } = await seedPausedHeadAndPendingTail(harness, 'R-paused');

    const result = await deleteTaskWithSessionCleanup(deletionDeps(harness), pausedTaskId);
    expect(result.ok).toBe(true);

    await harness.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);

    // The whole point. Before the deletion route ended the Run, this array was
    // empty here and stayed empty for every later sweep, every operator Start
    // and every window restart.
    expect(harness.started).toEqual([pendingTaskId]);
    expect(harness.startFailures.get(DEFAULT_QUEUE_ID)).toBeNull();
  });

  it('reports the queue a stranded Run already holds instead of refusing in silence', async () => {
    // The state a workspace is already in when it hits this — the row removed
    // without the Run being ended, which is what every window before the fix
    // produced. `removeTask` on its own is that deletion, minus the sequence.
    const harness = await makeHaltHarness();
    const { pausedTaskId, pendingTaskId } = await seedPausedHeadAndPendingTail(harness, 'R-stranded');
    await harness.queue.removeTask(pausedTaskId);
    expect(harness.store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('paused');

    await harness.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);

    expect(harness.started).toEqual([]);
    expect(harness.startFailures.get(DEFAULT_QUEUE_ID)).toEqual({
      kind: 'stranded-run',
      runId: 'R-stranded',
      phase: PAUSED_PHASE,
      at: expect.any(Number)
    });
    // And the tail really is still there waiting, so the refusal above is the
    // reason nothing started rather than there being nothing to start.
    expect(harness.queue.findById(pendingTaskId)?.status).toBe('pending');
  });

  it('answers Start with the refusal rather than an acknowledgement', async () => {
    // `runStartQueueCommand` used to return `accepted` here — the operator
    // pressed Start, the host said yes, and nothing moved. Forever.
    const harness = await makeHaltHarness();
    const { pausedTaskId } = await seedPausedHeadAndPendingTail(harness, 'R-stranded');
    await harness.queue.removeTask(pausedTaskId);

    const outcome = await runStartQueueCommand(undefined, {
      guardedRunService: { applyStartQueueIntent: vi.fn() } as never,
      controller: {
        drainQueuedWork: (queueId?: string) =>
          harness.autoDrain.drainIfIdle(queueId ?? DEFAULT_QUEUE_ID)
      },
      logger: { warn: vi.fn() },
      startFailures: harness.startFailures
    });

    expect(outcome).toEqual({ outcome: 'refused', reason: 'queue-blocked-by-stranded-run' });
  });

  it('clears the report and drains once the stranded Run is ended', async () => {
    // What the load-time reconciler does on the next window open, applied here
    // to the same map: the Run goes terminal, and nothing else has to happen for
    // the queue to move again.
    const harness = await makeHaltHarness();
    const { pausedTaskId, pendingTaskId } = await seedPausedHeadAndPendingTail(harness, 'R-stranded');
    await harness.queue.removeTask(pausedTaskId);
    await harness.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);
    expect(harness.startFailures.get(DEFAULT_QUEUE_ID)).not.toBeNull();

    const stranded = harness.store.getRun(DEFAULT_QUEUE_ID);
    expect(stranded).not.toBeNull();
    await harness.store.setRun(
      DEFAULT_QUEUE_ID,
      { ...(stranded as WorkflowRun), status: 'canceled' },
      unfencedCommit('test-fixture')
    );

    await harness.autoDrain.drainIfIdle(DEFAULT_QUEUE_ID);

    expect(harness.started).toEqual([pendingTaskId]);
    expect(harness.startFailures.get(DEFAULT_QUEUE_ID)).toBeNull();
  });
});
