// FR-R4-F02 (spec 240, US1; contract U3 G9 to G11; FR-003, FR-005) — an unattended resume rechecks
// eligibility INSIDE the lease, on the Run as it is then.
//
// The admission service selects a queue from a read of the Run map, and the resume that follows
// is several awaits away: the queue's lease is claimed in between. A write that lands in that gap
// (the operator pauses, the Run is replaced, the Run ends) must not be resumed over. So with an
// `unattended` wakeup, `admitResume` runs the eligibility decision on the Run read inside the
// `KEYS.run` link, after the lease is held, and refuses with `NOT_RESUMED`: nothing is persisted,
// the Task is not marked in flight, and no announcement is raised.
//
// Without `unattended` the resume is byte for byte today's: an explicit operator retry of a failed
// Run resets its retry count (FR-005, US1-6).
import { describe, expect, it, vi } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { ExecutionLeaseManager } from '../../../src/state/execution-lease';
import { WorkspaceStateStore, type Memento } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import { SanitizedLogger } from '../../../src/lib/logger';
import { DEFAULT_QUEUE_ID } from '../../../src/contracts/queue-identity';
import { snapshotPhaseDef, snapshotPipelineContract } from '../../../src/config/pipeline-snapshot';
import type { PhaseDef, PipelineDef } from '../../../src/config/pipeline-config';
import type { PhaseRunner } from '../../../src/controller/phase-runner';
import type { UnattendedWakeup } from '../../../src/services/unattended-eligibility';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { WorkflowRun } from '../../../src/state/workflow-run';

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

const COMPOSE: PhaseDef = { id: 'compose', name: 'Compose', version: 1, instruction: 'Write.' };
const DONE: PhaseDef = { id: 'done', name: 'Done', version: 1, instruction: '(no-op)' };
const FLOW: PipelineDef = { id: 'recheck-flow', name: 'Recheck Flow', phases: ['compose'] };
const PIPELINE = snapshotPipelineContract(
  FLOW,
  [COMPOSE, DONE].map((phase) => snapshotPhaseDef(phase, 'claude'))
);

const NOW = 1_700_000_000_000;

/** The lease claim is the step between selection and the in-lease read, so a test hooks it. */
class HookedLease extends ExecutionLeaseManager {
  public beforeClaim: (() => Promise<void>) | null = null;
  override async tryAcquire(queueId: string): ReturnType<ExecutionLeaseManager['tryAcquire']> {
    await this.beforeClaim?.();
    return super.tryAcquire(queueId);
  }
}

async function rig(): Promise<{
  controller: SchegentWorkflowController;
  store: WorkspaceStateStore;
  queue: QueueManager;
  lease: HookedLease;
  warn: ReturnType<typeof vi.fn>;
  taskId: string;
}> {
  const store = new WorkspaceStateStore(new FakeMemento());
  await store.initialize();
  const queue = new QueueManager(store);
  const lease = new HookedLease(store, 'this-window');
  const warn = vi.fn();
  const controller = new SchegentWorkflowController(
    { run: vi.fn(), evictStagnationTracker: vi.fn() } as unknown as PhaseRunner,
    store,
    queue,
    { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar,
    { info: vi.fn(), warn, error: vi.fn() } as unknown as Notifier,
    new SanitizedLogger(),
    {
      release: vi.fn(async () => {}), tryAcquire: vi.fn(), heartbeat: vi.fn(),
      isHeld: vi.fn(), ownerOfRecord: vi.fn(), id: 'this-window'
    } as unknown as WorkspaceLockManager,
    { cliPath: 'claude', cwd: '/repo', iterationCap: 5, timeoutMs: 5_000 },
    { executionLease: lease }
  );
  const task = await queue.enqueue('a task', { pipelineId: FLOW.id });
  return { controller, store, queue, lease, warn, taskId: task.id };
}

function pausedRun(taskId: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: taskId,
    featureDir: '',
    status: 'paused',
    currentPhase: 'compose',
    currentIteration: 1,
    startedAt: 1,
    lastTransitionAt: 1,
    phasesCompleted: [],
    lastError: null,
    pipeline: PIPELINE,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    phaseOverrides: [],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    resumeTargetPhaseId: null,
    creditPause: { pausedAt: 1, windowStartedAt: 2, stoppedAt: null },
    ...overrides
  } as unknown as WorkflowRun;
}

const CREDITS: UnattendedWakeup = { cause: 'credits-restored', queueId: DEFAULT_QUEUE_ID, evidenceAt: NOW };

