// Feature 200 (FR-R3-161) T004 — the cancel-before-delete pin.
//
// Spec FR-008a. `deleteTaskWithSessionCleanup` is the product's real deletion
// route, and the protection it carries is an *ordering*: a Task whose Run is
// still non-terminal must have that Run cancelled and persisted as `canceled`,
// and its execution lease released, BEFORE the queue row is removed. The
// controller says so itself at src/controller/task-deletion.ts:84-86 — "Any
// non-terminal Run status must go through this same cancel/release sequence
// before the row is removed" — and research F16 records that nothing asserted
// it.
//
// What was mistaken for that protection lived one layer down, in
// `QueueManager.remove`'s own inline pending-only guard. Feature 200 deletes
// that routine, and with it the two assertions at
// tests/unit/queue/queue-manager.test.ts:263 and :275. The surviving storage
// primitive `WorkspaceState.removeRequest` has **no status guard** at all: it
// removes any row and clears the in-flight pointer. So the ordering above is
// the only thing standing between a delete and an orphaned live session, and
// it gets pinned here, in the same change that removes the weaker guard.
//
// The nearest existing test — tests/unit/controller/delete-task-cleanup.test.ts
// 'in-flight task — cancel runs BEFORE cleanup' — anchors the cancel on the
// *session cleanup*, which happens after `removeTask` either way. Moving
// `removeTask` ahead of the cancel leaves that test green. This file anchors on
// `removeTask` itself, which is the step FR-008a is about.
//
// Assertions are on the observed order of the real calls, not on spy counts: a
// count survives a reordering, which is precisely the mutation this pin exists
// to catch.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteTaskWithSessionCleanup,
  type TaskDeletionDeps
} from '../../src/controller/task-deletion';
import { QueueManager } from '../../src/queue/queue-manager';
import { SanitizedLogger } from '../../src/lib/logger';
import { unfencedCommit } from '../../src/state/ownership-claim';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { WorkflowRun, WorkflowRunStatus } from '../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { removeTempRoot } from '../temp-root-cleanup';

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

let tmpRoot: string;
let store: WorkspaceStateStore;
let queue: QueueManager;
let logger: SanitizedLogger;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-cancel-before-remove-'));
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  queue = new QueueManager(store);
  logger = new SanitizedLogger([]);
});

afterEach(async () => {
  await removeTempRoot(tmpRoot);
});

/**
 * Wrap the real store and queue so every step of the sequence appends its own
 * name to a shared transcript. Nothing is stubbed out: the real
 * `QueueManager.removeTask` and the real `WorkspaceStateStore.setRun` run, so a
 * passing transcript describes what the product actually did.
 */
// `runStatusAtRemoval` is written from an optional-chained read, so it carries
// "there was no run at all" as a value. Typed `?: string | undefined` rather
// than `?: string` so the sample stays assignable under
// `exactOptionalPropertyTypes` — the distinction that flag exists to make, and
// here the undefined case is real evidence rather than an absent key.
function makeRecordingDeps(
  order: string[],
  observed: { runStatusAtRemoval?: string | undefined } = {}
): TaskDeletionDeps {
  return {
    logger,
    queue: {
      findById: (taskId) => queue.findById(taskId),
      queueIdForTask: (taskId) => queue.queueIdForTask(taskId),
      removeTask: async (taskId) => {
        order.push('removeTask');
        // Sampled at the moment of removal: the state the store is actually in
        // when the row goes. This is the ordering claim expressed as data
        // rather than as call sequence, so a reordering fails it twice.
        observed.runStatusAtRemoval = store.getRun(queue.queueIdForTask(taskId))?.status;
        return queue.removeTask(taskId);
      }
    },
    store: {
      getRun: (queueId) => store.getRun(queueId),
      setRun: async (queueId, run, claim) => {
        if (run?.status === 'canceled') order.push('setRun:canceled');
        return store.setRun(queueId, run, claim);
      },
      runCommitClaim: (queueId) => store.runCommitClaim(queueId)
    },
    cancelActive: () => {
      order.push('cancelActive');
    },
    releaseExecutionLeaseForRun: async () => {
      order.push('releaseLease');
    },
    sessionCleanup: async () => {
      order.push('sessionCleanup');
      return { cleaned: true };
    },
    workspaceRoot: tmpRoot
  };
}

