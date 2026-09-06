// The load-time half of the deleted-paused-task fix.
// See docs/features/bugs/DONE_a-deleted-paused-task-strands-its-run-and-
// deadlocks-its-queue.md.
//
// Two levels, because they answer different questions. The first describe block
// tests the pure reconciler against a map and a predicate. The second runs a
// real `WorkspaceStateStore.initialize()` over a Memento seeded with the exact
// state the reported workspace was found in — a `paused` Run whose `featureId`
// matches none of the queue's rows — because that is the claim that matters:
// existing workspaces unstick themselves on the next window open, with no
// operator action and no destructive command.

import { describe, expect, it } from 'vitest';
import { reconcileOrphanedRuns } from '../../../src/state/orphaned-run-reconciler';
import type { RunStateMap } from '../../../src/state/run-state-migrator';
import type { WorkflowRun, WorkflowRunStatus } from '../../../src/state/workflow-run';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { DELAYED_RETRY_CAP } from '../../../src/contracts/retry-bounds';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';

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

function makeRun(overrides: Partial<WorkflowRun> & { id: string; featureId: string }): WorkflowRun {
  const now = 1_700_000_000_000;
  return {
    featureDir: 'specs/000',
    status: 'paused',
    currentPhase: 'speckit-analyze',
    currentIteration: 1,
    startedAt: now,
    lastTransitionAt: now,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    ...overrides
  };
}

/** No queue holds the Task asked about — the orphan case. */
const NO_ROW_ANYWHERE = (): boolean => false;
/** Every Task asked about still has a row somewhere. */
const ROW_EVERYWHERE = (): boolean => true;

function rowsFor(...taskIds: readonly string[]): (taskId: string) => boolean {
  return (taskId) => taskIds.includes(taskId);
}

// WHY THE ASSERTIONS READ THE WHOLE MAP INSTEAD OF INDEXING IT. `runs['default']`
// reads as the obvious thing to write, and two gates disagree about how to spell
// it: `noUncheckedIndexedAccess` (pinned under `compiler-strictness-ratchet`)
// counts `runs['default'].status` as a diagnostic, and `no-unnecessary-condition`
// counts the `?.` that answers it as an unnecessary chain, because the flag is not
// enabled yet. Satisfying either by hand spends the other's budget. Asserting on
// the map states more anyway — that the OTHER queues are untouched, which indexing
// one key cannot say.

