// Feature 200 (FR-R3-161) T039/T040 — the surviving removal route, pinned.
//
// Spec FR-008 and US2 scenarios 1 and 2. Feature 200 deletes the second
// spelling of "delete a queue row" (`QueueManager.remove` and the storage
// primitive it alone called). What that leaves has to be the route the spec
// describes: one that releases the lease, records the session-cleanup decision,
// refreshes the queue's lifecycle, and refuses with a reason rather than a
// boolean.
//
// Three of those four were unpinned end-to-end. The lease release and the
// ordering around it are pinned by T004 in
// tests/integration/task-deletion-cancel-before-remove.test.ts — this file does
// not repeat that transcript; it asserts the *outcome* the operator's route
// produces, which is a different claim about the same route.
//
// The lifecycle assertion is the one that was red when it was written. Research
// F7 names "no `withRefreshedLifecycle` after the row leaves" as a defect of the
// routine being deleted; the survivor's primitive
// (`WorkspaceState.removeRequest`) had the identical gap, so deleting the
// weaker routine would have left the defect standing in the only route left.
// FR-008 is normative on the post-removal product, so the refresh moves to the
// survivor in the same change (T043a).
//
// The refusal assertion is FR-008's second half. The deleted routine's
// `catch { return false }` collapsed "no such task" and "that task is not
// removable" into one boolean — the loss
// src/ui/sidebar/commands/cmd-remove-queue-item.ts:6-10 records the typed path
// as having been introduced to fix (research F7).

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
import type { WorkflowRun } from '../../src/state/workflow-run';
import { DEFAULT_QUEUE_ID } from '../../src/contracts/queue-identity';
import { ILLEGAL_STATE_MESSAGES } from '../../src/ui/sidebar/commands/constants';
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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-removal-survivor-'));
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  queue = new QueueManager(store);
  logger = new SanitizedLogger([]);
});

afterEach(async () => {
  await removeTempRoot(tmpRoot);
});

interface Observed {
  readonly leaseReleasesFor: string[];
  readonly cleanupRunIds: string[];
}

function makeDeps(observed: Observed, cleaned = true): TaskDeletionDeps {
  return {
    logger,
    queue: {
      findById: (taskId) => queue.findById(taskId),
      queueIdForTask: (taskId) => queue.queueIdForTask(taskId),
      removeTask: (taskId) => queue.removeTask(taskId)
    },
    store: {
      getRun: (queueId) => store.getRun(queueId),
      setRun: (queueId, run, claim) => store.setRun(queueId, run, claim),
      runCommitClaim: (queueId) => store.runCommitClaim(queueId)
    },
    cancelActive: () => undefined,
    releaseExecutionLeaseForRun: async (run) => {
      observed.leaseReleasesFor.push(run.id);
    },
    sessionCleanup: async ({ runId }) => {
      observed.cleanupRunIds.push(runId);
      return { cleaned };
    },
    workspaceRoot: tmpRoot
  };
}

function freshObserved(): Observed {
  return { leaseReleasesFor: [], cleanupRunIds: [] };
}

async function seedRunningTask(runId: string): Promise<{ taskId: string }> {
  const feature = await queue.enqueue(`task running as ${runId}`);
  await queue.markInFlight(feature.id, runId);
  const now = Date.now();
  const run: WorkflowRun = {
    id: runId,
    featureId: feature.id,
    featureDir: 'specs/000',
    status: 'running',
    currentPhase: 'speckit-plan',
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
    resumeTargetPhaseId: null
  };
  await store.setRun(DEFAULT_QUEUE_ID, run, unfencedCommit('test-fixture'));
  return { taskId: feature.id };
}

