// FR-R3-153 (T1636) — the closed task-transition table, proved end to end
// through the real QueueManager/WorkspaceStateStore writers (not just the
// pure `decideTaskTransition` classifier in isolation): every disallowed
// transition named in spec.md's closed transition table (FR-006–FR-010) is
// refused with zero persisted change to the task row, queue `inFlightId`,
// `RunStateMap` entry, or timestamps (spec FR-004, SC-001), and a valid edge
// on one queue never touches a sibling queue's state (spec FR-010, SC-002).

import { describe, it, expect } from 'vitest';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { QueueManager } from '../../src/queue/queue-manager';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { decideTaskTransition } from '../../src/queue/task-transition-decision';

class MockMemento implements Memento {
  public writeCount = 0;
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.writeCount++;
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

async function buildSystem(): Promise<{ store: WorkspaceStateStore; queue: QueueManager; memento: MockMemento }> {
  const memento = new MockMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const queue = new QueueManager(store);
  return { store, queue, memento };
}

function sampleRun(featureId: string, status: WorkflowRun['status'] = 'running'): WorkflowRun {
  return {
    id: `run-${featureId}`,
    featureId,
    featureDir: 'specs/001-x',
    status,
    currentPhase: 'speckit-plan',
    currentIteration: 0,
    startedAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
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
}

/** A snapshot of everything a refused transition must leave untouched. */
interface Snapshot {
  readonly requestJson: string | null;
  readonly inFlightId: string | null;
  readonly runMapJson: string;
  readonly writeCount: number;
}

function snapshot(store: WorkspaceStateStore, memento: MockMemento, taskId: string, queueId: string): Snapshot {
  return {
    requestJson: JSON.stringify(store.getRequest(taskId)),
    inFlightId: store.getQueue(queueId).inFlightId,
    runMapJson: JSON.stringify(store.getRunMap()),
    writeCount: memento.writeCount
  };
}

function expectUnchanged(before: Snapshot, after: Snapshot): void {
  expect(after.requestJson).toBe(before.requestJson);
  expect(after.inFlightId).toBe(before.inFlightId);
  expect(after.runMapJson).toBe(before.runMapJson);
  expect(after.writeCount).toBe(before.writeCount);
}

describe('closed transition table — refused cells (spec.md FR-006-FR-010, SC-001)', () => {
  it('refuses marking a missing task in-flight', async () => {
    const { store, queue, memento } = await buildSystem();
    const before = snapshot(store, memento, 'missing', DEFAULT_QUEUE_ID);
    await expect(queue.markInFlight('missing', 'run-x')).rejects.toThrow(/task-not-found/);
    expectUnchanged(before, snapshot(store, memento, 'missing', DEFAULT_QUEUE_ID));
  });

  it('refuses marking a second task in-flight while the queue already owns one', async () => {
    const { store, queue, memento } = await buildSystem();
    const a = await queue.enqueue('A');
    const b = await queue.enqueue('B');
    await queue.markInFlight(a.id, 'run-a');
    const before = snapshot(store, memento, b.id, DEFAULT_QUEUE_ID);
    await expect(queue.markInFlight(b.id, 'run-b')).rejects.toThrow(/in-flight-ownership-conflict/);
    expectUnchanged(before, snapshot(store, memento, b.id, DEFAULT_QUEUE_ID));
  });

  // research.md R10 — `completed`/`canceled` are the only two source statuses
  // this operation still refuses; `failed` is deliberately eligible (below),
  // matching `isOperableRunStatus`'s operable/terminal split for Runs.
  it.each(['completed', 'canceled'] as const)(
    'refuses marking a %s task in-flight',
    async (status) => {
      const { store, queue, memento } = await buildSystem();
      const a = await queue.enqueue('A');
      await queue.markInFlight(a.id, 'run-a');
      await queue.finish(a.id, status);
      const before = snapshot(store, memento, a.id, DEFAULT_QUEUE_ID);
      await expect(queue.markInFlight(a.id, 'run-a-2')).rejects.toThrow(/illegal-source-status/);
      expectUnchanged(before, snapshot(store, memento, a.id, DEFAULT_QUEUE_ID));
    }
  );

  it("refuses finish(..., 'paused') on an in-flight task", async () => {
    const { store, queue, memento } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    const before = snapshot(store, memento, a.id, DEFAULT_QUEUE_ID);
    // @ts-expect-error — 'paused' is not a TerminalRequestStatus; the type
    // narrowing (T002/T009) is itself part of what this feature closes.
    const result = await queue.finish(a.id, 'paused');
    expect(result).toEqual({ ok: false, reason: 'illegal-source-status' });
    expectUnchanged(before, snapshot(store, memento, a.id, DEFAULT_QUEUE_ID));
  });

  it('refuses pausing a pending task', async () => {
    const { store, queue, memento } = await buildSystem();
    const a = await queue.enqueue('A');
    const before = snapshot(store, memento, a.id, DEFAULT_QUEUE_ID);
    const result = await queue.pause(a.id);
    expect(result).toEqual({ ok: false, reason: 'illegal-source-status' });
    expectUnchanged(before, snapshot(store, memento, a.id, DEFAULT_QUEUE_ID));
  });

  it('refuses pausing a terminal task', async () => {
    const { store, queue, memento } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    await queue.finish(a.id, 'canceled');
    const before = snapshot(store, memento, a.id, DEFAULT_QUEUE_ID);
    const result = await queue.pause(a.id);
    expect(result).toEqual({ ok: false, reason: 'illegal-source-status' });
    expectUnchanged(before, snapshot(store, memento, a.id, DEFAULT_QUEUE_ID));
  });

  it('refuses driving a completed task back to pending', async () => {
    const { store, queue, memento } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    await queue.finish(a.id, 'completed');
    const before = snapshot(store, memento, a.id, DEFAULT_QUEUE_ID);
    const result = await queue.retry(a.id);
    expect(result).toEqual({ ok: false, reason: 'illegal-state' });
    expectUnchanged(before, snapshot(store, memento, a.id, DEFAULT_QUEUE_ID));
  });

  it('refuses marking a task in-flight while addressing the wrong queue (classifier level)', () => {
    // Unreachable through QueueManager's own public writers today — none of
    // markInFlight/finish/pause takes a caller-supplied queue id distinct
    // from the task's own row, so there is no real call shape that
    // "addresses a different queue." The classifier still owns this cell of
    // the closed table (research.md R2's `queueOwnsTask` field), tested
    // directly here.
    const decision = decideTaskTransition({
      operation: 'mark-in-flight',
      currentStatus: 'pending',
      queueOwnsTask: false,
      queueAlreadyHasDifferentInFlight: false
    });
    expect(decision).toEqual({ eligible: false, reason: 'queue-mismatch' });
  });
});

describe('closed transition table — accepted cells', () => {
  it('accepts pending -> in-flight', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  // research.md R10 — three real resume mechanisms, each re-marking the
  // SAME task in-flight without first returning it to pending:
  // in-flight (delayed-retry countdown never left the row), paused
  // (RunDriver's pause-verify branch cleared inFlightId), failed (resuming
  // a halted workflow directly). All are `queueAlreadyHasDifferentInFlight
  // === false` for the SAME task, distinguishing them from a genuine
  // duplicate admission.
  it('accepts in-flight -> in-flight (idempotent re-affirmation, e.g. delayed-retry resume)', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    await expect(queue.markInFlight(a.id, 'run-a')).resolves.toBeUndefined();
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  it('accepts paused -> in-flight (e.g. operator resume after RunDriver pause-verify)', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    await queue.pause(a.id);
    expect(queue.findById(a.id)?.status).toBe('paused');
    await expect(queue.markInFlight(a.id, 'run-a')).resolves.toBeUndefined();
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  it('accepts failed -> in-flight (e.g. resuming a halted workflow directly)', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    await queue.finish(a.id, 'failed');
    expect(queue.findById(a.id)?.status).toBe('failed');
    await expect(queue.markInFlight(a.id, 'run-a')).resolves.toBeUndefined();
    expect(queue.findById(a.id)?.status).toBe('in-flight');
  });

  it('accepts in-flight -> paused', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    expect(await queue.pause(a.id)).toEqual({ ok: true });
  });

  it('accepts in-flight -> any terminal status via finish', async () => {
    const { queue } = await buildSystem();
    for (const status of ['completed', 'failed', 'canceled'] as const) {
      const a = await queue.enqueue(`A-${status}`);
      await queue.markInFlight(a.id, `run-${status}`);
      expect(await queue.finish(a.id, status)).toEqual({ ok: true });
    }
  });

  it("accepts pending -> canceled via finish (cancel-before-start, research.md R4)", async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    expect(await queue.finish(a.id, 'canceled')).toEqual({ ok: true });
    expect(queue.findById(a.id)?.status).toBe('canceled');
  });

  it('accepts paused/failed/canceled -> pending via retry, each with its own explicit trigger', async () => {
    const { queue } = await buildSystem();
    for (const status of ['paused', 'failed', 'canceled'] as const) {
      const a = await queue.enqueue(`A-${status}`);
      await queue.markInFlight(a.id, `run-${status}`);
      if (status === 'paused') {
        await queue.pause(a.id);
      } else {
        await queue.finish(a.id, status);
      }
      expect(await queue.retry(a.id)).toEqual({ ok: true });
      expect(queue.findById(a.id)?.status).toBe('pending');
    }
  });
});

describe('two-queue isolation (spec.md FR-010, SC-002)', () => {
  it('a valid edge on Queue A never changes Queue B\'s inFlightId or Run', async () => {
    const { store, queue } = await buildSystem();
    const queueBId = (await queue.createQueue('Queue B')).queueId as string;

    const a = await queue.enqueue('A', { queueId: DEFAULT_QUEUE_ID });
    const b = await queue.enqueue('B', { queueId: queueBId });
    await queue.markInFlight(b.id, 'run-b');
    await store.setRun(queueBId, sampleRun(b.id), unfencedCommit('test-fixture'));

    const beforeB = {
      inFlightId: store.getQueue(queueBId).inFlightId,
      request: JSON.stringify(store.getRequest(b.id)),
      run: JSON.stringify(store.getRun(queueBId))
    };

    await queue.markInFlight(a.id, 'run-a');
    await queue.pause(a.id);
    await queue.retry(a.id);

    expect(store.getQueue(queueBId).inFlightId).toBe(beforeB.inFlightId);
    expect(JSON.stringify(store.getRequest(b.id))).toBe(beforeB.request);
    expect(JSON.stringify(store.getRun(queueBId))).toBe(beforeB.run);
  });

  it('refusing a transition on Queue A leaves Queue B fully untouched, including write count', async () => {
    const { store, queue, memento } = await buildSystem();
    const queueBId = (await queue.createQueue('Queue B')).queueId as string;
    const b = await queue.enqueue('B', { queueId: queueBId });
    await queue.markInFlight(b.id, 'run-b');

    const a = await queue.enqueue('A', { queueId: DEFAULT_QUEUE_ID });
    await queue.markInFlight(a.id, 'run-a');
    const secondOnA = await queue.enqueue('A2', { queueId: DEFAULT_QUEUE_ID });

    const beforeB = snapshot(store, memento, b.id, queueBId);
    await expect(queue.markInFlight(secondOnA.id, 'run-a-2')).rejects.toThrow(/in-flight-ownership-conflict/);
    expectUnchanged(beforeB, snapshot(store, memento, b.id, queueBId));
  });
});

describe('feature 195 (T060, FR-009) — a failed task cannot be cancelled', () => {
  // FR-009 names retrying and removing as the only two ways out of a halt,
  // and says cancelling is not a third — because `failed -> canceled` is not
  // an edge in this table. `finish` is the method a cancel-of-an-in-flight-Task
  // routes through (`src/commands/cancel.ts`), and it is the same closed
  // table `decideTaskTransition`'s `finish` case enforces: eligible from
  // `in-flight` unconditionally, and from `pending` only when the target is
  // `canceled` (the cancel-before-start edge) — `failed` is neither.
  it('refuses finish(id, "canceled") on a task that already ended failed', async () => {
    const { queue } = await buildSystem();
    const a = await queue.enqueue('A');
    await queue.markInFlight(a.id, 'run-a');
    await queue.finish(a.id, 'failed');
    expect(queue.findById(a.id)?.status).toBe('failed');

    const result = await queue.finish(a.id, 'canceled');

    expect(result).toEqual({ ok: false, reason: 'illegal-source-status' });
    expect(queue.findById(a.id)?.status).toBe('failed');
  });

  it('the pure classifier agrees: finish/canceled is refused from every status but pending and in-flight', () => {
    const nonEligible = (['failed', 'canceled', 'completed', 'paused'] as const).map((currentStatus) =>
      decideTaskTransition({
        operation: 'finish',
        currentStatus,
        targetStatus: 'canceled',
        queueOwnsTask: true,
        queueAlreadyHasDifferentInFlight: false
      })
    );
    for (const decision of nonEligible) {
      expect(decision.eligible).toBe(false);
    }
  });
});
