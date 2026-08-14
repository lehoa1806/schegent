// Feature 092 (T085, T086, US4) — the snapshot v4 envelope.
// Contract: specs/092-multi-queue-concurrency/contracts/snapshot-v4-and-drill-down.md
//
// Two things are pinned here and nothing else:
//
//   * The **shape** of the envelope — `schemaVersion: 4`, `queues` present,
//     `isPrimary` still at the root, and every per-run singular *absent*. The
//     absence assertions are the point of the version bump: FR-049 deletes the
//     singulars rather than deprecating them precisely so the compiler locates
//     every consumer, and a test that only checked for the new field would pass
//     just as happily against a snapshot that kept both.
//   * The **fields** of one `QueueRuntime`, against data-model.md §1.4.
//
// Isolation between queues is a behavioural guarantee, not a shape one, and
// lives in `tests/integration/per-queue-snapshot-isolation.test.ts`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import { createQueue, DEFAULT_QUEUE_ID } from '../../src/queue/queue-registry';
import { QueueManager } from '../../src/queue/queue-manager';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import type { WorkflowRun } from '../../src/state/workflow-run';
import { SCHEMA_VERSION, buildIdleSnapshot, type WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { StateProjector } from '../../src/ui/sidebar/state-projector';

/**
 * The per-run singulars FR-049 deletes. Named as data rather than as one
 * assertion apiece so a re-introduced field fails with its own name in the
 * message, and so the list is readable as the contract's deletion set.
 */
const DELETED_ROOT_SINGULARS = [
  'status',
  'activeFeature',
  'phases',
  'phaseOverrides',
  'manualPauseAt',
  'manualPauseCause',
  'phaseBreakpoints',
  'resumeTargetPhaseId',
  'activeRunId',
  'activePipeline',
  'runOutputs',
  'liveActivity',
  'workflowElapsedMs',
  'delayedRetry'
] as const;

/** Every field data-model.md §1.4 gives `QueueRuntime`, and only these. */
const QUEUE_RUNTIME_FIELDS = [
  'queueId',
  'name',
  'position',
  'lifecycle',
  'inFlightRun',
  'phases',
  'phaseOverrides',
  'manualPause',
  'phaseBreakpoints',
  'pendingCount',
  'tasks'
] as const;

const QUEUE_B = 'b1f2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

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

let store: WorkspaceStateStore;
let audit: AuditLogWriter;
let tmpRoot: string;

beforeEach(async () => {
  store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-snapshot-v4-'));
  audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function project(deps: Record<string, unknown> = {}): WorkflowSnapshot {
  const projector = new StateProjector({
    store,
    audit,
    ownerId: 'this-window',
    sanitize: (value: string | null | undefined) => value ?? '',
    ...deps
  });
  projector.start();
  const snapshot = projector.getCurrentSnapshot();
  projector.dispose();
  return snapshot;
}

function sampleRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-v4-1',
    featureId: 'feat-v4-1',
    featureDir: 'specs/001-x',
    status: 'running',
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
    resumeTargetPhaseId: null,
    ...overrides
  };
}

/** Registers `QUEUE_B` alongside the default queue. */
async function addSecondQueue(): Promise<void> {
  await store.setQueueRegistry(
    createQueue(store.getQueueRegistry(), {
      id: QUEUE_B,
      name: 'Queue B',
      now: 1_700_000_000_000
    })
  );
}

describe('snapshot v4 — envelope shape (T085, FR-048 – FR-050)', () => {
  it('advances the version identifier to 4 so the change is detectable', () => {
    expect(SCHEMA_VERSION).toBe(4);
    expect(project().schemaVersion).toBe(4);
    expect(buildIdleSnapshot({ isPrimary: true }).schemaVersion).toBe(4);
  });

  it('carries `queues` as an array, on both a live and an idle snapshot', () => {
    expect(Array.isArray(project().queues)).toBe(true);
    expect(Array.isArray(buildIdleSnapshot({ isPrimary: true }).queues)).toBe(true);
  });

  it('keeps `isPrimary` at the root — window primacy is per-window, not per-queue', () => {
    expect(typeof project().isPrimary).toBe('boolean');
    expect(buildIdleSnapshot({ isPrimary: true }).isPrimary).toBe(true);
    expect(buildIdleSnapshot({ isPrimary: false }).isPrimary).toBe(false);
  });

  it.each(DELETED_ROOT_SINGULARS)(
    'has no top-level `%s` — deleted, not deprecated (FR-049)',
    async (field) => {
      await store.setRun(DEFAULT_QUEUE_ID, sampleRun());
      const snapshot = project() as unknown as Record<string, unknown>;
      expect(field in snapshot).toBe(false);
      expect(buildIdleSnapshot({ isPrimary: true }) as unknown as Record<string, unknown>).not.toHaveProperty(
        field
      );
    }
  );

  it('publishes one runtime per registry entry, in position order', async () => {
    await addSecondQueue();
    const snapshot = project();
    expect(snapshot.queues.map((runtime) => runtime.queueId)).toEqual([DEFAULT_QUEUE_ID, QUEUE_B]);
    expect(snapshot.queues.map((runtime) => runtime.position)).toEqual([0, 1]);
  });

  it('freezes the runtime list and each runtime', async () => {
    await addSecondQueue();
    const snapshot = project();
    expect(Object.isFrozen(snapshot.queues)).toBe(true);
    for (const runtime of snapshot.queues) expect(Object.isFrozen(runtime)).toBe(true);
  });
});

describe('snapshot v4 — QueueRuntime fields (T086, FR-048, FR-056)', () => {
  it('carries exactly the eleven fields of data-model.md §1.4', () => {
    const runtime = project().queues[0];
    expect(runtime).toBeDefined();
    expect(Object.keys(runtime!).sort()).toEqual([...QUEUE_RUNTIME_FIELDS].sort());
  });

  it('sources queueId, name and position from the registry entry', async () => {
    await addSecondQueue();
    const runtime = project().queues.find((entry) => entry.queueId === QUEUE_B);
    expect(runtime?.name).toBe('Queue B');
    expect(runtime?.position).toBe(1);
  });

  it('carries the queue lifecycle and its own pending count', async () => {
    const manager = new QueueManager(store);
    await manager.enqueue('first on default', { queueId: DEFAULT_QUEUE_ID });
    await manager.enqueue('second on default', { queueId: DEFAULT_QUEUE_ID });
    await addSecondQueue();
    await manager.enqueue('only on B', { queueId: QUEUE_B });

    const snapshot = project();
    const byId = new Map(snapshot.queues.map((runtime) => [runtime.queueId, runtime]));
    expect(byId.get(DEFAULT_QUEUE_ID)?.pendingCount).toBe(2);
    expect(byId.get(QUEUE_B)?.pendingCount).toBe(1);
    expect(byId.get(DEFAULT_QUEUE_ID)?.lifecycle).toBe(store.getQueue(DEFAULT_QUEUE_ID).queueLifecycle);
  });

  it("carries each queue's own Task rows, in position order, and nobody else's (T108, FR-057)", async () => {
    // The Queue Detail tier lists these. `QueueProjection.orderedItems` cannot
    // serve them: it is the default queue's rows, and its indices are the global
    // address space the reorder handler translates.
    const manager = new QueueManager(store);
    await manager.enqueue('first on default', { queueId: DEFAULT_QUEUE_ID });
    await addSecondQueue();
    await manager.enqueue('only on B', { queueId: QUEUE_B });

    const byId = new Map(project().queues.map((runtime) => [runtime.queueId, runtime]));
    expect(byId.get(DEFAULT_QUEUE_ID)?.tasks.map((task) => task.label)).toEqual(['first on default']);
    expect(byId.get(QUEUE_B)?.tasks.map((task) => task.label)).toEqual(['only on B']);
    for (const runtime of byId.values()) {
      for (const task of runtime.tasks) expect(task.queueId).toBe(runtime.queueId);
    }
  });

  it('counts pendingCount off the same rows it publishes', async () => {
    const manager = new QueueManager(store);
    await manager.enqueue('one', { queueId: DEFAULT_QUEUE_ID });
    await manager.enqueue('two', { queueId: DEFAULT_QUEUE_ID });
    const runtime = project().queues[0]!;
    expect(runtime.pendingCount).toBe(runtime.tasks.filter((task) => task.status === 'pending').length);
  });

  it('leaves inFlightRun null and the run-derived lists empty with no run', () => {
    const runtime = project().queues[0]!;
    expect(runtime.inFlightRun).toBeNull();
    expect(runtime.phases).toEqual([]);
    expect(runtime.phaseOverrides).toEqual([]);
    expect(runtime.manualPause).toBeNull();
    expect(runtime.phaseBreakpoints).toEqual([]);
    expect(runtime.tasks).toEqual([]);
  });

  it('folds the run-scoped singulars into inFlightRun on the owning queue', async () => {
    const manager = new QueueManager(store);
    const enqueued = await manager.enqueue('runs here', { queueId: DEFAULT_QUEUE_ID });
    // `resumeTargetPhaseId` is non-null iff the run is breakpoint-paused — a
    // persisted-run invariant `setRun` enforces, so the pause pair travels with
    // the resume target rather than being set on its own.
    await store.setRun(DEFAULT_QUEUE_ID, 
      sampleRun({
        featureId: enqueued.id,
        pipeline: { id: 'ported', name: 'Ported', phases: [] } as unknown as WorkflowRun['pipeline'],
        manualPauseAt: 1_700_000_002_000,
        manualPauseCause: 'breakpoint-paused',
        resumeTargetPhaseId: 'speckit-tasks'
      })
    );

    const runtime = project().queues.find((entry) => entry.queueId === DEFAULT_QUEUE_ID);
    expect(runtime?.inFlightRun).not.toBeNull();
    expect(runtime?.inFlightRun?.runId).toBe('run-v4-1');
    expect(runtime?.inFlightRun?.status).toBe('running');
    expect(runtime?.inFlightRun?.feature?.id).toBe(enqueued.id);
    expect(runtime?.inFlightRun?.pipeline?.id).toBe('ported');
    expect(runtime?.inFlightRun?.resumeTargetPhaseId).toBe('speckit-tasks');
    expect(runtime?.inFlightRun?.delayedRetry.delayedRetryCount).toBe(0);
    expect(runtime?.phases.length).toBeGreaterThan(0);
  });

  it('projects manual-pause state as one nullable pair rather than two loose fields', async () => {
    const manager = new QueueManager(store);
    const enqueued = await manager.enqueue('paused here', { queueId: DEFAULT_QUEUE_ID });
    await store.setRun(DEFAULT_QUEUE_ID, 
      sampleRun({
        featureId: enqueued.id,
        manualPauseAt: 1_700_000_001_000,
        manualPauseCause: 'operator-paused'
      })
    );

    const runtime = project().queues.find((entry) => entry.queueId === DEFAULT_QUEUE_ID);
    expect(runtime?.manualPause).toEqual({
      at: new Date(1_700_000_001_000).toISOString(),
      cause: 'operator-paused'
    });
  });

  it('projects phase overrides and breakpoints under the owning queue, sorted by setAt', async () => {
    const manager = new QueueManager(store);
    const enqueued = await manager.enqueue('overridden here', { queueId: DEFAULT_QUEUE_ID });
    await store.setRun(DEFAULT_QUEUE_ID, 
      sampleRun({
        featureId: enqueued.id,
        phaseOverrides: [
          {
            phaseId: 'speckit-clarify',
            action: 'skipped',
            setAt: 1_700_000_000_000,
            actor: 'operator'
          }
        ],
        phaseBreakpoints: [
          { phaseId: 'speckit-implement', setAt: 1_700_000_002_000, actor: 'operator' },
          { phaseId: 'speckit-tasks', setAt: 1_700_000_001_000, actor: 'operator' }
        ]
      })
    );

    const runtime = project().queues.find((entry) => entry.queueId === DEFAULT_QUEUE_ID);
    expect(runtime?.phaseOverrides).toEqual([{ phaseId: 'speckit-clarify', action: 'skipped' }]);
    expect(runtime?.phaseBreakpoints.map((breakpoint) => breakpoint.phaseId)).toEqual([
      'speckit-tasks',
      'speckit-implement'
    ]);
  });
});