describe('reconcileOrphanedRuns — a Run may not outlive its Task row', () => {
  it('ends a paused Run whose Task row is in no queue, and says so', () => {
    const orphan = makeRun({ id: 'R1', featureId: 'gone', status: 'paused' });

    const result = reconcileOrphanedRuns({ default: orphan }, NO_ROW_ANYWHERE, 4_242);

    expect(result.changed).toBe(true);
    // The whole record, not one field: everything but `status` and the stamp
    // survives, which is the claim that ending a Run here is not destructive.
    expect(result.runs).toEqual({
      default: { ...orphan, status: 'canceled', lastTransitionAt: 4_242 }
    });
    expect(result.events).toEqual([
      {
        type: 'run-canceled-task-row-removed',
        occurredAt: 4_242,
        queueId: 'default',
        runId: 'R1',
        priorStatus: 'paused'
      }
    ]);
  });

  it('ends a running Run the same way — the status it was in is reported, not acted on', () => {
    const orphan = makeRun({ id: 'R2', featureId: 'gone', status: 'running' });

    const result = reconcileOrphanedRuns({ alpha: orphan }, NO_ROW_ANYWHERE, 7);

    expect(result.runs).toEqual({ alpha: { ...orphan, status: 'canceled', lastTransitionAt: 7 } });
    expect(result.events[0]?.priorStatus).toBe('running');
  });

  // The whole point of the predicate being asked over EVERY queue rather than
  // over the Run's own. A Task moved between queues still has a row, so its Run
  // is not an orphan — ending it would destroy live work on the strength of a
  // key mismatch.
  it('leaves a Run alone when its Task row exists somewhere, even on another queue', () => {
    const runs: RunStateMap = {
      alpha: makeRun({ id: 'R3', featureId: 'moved-to-beta', status: 'running' })
    };

    const result = reconcileOrphanedRuns(runs, ROW_EVERYWHERE, 9);

    expect(result.changed).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.runs).toEqual(runs);
  });

  it.each(['completed', 'failed', 'canceled'] as const)(
    'leaves a %s Run alone even with no Task row — terminal is already the resting state',
    (status: WorkflowRunStatus) => {
      const runs: RunStateMap = {
        default: makeRun({ id: 'R4', featureId: 'gone', status })
      };

      const result = reconcileOrphanedRuns(runs, NO_ROW_ANYWHERE, 11);

      expect(result.changed).toBe(false);
      // Unchanged in full — the status kept AND the clock not stamped, which one
      // status assertion would let past.
      expect(result.runs).toEqual(runs);
    }
  );

  it('reports no change on an empty map, so the caller writes nothing', () => {
    expect(reconcileOrphanedRuns({}, NO_ROW_ANYWHERE, 1).changed).toBe(false);
  });

  it('ends only the orphans, leaving every sibling Run byte-identical', () => {
    const live = makeRun({ id: 'R-live', featureId: 'still-queued', status: 'running' });
    const orphan = makeRun({ id: 'R-orphan', featureId: 'gone', status: 'paused' });

    const result = reconcileOrphanedRuns(
      { alpha: live, beta: orphan },
      rowsFor('still-queued'),
      13
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.queueId).toBe('beta');
    expect(result.runs).toEqual({
      alpha: live,
      beta: { ...orphan, status: 'canceled', lastTransitionAt: 13 }
    });
  });

  // `validateRunInvariants` rejects `delayedRetryCount >= DELAYED_RETRY_CAP` on
  // any status but `paused` or `failed`, and this write goes straight to the
  // Memento, past that validator. A Run paused at the cap is exactly the kind
  // that gets abandoned, so a record written here without clearing the retry
  // bookkeeping would be one the next `setRun` refuses.
  it('clears the delayed-retry bookkeeping so the canceled record stays writable', () => {
    const atTheCap = makeRun({
      id: 'R5',
      featureId: 'gone',
      status: 'paused',
      delayedRetryCount: DELAYED_RETRY_CAP,
      pendingRetryAt: 1_700_000_060_000,
      pendingRetryCause: 'rate_limit'
    });

    const result = reconcileOrphanedRuns({ default: atTheCap }, NO_ROW_ANYWHERE, 17);

    expect(result.runs).toEqual({
      default: {
        ...atTheCap,
        status: 'canceled',
        lastTransitionAt: 17,
        delayedRetryCount: 0,
        pendingRetryAt: null,
        pendingRetryCause: null
      }
    });
  });

  // Every orphan, not the first one found. A workspace can hold several — one
  // per queue — and a repair that stopped at the first would leave the rest
  // deadlocked while reporting success.
  it('ends every orphan in the map, not just the first', () => {
    const runs: RunStateMap = {
      alpha: makeRun({ id: 'R7', featureId: 'a', status: 'running' }),
      beta: makeRun({ id: 'R8', featureId: 'b', status: 'paused' })
    };

    const result = reconcileOrphanedRuns(runs, NO_ROW_ANYWHERE, 23);

    expect(result.events.map((event) => event.runId)).toEqual(['R7', 'R8']);
    expect(Object.values(result.runs).map((run) => run.status)).toEqual(['canceled', 'canceled']);
  });

  // Kept, deliberately: the pair is consistent, and it is the only surviving
  // record of why the Run was sitting there when its row was deleted.
  it('preserves the manual-pause pair as the evidence of what was interrupted', () => {
    const manuallyPaused = makeRun({
      id: 'R6',
      featureId: 'gone',
      status: 'paused',
      manualPauseAt: 1_700_000_000_000,
      manualPauseCause: 'operator-paused'
    });

    const result = reconcileOrphanedRuns({ default: manuallyPaused }, NO_ROW_ANYWHERE, 19);

    expect(result.runs).toEqual({
      default: { ...manuallyPaused, status: 'canceled', lastTransitionAt: 19 }
    });
  });
});