async function seedInFlightTaskWithRun(
  runId: string,
  runStatus: WorkflowRunStatus
): Promise<{ taskId: string }> {
  const feature = await queue.enqueue(`task whose run is ${runStatus}`);
  await queue.markInFlight(feature.id, runId);
  const now = Date.now();
  const run: WorkflowRun = {
    id: runId,
    featureId: feature.id,
    featureDir: 'specs/000',
    status: runStatus,
    currentPhase: 'speckit-plan',
    currentIteration: 1,
    startedAt: now,
    lastTransitionAt: now,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: runStatus === 'paused' ? 1 : 0,
    pendingRetryAt: runStatus === 'paused' ? now + 60_000 : null,
    pendingRetryCause: runStatus === 'paused' ? 'rate_limit' : null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null
  };
  await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
  return { taskId: feature.id };
}

describe('Feature 200 FR-008a — cancel and persist before the row is removed', () => {
  // Both non-terminal Run statuses a live Task can carry. `running` is the
  // obvious one; `paused` is a delayed-retry countdown, where the Run waits to
  // auto-resume while the task row stays `in-flight` (FR-R3-153 widened the
  // controller's guard to admit it). Neither may reach `removeTask` uncancelled.
  it.each(['running', 'paused'] as const)(
    'deleting an in-flight task whose Run is %s cancels, persists and releases before removing the row',
    async (runStatus) => {
      const order: string[] = [];
      const observed: { runStatusAtRemoval?: string | undefined } = {};
      const { taskId } = await seedInFlightTaskWithRun(`R-${runStatus}`, runStatus);

      const result = await deleteTaskWithSessionCleanup(makeRecordingDeps(order, observed), taskId);

      expect(result.ok).toBe(true);

      // The whole sequence, in the order the product performed it. Asserted
      // as a sequence rather than as counts: every mutation FR-008a names —
      // reordering the cancel after the removal, or skipping it — changes this
      // array while leaving every call count identical.
      expect(order).toEqual([
        'cancelActive',
        'setRun:canceled',
        'releaseLease',
        'removeTask',
        'sessionCleanup'
      ]);

      // Stated again pairwise, so a failure names which edge broke rather than
      // only that the transcript differs.
      expect(order.indexOf('cancelActive')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('cancelActive')).toBeLessThan(order.indexOf('removeTask'));
      expect(order.indexOf('setRun:canceled')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('setRun:canceled')).toBeLessThan(order.indexOf('removeTask'));
      expect(order.indexOf('releaseLease')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('releaseLease')).toBeLessThan(order.indexOf('removeTask'));

      // The persisted Run had already reached `canceled` at the instant the row
      // was removed — the ordering claim as state, not as call sequence.
      expect(observed.runStatusAtRemoval).toBe('canceled');

      // And the deletion really completed, so the transcript above describes a
      // finished operation rather than one that aborted early.
      expect(queue.findById(taskId)).toBeNull();
    }
  );

  // FR-008a's second half. The controller guards the cancel/persist step behind
  // a `try`/`catch` so a refused fenced commit cannot strand the deletion
  // partway. That tolerance must not extend to the *ordering*: a failed persist
  // still has to have been attempted, and released, before the row goes.
  it('still cancels and releases before removing the row when the canceled-run commit is refused', async () => {
    const order: string[] = [];
    const { taskId } = await seedInFlightTaskWithRun('R-refused', 'running');

    const deps = makeRecordingDeps(order);
    const refusing: TaskDeletionDeps = {
      ...deps,
      store: {
        ...deps.store,
        setRun: async (_queueId, run) => {
          if (run?.status === 'canceled') order.push('setRun:canceled');
          throw new Error('fenced commit refused');
        }
      }
    };

    const result = await deleteTaskWithSessionCleanup(refusing, taskId);

    expect(result.ok).toBe(true);
    expect(order).toEqual([
      'cancelActive',
      'setRun:canceled',
      'releaseLease',
      'removeTask',
      'sessionCleanup'
    ]);
  });
});
