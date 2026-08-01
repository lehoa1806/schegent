import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunDriver } from '../../../src/services/run-driver';
import type { RunDriverDeps } from '../../../src/services/run-driver';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { Memento } from '../../../src/state/workspace-state';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { PhaseRunOutput } from '../../../src/controller/phase-runner';

function makeLock(): any {
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
  };
}

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

describe('RunDriver Audit Emissions (Feature 072)', () => {
  let store: WorkspaceStateStore;
  let emitTaskLifecycleAuditSpy: ReturnType<typeof vi.fn>;
  let phaseRunnerMock: { run: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };
  let deps: RunDriverDeps;
  let driver: RunDriver;

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    
    emitTaskLifecycleAuditSpy = vi.fn().mockResolvedValue(undefined);
    phaseRunnerMock = { run: vi.fn(), abort: vi.fn() };
    
    deps = {
      store,
      runner: phaseRunnerMock as any,
      logger: new SanitizedLogger([]),
      options: { iterationCap: 5, cwd: '/test/cwd', cliPath: '/test/bin' } as any,
      monitor: null,
      retryCoordinator: { 
        registerAttempt: vi.fn(), 
        clear: vi.fn(),
        maybeEmitRetryRecovered: vi.fn().mockImplementation(async (r) => r) 
      } as any,
      queue: { finish: vi.fn(), pause: vi.fn() } as any,
      notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      statusBar: { update: vi.fn(), dispose: vi.fn() } as any,
      historyRecorder: { record: vi.fn() } as any,
      emitRunEndedBreakpointAudit: vi.fn(),
      emitTaskLifecycleAudit: emitTaskLifecycleAuditSpy,
      appendPhaseControlAudit: vi.fn(),
      appendRunnerProbeFailedAudit: vi.fn(),
      appendBreakpointAudit: vi.fn(),
      isContinueGate: { consume: vi.fn().mockReturnValue(false) } as any,
      lock: makeLock(),
      persistTransition: async (_oldRun, newRun) => {
        await store.setRun(newRun);
        return newRun;
      },
      scheduleAutoDrain: vi.fn()
    };
    
    driver = new RunDriver(deps);
  });

  it('emits task-execution-ended on failure (T016)', async () => {
    const runId = 'run-fail-1';
    await store.setRun({
      id: runId,
      taskId: 'task-1',
      featureId: 'task-1',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      currentPhase: 'plan',
      currentIteration: 0,
      pipeline: { id: 'pipe-1', name: 'Pipe', phases: [{ id: 'plan', title: 'Plan', runner: 'claude', effort: 'normal' }] },
      phasesCompleted: [],
      pendingRetry: false,
      delayedRetryCount: 0,
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      phaseOverrides: [],
      resumeTargetPhaseId: null,
      isWakeup: false
    } as any);

    phaseRunnerMock.run.mockResolvedValueOnce({
      result: { kind: 'malformed', warnings: [], fatalCause: 'Fatal error occurred', auditEntry: null },
      outcome: 'failed',
      terminationReason: 'error',
      stdoutSummary: '',
      stderrSummary: 'Fatal error occurred',
      exitCode: 1,
      warnings: ['Fatal error occurred'],
      auditEntryId: null
    } as PhaseRunOutput);

    const run = store.getRun()!;
    await driver.drive(run, 'Test description');
    
    console.log('Run after drive:', store.getRun());
    
    expect(emitTaskLifecycleAuditSpy).toHaveBeenCalledTimes(1);
    const [eventType, updatedRun, payload] = emitTaskLifecycleAuditSpy.mock.calls[0];
    expect(eventType).toBe('task-execution-ended');
    expect(updatedRun.id).toBe(runId);
    expect(payload).toMatchObject({
      taskId: 'task-1',
      runId,
      terminalStatus: 'failed',
      phasesTotal: 1,
      phasesCompleted: 0,
      phasesSkipped: 0
    });
    expect(typeof payload.durationMs).toBe('number');
    expect(payload.lastErrorSummary).toContain('Fatal error occurred');
  });

  it('emits task-execution-ended on completion (T016)', async () => {
    const runId = 'run-complete-1';
    await store.setRun({
      id: runId,
      taskId: 'task-2',
      featureId: 'task-2',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      currentPhase: 'plan',
      currentIteration: 0,
      pipeline: { id: 'pipe-1', name: 'Pipe', phases: [{ id: 'plan', title: 'Plan', runner: 'claude', effort: 'normal' }] },
      phasesCompleted: [],
      pendingRetry: false,
      delayedRetryCount: 0,
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      phaseOverrides: [],
      resumeTargetPhaseId: null,
      isWakeup: false
    } as any);

    phaseRunnerMock.run.mockResolvedValue({
      result: { kind: 'clean', auditEntry: null as never },
      outcome: 'clean',
      terminationReason: 'token',
      stdoutSummary: '',
      stderrSummary: '',
      exitCode: 0,
      warnings: [],
      auditEntryId: null
    } as PhaseRunOutput);

    const run = store.getRun()!;
    await driver.drive(run, 'Test description');
    
    expect(emitTaskLifecycleAuditSpy).toHaveBeenCalledTimes(1);
    const [eventType, updatedRun, payload] = emitTaskLifecycleAuditSpy.mock.calls[0];
    expect(eventType).toBe('task-execution-ended');
    expect(updatedRun.id).toBe(runId);
    expect(payload).toMatchObject({
      taskId: 'task-2',
      runId,
      terminalStatus: 'completed',
      phasesTotal: 1,
      phasesCompleted: 1,
      phasesSkipped: 0
    });
  });

  it('does not break drive outcome if audit emission fails (T017)', async () => {
    emitTaskLifecycleAuditSpy.mockRejectedValue(new Error('Audit disk write failed'));
    
    const runId = 'run-complete-2';
    await store.setRun({
      id: runId,
      taskId: 'task-3',
      featureId: 'task-3',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      currentPhase: 'plan',
      currentIteration: 0,
      pipeline: { id: 'pipe-1', name: 'Pipe', phases: [{ id: 'plan', title: 'Plan', runner: 'claude', effort: 'normal' }] },
      phasesCompleted: [],
      pendingRetry: false,
      delayedRetryCount: 0,
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      phaseOverrides: [],
      resumeTargetPhaseId: null,
      isWakeup: false
    } as any);

    phaseRunnerMock.run.mockResolvedValue({
      result: { kind: 'clean', auditEntry: null as never },
      outcome: 'clean',
      terminationReason: 'token',
      stdoutSummary: '',
      stderrSummary: '',
      exitCode: 0,
      warnings: [],
      auditEntryId: null
    } as PhaseRunOutput);

    const initialRun = store.getRun()!;
    await expect(driver.drive(initialRun, 'Test description')).resolves.toBeUndefined();
    
    const run = store.getRun()!;
    expect(run.status).toBe('completed');
  });
});