describe('WorkspaceStateStore.initialize — the standing invariant, on real state', () => {
  /**
   * The reported workspace, reduced: fifteen pending rows, no in-flight
   * pointer, a queue that is `running` rather than paused, and a `paused` Run
   * whose `featureId` matches none of the rows because that row was deleted
   * while the phase was paused.
   */
  function seedDeadlockedWorkspace(memento: FakeMemento): void {
    void memento.update('schegent.queue', {
      [DEFAULT_QUEUE_ID]: {
        inFlightId: null,
        queueLifecycle: 'running',
        requests: [
          {
            id: 'still-pending',
            description: 'the head that never moves',
            status: 'pending',
            queueId: DEFAULT_QUEUE_ID,
            createdAt: 1_700_000_000_000,
            runId: null
          }
        ]
      }
    });
    void memento.update('schegent.run', {
      [DEFAULT_QUEUE_ID]: makeRun({
        id: 'orphan-run',
        featureId: 'deleted-while-paused',
        status: 'paused',
        manualPauseAt: 1_700_000_000_000,
        manualPauseCause: 'operator-paused'
      })
    });
  }

  it('ends the orphan on open, so the queue is no longer occupied by a Run nothing can reach', async () => {
    const memento = new FakeMemento();
    seedDeadlockedWorkspace(memento);
    const store = new WorkspaceStateStore(memento);

    const result = await store.initialize();

    expect(result.orphanedRunEvents).toHaveLength(1);
    expect(result.orphanedRunEvents[0]).toMatchObject({
      type: 'run-canceled-task-row-removed',
      queueId: DEFAULT_QUEUE_ID,
      runId: 'orphan-run',
      priorStatus: 'paused'
    });

    // Drain step 3 reads exactly this. `isTerminalRunStatus('canceled')` is
    // true, so the queue stops reading as occupied and the pending head can be
    // promoted on the next pass — which is the whole deadlock, undone.
    expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('canceled');

    // And the pending rows the operator would have lost to `Clear Queue` or
    // `Reset Workspace State` — the only two commands that could previously
    // shift this — are untouched.
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(1);
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests[0]?.status).toBe('pending');
  });

  it('is idempotent: a second open finds nothing to repair and emits nothing', async () => {
    const memento = new FakeMemento();
    seedDeadlockedWorkspace(memento);
    await new WorkspaceStateStore(memento).initialize();

    const second = await new WorkspaceStateStore(memento).initialize();

    expect(second.orphanedRunEvents).toEqual([]);
  });

  // A legacy workspace holding a Run key and NO queue key at all — the shape
  // `legacy-run-preservation.test.ts` opens. Its Run is an orphan by every test
  // this module applies, and it is ended like any other. That is a deliberate
  // change to what those FR-021/T020 tests used to assert, and the reasoning is
  // in the module header: the status they were preserving is not reachable, and
  // preserving it holds the occupancy gate shut on the whole queue.
  //
  // What preservation actually means is pinned here instead — the record and
  // everything on it survives; only the status and the retry fields move.
  it('ends a legacy Run with no queue key at all, keeping every field but the status', async () => {
    const memento = new FakeMemento();
    void memento.update('schegent.run', {
      [DEFAULT_QUEUE_ID]: makeRun({
        id: 'lonely-run',
        featureId: 'feature-legacy',
        phasesCompleted: [{ phaseId: 'legacy-draft', auditEntryId: 'audit-1' } as never],
        manualPauseCause: 'operator-paused',
        manualPauseAt: 1_700_000_000_000
      })
    });
    const store = new WorkspaceStateStore(memento);

    const result = await store.initialize();
    const run = store.getRun(DEFAULT_QUEUE_ID);

    expect(result.orphanedRunEvents).toHaveLength(1);
    expect(run?.status).toBe('canceled');
    expect(run?.id).toBe('lonely-run');
    expect(run?.phasesCompleted).toHaveLength(1);
    expect(run?.manualPauseCause).toBe('operator-paused');
  });

  it('leaves a Run whose Task row is still queued alone across a full initialize', async () => {
    const memento = new FakeMemento();
    void memento.update('schegent.queue', {
      [DEFAULT_QUEUE_ID]: {
        inFlightId: 'live-task',
        queueLifecycle: 'running',
        requests: [
          {
            id: 'live-task',
            description: 'a task that is genuinely running',
            status: 'in-flight',
            queueId: DEFAULT_QUEUE_ID,
            createdAt: 1_700_000_000_000,
            runId: 'live-run'
          }
        ]
      }
    });
    void memento.update('schegent.run', {
      [DEFAULT_QUEUE_ID]: makeRun({ id: 'live-run', featureId: 'live-task', status: 'running' })
    });
    const store = new WorkspaceStateStore(memento);

    const result = await store.initialize();

    expect(result.orphanedRunEvents).toEqual([]);
    expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('running');
  });
});