describe('a write between selection and the lease is not resumed over (US1-4)', () => {
  const CHANGES: ReadonlyArray<readonly [string, (r: Awaited<ReturnType<typeof rig>>) => Promise<void>]> = [
    [
      'an operator pause',
      async ({ store }) => {
        await store.updateRun(
          DEFAULT_QUEUE_ID,
          {
            runId: 'run-1',
            allowedStatuses: ['paused'],
            label: 'pause',
            patch: () => ({ manualPauseAt: NOW, manualPauseCause: 'operator-paused', creditPause: null })
          },
          unfencedCommit('test-fixture')
        );
      }
    ],
    [
      'the credit pause cleared by another path',
      async ({ store }) => {
        await store.updateRun(
          DEFAULT_QUEUE_ID,
          { runId: 'run-1', allowedStatuses: ['paused'], label: 'resume', patch: () => ({ creditPause: null }) },
          unfencedCommit('test-fixture')
        );
      }
    ],
    [
      'the credit-polling window having stopped',
      async ({ store }) => {
        await store.updateRun(
          DEFAULT_QUEUE_ID,
          {
            runId: 'run-1',
            allowedStatuses: ['paused'],
            label: 'resume',
            patch: () => ({ creditPause: { pausedAt: 1, windowStartedAt: 2, stoppedAt: 3 } })
          },
          unfencedCommit('test-fixture')
        );
      }
    ],
    [
      'a new Run id',
      async ({ store, taskId }) => {
        await store.setRun(DEFAULT_QUEUE_ID, pausedRun(taskId, { id: 'run-2' }), unfencedCommit('test-fixture'));
      }
    ],
    [
      'a terminal status',
      async ({ store, taskId }) => {
        await store.setRun(
          DEFAULT_QUEUE_ID,
          pausedRun(taskId, { status: 'completed', creditPause: null }),
          unfencedCommit('test-fixture')
        );
      }
    ]
  ];

  it.each(CHANGES)('%s: not resumed, nothing persisted, not marked in flight, no announcement', async (_name, change) => {
    const r = await rig();
    await r.store.setRun(DEFAULT_QUEUE_ID, pausedRun(r.taskId), unfencedCommit('test-fixture'));
    const markInFlight = vi.spyOn(r.queue, 'markInFlight');
    r.lease.beforeClaim = async () => {
      await change(r);
      r.lease.beforeClaim = null;
    };

    const admission = await r.controller.admitResume(DEFAULT_QUEUE_ID, { unattended: CREDITS });

    expect(admission.resumed).toBe(false);
    expect(markInFlight).not.toHaveBeenCalled();
    expect(r.warn).not.toHaveBeenCalled();
    const afterRefusal = JSON.stringify(r.store.getRun(DEFAULT_QUEUE_ID));
    expect(afterRefusal).not.toContain('"status":"running"');
    // Nothing the refused resume could have written is there: the Run is as the change left it.
    expect(r.store.getRun(DEFAULT_QUEUE_ID)?.status).not.toBe('running');
  });

  it('control: with no change in the gap, the same unattended resume is admitted', async () => {
    const r = await rig();
    await r.store.setRun(DEFAULT_QUEUE_ID, pausedRun(r.taskId), unfencedCommit('test-fixture'));

    const admission = await r.controller.admitResume(DEFAULT_QUEUE_ID, { unattended: CREDITS });
    void admission.completed.catch(() => undefined);

    expect(admission.resumed).toBe(true);
    const run = r.store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('running');
    expect(run.creditPause ?? null).toBeNull();
  });

  it('an admitted unattended resume is announced once, naming the queue, the Run and the phase', async () => {
    const r = await rig();
    await r.store.setRun(DEFAULT_QUEUE_ID, pausedRun(r.taskId), unfencedCommit('test-fixture'));

    const admission = await r.controller.admitResume(DEFAULT_QUEUE_ID, { unattended: CREDITS });
    void admission.completed.catch(() => undefined);

    expect(admission.resumed).toBe(true);
    expect(r.warn).toHaveBeenCalledTimes(1);
    const message = String(r.warn.mock.calls[0]?.[0]);
    expect(message).toContain(`queue "${DEFAULT_QUEUE_ID}"`);
    expect(message).toContain('run run-1');
    expect(message).toContain('phase "compose"');
  });

  it('an explicit resume with no wakeup raises no announcement of its own', async () => {
    const r = await rig();
    await r.store.setRun(DEFAULT_QUEUE_ID, pausedRun(r.taskId, { creditPause: null }), unfencedCommit('test-fixture'));

    const admission = await r.controller.admitResume(DEFAULT_QUEUE_ID);
    void admission.completed.catch(() => undefined);

    expect(admission.resumed).toBe(true);
    expect(r.warn).not.toHaveBeenCalled();
  });

  it('an unattended resume of a Run that is no longer paused is refused inside the lease', async () => {
    const r = await rig();
    await r.store.setRun(
      DEFAULT_QUEUE_ID,
      pausedRun(r.taskId, { status: 'failed', creditPause: null, delayedRetryCount: 5 }),
      unfencedCommit('test-fixture')
    );
    const before = JSON.stringify(r.store.getRun(DEFAULT_QUEUE_ID));

    const admission = await r.controller.admitResume(DEFAULT_QUEUE_ID, { unattended: CREDITS });

    expect(admission.resumed).toBe(false);
    expect(JSON.stringify(r.store.getRun(DEFAULT_QUEUE_ID))).toBe(before);
    expect(r.store.getRun(DEFAULT_QUEUE_ID)?.delayedRetryCount).toBe(5);
  });
});

describe('an explicit retry is unchanged (FR-005, US1-6; pins)', () => {
  it('without unattended, resuming a failed Run resets its retry count', async () => {
    const r = await rig();
    await r.store.setRun(
      DEFAULT_QUEUE_ID,
      pausedRun(r.taskId, { status: 'failed', creditPause: null, delayedRetryCount: 5 }),
      unfencedCommit('test-fixture')
    );

    const admission = await r.controller.admitResume(DEFAULT_QUEUE_ID);
    void admission.completed.catch(() => undefined);

    expect(admission.resumed).toBe(true);
    const run = r.store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('running');
    expect(run.delayedRetryCount).toBe(0);
  });
});
