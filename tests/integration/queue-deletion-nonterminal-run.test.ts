// FR-R4-F01 (spec 239, US3, T033, FR-012 to FR-015, SC-003) — deleting a queue never
// strands a Run.
//
// The real `QueueManager`, controller, store and lease, at a concurrency cap of one
// (`concurrent-run-harness.ts`). At `ebf589fa` a queue whose Run was paused deleted without a
// word and the Run stayed readable in `KEYS.run`: the cap slot it held was never given back,
// nothing owned it, and nothing could cancel it. A refused deletion changes nothing, and the
// check that decides runs inside the commit link, so a Run committed between the operator's
// preview and their confirmation is caught.

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { isTerminalRunStatus, type WorkflowRun } from '../../src/state/workflow-run';
import { buildWorkflowRun } from '../fixtures/state/queue-fixtures';
import {
  QUEUE_B,
  QUEUE_C,
  drainUntil,
  initGitRepo,
  makeHarness,
  removeWorkspace,
  type AdmittedRun,
  type Harness
} from './concurrent-run-harness';
import { rateLimitedOutput } from './concurrent-run-harness';

let tmpRoot: string;
let h: Harness;
const claim = unfencedCommit('test-fixture');

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-queue-deletion-'));
  await initGitRepo(tmpRoot);
  h = await makeHarness(tmpRoot, { concurrencyCap: 1, queues: [QUEUE_B, QUEUE_C] });
});

afterEach(async () => {
  await h.quiesce();
  await h.controller.drainedRunsSettled();
  const atRest = (status: string): boolean => isTerminalRunStatus(status) || status === 'paused';
  await drainUntil(
    () => !h.controller.running && h.runKeys().every((q) => atRest(h.store.getRun(q)!.status)),
    () => `the drain to settle (runs=${h.runKeys().map((q) => h.store.getRun(q)?.status).join(',')})`
  );
  await removeWorkspace(tmpRoot);
});

/** A Run that is live but not executing: admitted, parked in its first phase, then paused. */
async function admitAndPause(queueId: string): Promise<AdmittedRun> {
  const admitted = await h.admit(queueId, `work on ${queueId.slice(0, 4)}`);
  // `admit` enters through `admitNew`, not through the drain, so the lease the drain's step 6
  // would have taken is taken here: a deletion must leave it held.
  expect((await h.lease.tryAcquire(queueId)).acquired).toBe(true);
  await h.atGate(admitted.runId);
  expect((await h.controller.pauseActivePhase(queueId)).ok).toBe(true);
  h.step(admitted.runId);
  await drainUntil(
    () => h.store.getRun(queueId)?.status === 'paused' && !h.controller.running,
    () => `the Run on ${queueId.slice(0, 4)} to park as paused (${h.store.getRun(queueId)?.status})`
  );
  return admitted;
}

/** A Run in a rate-limit countdown on `queueId`; returns its persisted `pendingRetryAt`. */
async function enterRetryCountdown(queueId: string): Promise<number> {
  h.script(() => rateLimitedOutput(Math.floor(Date.now() / 1000) + 3_600));
  const admitted = await h.admit(queueId, 'retries later');
  expect((await h.lease.tryAcquire(queueId)).acquired).toBe(true);
  await h.atGate(admitted.runId);
  h.step(admitted.runId);
  await drainUntil(
    () => h.store.getRun(queueId)?.pendingRetryAt != null && !h.controller.running,
    () => `the Run to enter its retry countdown (${JSON.stringify(h.store.getRun(queueId)?.status)})`
  );
  return h.store.getRun(queueId)!.pendingRetryAt!;
}

/** What a refused deletion must leave exactly as it found it. */
function snapshotOf(queueId: string) {
  return {
    registry: JSON.stringify(h.store.getQueueRegistry()),
    run: JSON.stringify(h.store.getRun(queueId)),
    rows: JSON.stringify(h.store.getRequestsForQueue(queueId)),
    liveRuns: h.controller.liveRunCount,
    leaseHeld: h.lease.isHeld(queueId)
  };
}