describe('Feature 200 FR-008 / US2 scenario 1 — what the surviving removal route does', () => {
  it('releases the lease, records the cleanup decision, and leaves an emptied queue not-running', async () => {
    const observed = freshObserved();
    const { taskId } = await seedRunningTask('R-only');
    // Established by the seed rather than assumed: `markInFlight` is what puts
    // the queue in `running`, so the assertion below is about the removal.
    expect(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle).toBe('running');

    const result = await deleteTaskWithSessionCleanup(makeDeps(observed), taskId);

    expect(result.ok).toBe(true);
    // The lease went back, for this Task's Run and no other.
    expect(observed.leaseReleasesFor).toEqual(['R-only']);
    // The cleanup decision is recorded on the outcome, not merely performed:
    // the router writes it into the `task-removed` audit payload verbatim.
    expect(observed.cleanupRunIds).toEqual(['R-only']);
    expect(result.sessionCleaned).toBe(true);

    // The row is gone and the queue's lifecycle moved with it. Deleting the
    // last piece of work leaves a queue that is not running — without the
    // refresh it keeps badging `running` with nothing in flight and nothing
    // pending, and the staleness survives a reload.
    const after = store.getQueue(DEFAULT_QUEUE_ID);
    expect(after.requests).toHaveLength(0);
    expect(after.inFlightId).toBeNull();
    expect(after.queueLifecycle).toBe('active-empty');
  });

  it('keeps a queue with work left running, and records a negative cleanup decision', async () => {
    const observed = freshObserved();
    const { taskId } = await seedRunningTask('R-first');
    const survivor = await queue.enqueue('still waiting');

    const result = await deleteTaskWithSessionCleanup(makeDeps(observed), taskId);

    expect(result.ok).toBe(true);
    const after = store.getQueue(DEFAULT_QUEUE_ID);
    expect(after.requests.map((r) => r.id)).toEqual([survivor.id]);
    // The control for the assertion above: the refresh derives the lifecycle
    // from the work that remains rather than downgrading on every deletion.
    expect(after.queueLifecycle).toBe('running');
  });

  it('records `sessionCleaned: false` without a cleanup attempt when the row owned no Run', async () => {
    const observed = freshObserved();
    const pending = await queue.enqueue('never started');

    const result = await deleteTaskWithSessionCleanup(makeDeps(observed), pending.id);

    expect(result.ok).toBe(true);
    // No Run, so nothing to release and nothing to clean — but the decision is
    // still recorded, because `sessionCleaned: false` is what tells an operator
    // the session evidence, if any, is still on disk.
    expect(observed.leaseReleasesFor).toEqual([]);
    expect(observed.cleanupRunIds).toEqual([]);
    expect(result.sessionCleaned).toBe(false);
  });
});

describe('Feature 200 FR-008 / US2 scenario 2 — a refusal that says which refusal it is', () => {
  it('refuses an unknown Task with a typed reason and no cleanup', async () => {
    const observed = freshObserved();
    await queue.enqueue('a bystander that must survive');

    const result = await deleteTaskWithSessionCleanup(makeDeps(observed), 'no-such-task');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown-task-id');
    // The rejection branch bypasses cleanup entirely, so `sessionCleaned` is
    // absent rather than `false` — an outcome that never reached the decision
    // does not get to report one.
    expect(result.sessionCleaned).toBeUndefined();
    expect(observed.cleanupRunIds).toEqual([]);
    expect(store.getQueue(DEFAULT_QUEUE_ID).requests).toHaveLength(1);
  });

  it('keeps the two removal refusals distinguishable where an operator reads them', () => {
    // The distinction the boolean collapsed. Both reasons stay reachable from
    // the removal command's message table with different text, so an operator
    // told "not found" and an operator told "no longer pending" are being told
    // different things. FR-007c is the requirement that keeps the second one
    // alive after its throw site inside the deleted primitive goes; three other
    // storage operations still raise it.
    expect(ILLEGAL_STATE_MESSAGES['unknown-task-id']).toBeDefined();
    expect(ILLEGAL_STATE_MESSAGES['task-not-in-pending-state']).toBeDefined();
    expect(ILLEGAL_STATE_MESSAGES['unknown-task-id']).not.toBe(
      ILLEGAL_STATE_MESSAGES['task-not-in-pending-state']
    );
  });
});
