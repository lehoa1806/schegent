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
    withLock: async function (this: { release(): Promise<void> }, _scope: string, fn: (session: { retain(): void }) => Promise<unknown>) {
      let retain = false;
      try {
        return await fn({ retain: () => { retain = true; } });
      } finally {
        if (!retain) await this.release().catch(() => undefined);
      }
    },
    id: 'this-window'
  } as unknown as WorkspaceLockManager;
}

const opts = {
  cliPath: 'claude',
  cwd: '/repo',
  iterationCap: 5,
  timeoutMs: 5_000,
  perPhaseRulesEnabled: false
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
  
  // mock the runDriver noteActivePhaseOverrideAbort
  (controller as any).runDriver = {
    noteActivePhaseOverrideAbort: vi.fn(),
    drive: vi.fn(async () => {})
  };
  (controller as any).cancelActive = vi.fn();
  (controller as any).resumeActivePhase = vi.fn(async () => {});
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
  await store.setRun(run);
  return { feature, run };
}

describe('SchegentWorkflowController.skipPhase on active phase', () => {
  it('cancels the active phase and advances to next', async () => {
    await seedRun();
    const result = await controller.skipPhase('speckit-clarify');
    expect(result).toEqual({ ok: true });
    
    // Check that runDriver.noteActivePhaseOverrideAbort was called
    expect((controller as any).runDriver.noteActivePhaseOverrideAbort).toHaveBeenCalledWith('run-skip-1', 'speckit-clarify');
    
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
    
    expect((controller as any).runDriver.noteActivePhaseOverrideAbort).toHaveBeenCalledWith('run-skip-1', 'finalize');
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
    
    // ensure resumeActivePhase is called so it advances
    expect((controller as any).resumeActivePhase).toHaveBeenCalled();
  });
  
  it('skip when phase is failed wakes up the pipeline', async () => {
    await seedRun({ status: 'failed', lastError: { code: 'Error', message: 'Boom', phase: null, iteration: null, at: Date.now() } });
    const result = await controller.skipPhase('speckit-clarify');
    expect(result).toEqual({ ok: true });
    
    const run = store.getRun()!;
    expect(run.status).toBe('running');
    expect(run.lastError).toBeNull();
    // pipeline woke up via resumeExisting
    await new Promise(resolve => setImmediate(resolve));
    expect((controller as any).resumeExisting).toHaveBeenCalled();
  });
});