/**
 * Put the queue's Task rows back to pending while its Run stays as it is: the drift between the
 * two records that the Run-based refusals exist to catch. With the row in flight the existing
 * reason answers first (row 3), which is the contract's order.
 */
async function driftRowsOutOfFlight(queueId: string): Promise<void> {
  await h.store.updateQueue(
    (current) => ({
      queue: {
        ...current,
        inFlightId: null,
        requests: current.requests.map((row) => ({ ...row, status: 'pending' as const, runId: null }))
      },
      result: undefined
    }),
    queueId,
    claim
  );
}

const reasonOf = async (queueId: string): Promise<string | undefined> => {
  const result = await h.queue.deleteQueue(queueId);
  return result.ok ? undefined : result.reason;
};

describe('a nonterminal Run refuses the deletion, with a reason of its own (US3 #1 to #3)', () => {
  it('a Run paused by the operator', async () => {
    await admitAndPause(QUEUE_B);
    const before = snapshotOf(QUEUE_B);

    expect(await reasonOf(QUEUE_B)).toBe('queue-has-paused-run');

    // The queue, the Run, the session and the lease are exactly as they were.
    expect(snapshotOf(QUEUE_B)).toEqual(before);
    expect(before.liveRuns).toBe(1);
    expect(before.leaseHeld).toBe(true);
  });

  it.each([
    ['a breakpoint', { manualPauseCause: 'breakpoint-paused', resumeTargetPhaseId: 'speckit-plan' }],
    ['the spend bound', { manualPauseCause: 'spend-bound-reached' }]
  ] as const)('a Run paused at %s', async (_name, pause) => {
    const { runId } = await admitAndPause(QUEUE_B);
    await h.store.updateRun(
      QUEUE_B,
      {
        runId,
        allowedStatuses: ['paused'],
        label: 'pause',
        patch: () => ({ manualPauseAt: 1_000, ...pause })
      },
      claim
    );
    const before = snapshotOf(QUEUE_B);

    expect(await reasonOf(QUEUE_B)).toBe('queue-has-paused-run');
    expect(snapshotOf(QUEUE_B)).toEqual(before);
  });

  it('a Run waiting to retry keeps its Task in flight, so the existing reason answers first', async () => {
    // A rate limit pauses the Run with a countdown; the persisted `pendingRetryAt` is the timer.
    // The Task row stays in flight the whole time the Run waits (`task-deletion.ts` records why),
    // so a real countdown is refused by row 3, as it was before this feature.
    const timer = await enterRetryCountdown(QUEUE_B);
    const before = snapshotOf(QUEUE_B);

    expect(await reasonOf(QUEUE_B)).toBe('queue-has-in-flight-task');

    expect(snapshotOf(QUEUE_B)).toEqual(before);
    expect(h.store.getRun(QUEUE_B)!.pendingRetryAt).toBe(timer);
  });

  it('a Run waiting to retry whose Task row has drifted out of flight', async () => {
    const timer = await enterRetryCountdown(QUEUE_B);
    await driftRowsOutOfFlight(QUEUE_B);
    const before = snapshotOf(QUEUE_B);

    expect(await reasonOf(QUEUE_B)).toBe('queue-has-retry-pending-run');

    expect(snapshotOf(QUEUE_B)).toEqual(before);
    expect(h.store.getRun(QUEUE_B)!.pendingRetryAt).toBe(timer);
  });

  it('a running Run whose Task row has drifted out of flight', async () => {
    // With the row in flight the existing reason answers first (row 3). A row that has drifted
    // back to pending is the case the Run's own status exists to catch (row 4).
    const admitted = await h.admit(QUEUE_B, 'still running');
    await h.atGate(admitted.runId);
    await driftRowsOutOfFlight(QUEUE_B);
    const before = snapshotOf(QUEUE_B);

    expect(await reasonOf(QUEUE_B)).toBe('queue-has-running-run');
    expect(snapshotOf(QUEUE_B)).toEqual(before);
  });

  it('keeps the existing reason first while a Task is in flight', async () => {
    const admitted = await h.admit(QUEUE_B, 'in flight');
    await h.atGate(admitted.runId);

    expect(await reasonOf(QUEUE_B)).toBe('queue-has-in-flight-task');
  });
});

