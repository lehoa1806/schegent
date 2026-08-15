import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import { QueueManager } from '../../../src/queue/queue-manager';
import type { PhaseRunner } from '../../../src/controller/phase-runner';
import type { SchegentStatusBar } from '../../../src/ui/status-bar';
import type { Notifier } from '../../../src/ui/notifications';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { WorkspaceLockManager } from '../../../src/state/lock';
import type { WorkflowRun, WorkflowRunStatus } from '../../../src/state/workflow-run';
import { BUILT_IN_PHASES } from '../../../src/config/pipeline-config';
import type { Memento } from '../../../src/state/workspace-state';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

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

function makeStatusBar(): SchegentStatusBar {
  return { update: vi.fn(), dispose: vi.fn() } as unknown as SchegentStatusBar;
}

function makeNotifier(): Notifier {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Notifier;
}

function makeLock(): WorkspaceLockManager {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

const opts = {
  cliPath: 'claude',
  cwd: '/repo',
  iterationCap: 5,
  timeoutMs: 5_000,
};

const STANDARD_PIPELINE = Object.freeze({
  id: 'speckit-new-feature',
  name: 'Spec-kit New Feature',
  phases: Object.freeze(
    [
      'speckit-specify',
      'speckit-clarify',
      'speckit-plan',
      'speckit-tasks',
      'speckit-analyze',
      'speckit-implement',
      'finalize'
    ].map((id) => Object.freeze(BUILT_IN_PHASES.find((p) => p.id === id)!))
  )
});

let memento: FakeMemento;
let store: WorkspaceStateStore;
let queue: QueueManager;
let phaseRunner: PhaseRunner;
let controller: SchegentWorkflowController;
let auditWriter: { append: ReturnType<typeof vi.fn> };
/** The `RunDriver` on the default queue's session — see the note in beforeEach. */
let activeDriver: { noteActivePhaseOverrideAbort: (runId: string, phaseId: string) => void };

beforeEach(async () => {
  memento = new FakeMemento();
  store = new WorkspaceStateStore(memento);
  await store.initialize();
  queue = new QueueManager(store);
  phaseRunner = { run: vi.fn() } as unknown as PhaseRunner;
  auditWriter = { append: vi.fn(async () => {}) };
  
  controller = new SchegentWorkflowController(
    phaseRunner,
    store,
    queue,
    makeStatusBar(),
    makeNotifier(),
    new SanitizedLogger(),
    makeLock(),
    opts,
    { auditWriter }
  );
  
  // Observe the real injected collaborator instead of replacing it after the
  // phase-control service has captured the dependency.
  //
  // Feature 093 (T042) — the driver is per-queue now, so the collaborator the
  // phase controls reach lives on the session for the Run's queue rather than on
  // a window-wide `controller.runDriver` field. These tests seed a `running` Run
  // directly, which in production always implies a live session driving it, so
  // the harness creates the session that state implies and spies on its real
  // driver. Without it the `sessions.peek(queueId)?.driver` seam would find no
  // session and silently no-op, which is correct for a queue that is not
  // executing and wrong as a stand-in for one that is.
  activeDriver = (controller as any).sessions.acquire(DEFAULT_QUEUE_ID).driver;
  vi.spyOn(activeDriver, 'noteActivePhaseOverrideAbort').mockImplementation(() => undefined);
  // `cancelActive` and `resumeExisting` stay controller-level: the phase-control
  // service captured bound closures that dispatch through `this`, so replacing
  // the methods is still observed at the call site.
  (controller as any).cancelActive = vi.fn();
  (controller as any).resumeExisting = vi.fn(async () => {});
});

async function seedRun(
  overrides: Partial<WorkflowRun> = {}
): Promise<{ feature: { id: string }; run: WorkflowRun }> {
  const feature = await queue.enqueue('skip feature');
  await queue.markInFlight(feature.id, 'run-skip-1');
  const now = Date.now();
  const run: WorkflowRun = {
    id: 'run-skip-1',
    featureId: feature.id,
    featureDir: 'specs/001-existing',
    status: 'running' as WorkflowRunStatus,
    currentPhase: 'speckit-clarify',
    currentIteration: 1,
    startedAt: now,
    lastTransitionAt: now,
    phasesCompleted: [
      {
        phase: 'speckit-specify',
        iteration: 1,
        startedAt: now - 1000,
        endedAt: now,
        result: 'clean',
        terminationReason: 'token',
        exitCode: 0,
        stdoutSummary: '',
        stderrSummary: '',
        auditEntryId: null
      }
    ],
    lastError: null,
    pipeline: STANDARD_PIPELINE,
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
  await store.setRun(DEFAULT_QUEUE_ID, run);
  return { feature, run };
}

describe('SchegentWorkflowController.skipPhase on active phase', () => {
  it('cancels the active phase and advances to next', async () => {
    await seedRun();
    const result = await controller.skipPhase('speckit-clarify');
    expect(result).toEqual({ ok: true });
    
    // Check that the queue's driver was told to abort the overridden phase
    expect(activeDriver.noteActivePhaseOverrideAbort).toHaveBeenCalledWith('run-skip-1', 'speckit-clarify');
    
    // Check that cancelActive was called
    expect((controller as any).cancelActive).toHaveBeenCalled();
  });

  it('phase-jumped audit event emitted with correct payload ({ reason: operator-jump, skippedPhaseId, nextPhaseId })', async () => {
    await seedRun();
    const result = await controller.skipPhase('speckit-clarify');
    expect(result).toEqual({ ok: true });
    
    // verify audit event
    const auditCalls = auditWriter.append.mock.calls.map(c => c[0]);
    const jumpCall = auditCalls.find(c => c.eventType === 'phase-jumped');
    expect(jumpCall).toBeDefined();
    expect(jumpCall.payload.reason).toBe('operator-jump');
    expect(jumpCall.payload.phaseId).toBe('speckit-clarify');
    expect(jumpCall.payload.phasesSkipped).toBe(1);
  });

  it('skip on terminal phase (last in pipeline) correctly ends the run', async () => {
    // finalize is the last phase
    await seedRun({ currentPhase: 'finalize' });
    const result = await controller.skipPhase('finalize');
    expect(result).toEqual({ ok: true });
    
    expect(activeDriver.noteActivePhaseOverrideAbort).toHaveBeenCalledWith('run-skip-1', 'finalize');
    expect((controller as any).cancelActive).toHaveBeenCalled();
  });

  it('skip when no active phase returns error result', async () => {
    const result = await controller.skipPhase('speckit-clarify');
    // "run-not-in-flight" because seedRun was not called
    expect(result).toEqual({ ok: false, reason: 'no-run-in-flight' });
  });

  it('skip when phase is paused resumes the phase to evaluate override', async () => {
    await seedRun({ status: 'paused', manualPauseAt: Date.now(), manualPauseCause: 'operator-paused' });
    const result = await controller.skipPhase('speckit-clarify');
    expect(result).toEqual({ ok: true });
    
    // The paused run is resumed and dispatch is scheduled so the override is
    // evaluated by the engine.
    expect(store.getRun(DEFAULT_QUEUE_ID)).toMatchObject({
      status: 'running',
      manualPauseAt: null,
      manualPauseCause: null
    });
    await new Promise(resolve => setImmediate(resolve));
    expect((controller as any).resumeExisting).toHaveBeenCalled();
  });
  
  it('skip when phase is failed wakes up the pipeline', async () => {
    await seedRun({ status: 'failed', lastError: { code: 'Error', message: 'Boom', phase: null, iteration: null, at: Date.now() } });
    const result = await controller.skipPhase('speckit-clarify');
    expect(result).toEqual({ ok: true });
    
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('running');
    expect(run.lastError).toBeNull();
    // pipeline woke up via resumeExisting
    await new Promise(resolve => setImmediate(resolve));
    expect((controller as any).resumeExisting).toHaveBeenCalled();
  });
});