describe('the check runs inside the commit link (US3 #4, FR-013)', () => {
  it('refuses when a Run is committed after the preview and before the confirmation', async () => {
    await h.queue.enqueue('pending only', { queueId: QUEUE_C });
    expect(h.queue.queueDeletionImpact(QUEUE_C).outcome).toBe('deletable');

    // The Run commit is queued on the `KEYS.run` chain, not yet applied, when the deletion
    // starts: a read taken before the link would still say "no Run".
    const paused: WorkflowRun = {
      ...buildWorkflowRun({ id: 'run-late', featureId: 'task-late' }),
      status: 'paused',
      manualPauseAt: 1_000,
      manualPauseCause: 'operator-paused'
    };
    const committed = h.store.setRun(QUEUE_C, paused, claim);
    const deletion = h.queue.deleteQueue(QUEUE_C);
    await committed;

    expect(await deletion).toEqual({ ok: false, reason: 'queue-has-paused-run', queueId: QUEUE_C });
    expect(h.store.getQueueRegistry().entries.some((entry) => entry.id === QUEUE_C)).toBe(true);
    expect(h.store.getRun(QUEUE_C)?.id).toBe('run-late');
  });
});

describe('what a deletion still does (US3 #5, FR-014, FR-015)', () => {
  it('deletes once the Run is canceled, and a sibling queue then drains', async () => {
    const a = await admitAndPause(QUEUE_B);
    const waiting = await h.queue.enqueue('waits for the slot', { queueId: QUEUE_C });
    await h.controller.drainQueuedWork(QUEUE_C);
    expect(h.store.getRun(QUEUE_C)).toBeNull();
    expect(await reasonOf(QUEUE_B)).toBe('queue-has-paused-run');

    // Cancel: the Run ends, its lease is returned and the slot is free.
    expect((await h.controller.deleteTask(a.feature.id)).ok).toBe(true);
    expect(h.store.getRun(QUEUE_B)?.status).toBe('canceled');

    const result = await h.queue.deleteQueue(QUEUE_B);

    expect(result).toMatchObject({ ok: true, queueId: QUEUE_B });
    expect(h.store.getQueueRegistry().entries.some((entry) => entry.id === QUEUE_B)).toBe(false);
    await h.controller.drainQueuedWork(QUEUE_C);
    await drainUntil(
      () => h.store.getRun(QUEUE_C)?.featureId === waiting.id,
      () => `the sibling queue to start its Task (${JSON.stringify(h.store.getRun(QUEUE_C)?.status)})`
    );
  });

  it('deletes a queue that holds pending Tasks only, as before', async () => {
    await h.queue.enqueue('one', { queueId: QUEUE_C });
    await h.queue.enqueue('two', { queueId: QUEUE_C });

    const result = await h.queue.deleteQueue(QUEUE_C);

    expect(result).toMatchObject({ ok: true, queueId: QUEUE_C, taskCount: 2 });
    expect(h.store.getQueueRegistry().entries.some((entry) => entry.id === QUEUE_C)).toBe(false);
  });

  it('leaves the deletion committed when a best-effort cleanup fails (hard rule 10)', async () => {
    await h.queue.enqueue('pending only', { queueId: QUEUE_C });
    vi.spyOn(h.store, 'deleteConnectedRuns').mockRejectedValue(new Error('cleanup failed'));
    h.queue.setScheduledStartCancelHook({
      cancel: vi.fn(async () => {
        throw new Error('disarm failed');
      })
    });

    const result = await h.queue.deleteQueue(QUEUE_C);

    expect(result).toMatchObject({ ok: true, queueId: QUEUE_C });
    expect(h.store.getQueueRegistry().entries.some((entry) => entry.id === QUEUE_C)).toBe(false);
  });
});
