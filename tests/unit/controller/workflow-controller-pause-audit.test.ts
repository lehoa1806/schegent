import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SchegentWorkflowController } from '../../../src/controller/workflow-controller';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { Memento } from '../../../src/state/workspace-state';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { WorkflowControllerDeps } from '../../../src/controller/workflow-controller';

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

describe('WorkflowController Audit Emissions (Feature 072)', () => {
  let store: WorkspaceStateStore;
  let emitTaskLifecycleAuditSpy: ReturnType<typeof vi.fn>;
  let deps: WorkflowControllerDeps;
  let controller: SchegentWorkflowController;

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    
    emitTaskLifecycleAuditSpy = vi.fn().mockResolvedValue(undefined);
    
    deps = {
      historyStore: undefined,
      catalog: undefined,
      auditWriter: undefined,
      watchdog: undefined,
      sessionCleanup: undefined,
      getRetryCap: undefined
    };
    
    controller = new SchegentWorkflowController(
      {} as any, // runner
      store,
      { findById: vi.fn(), cascadedPause: vi.fn() } as any, // queue
      {} as any, // statusBar
      {} as any, // notifier
      new SanitizedLogger([]),
      {} as any, // lock
      {} as any, // options
      deps
    );
    // Mock the cancellation abstraction to prevent errors
    (controller as any).cancelActive = vi.fn();
    (controller as any).emitTaskLifecycleAudit = emitTaskLifecycleAuditSpy;
    (controller as any).appendPhaseControlAudit = vi.fn();
    (controller as any).retryCoordinator = { cancelPendingTimer: vi.fn() };
  });

  it('emits task-execution-paused on pauseActivePhase (T020)', async () => {
    const runId = 'run-pause-1';
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

    const result = await controller.pauseActivePhase();
    expect(result.ok).toBe(true);
    
    expect(emitTaskLifecycleAuditSpy).toHaveBeenCalledTimes(1);
    const [eventType, updatedRun, payload] = emitTaskLifecycleAuditSpy.mock.calls[0];
    expect(eventType).toBe('task-execution-paused');
    expect(updatedRun.id).toBe(runId);
    expect(payload).toMatchObject({
      taskId: 'task-1',
      runId,
      pauseCause: 'operator-paused'
    });
  });

  it('does not break pause outcome if audit emission fails (T020 robustness)', async () => {
    emitTaskLifecycleAuditSpy.mockRejectedValue(new Error('Audit write failed'));
    
    const runId = 'run-pause-2';
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

    await expect(controller.pauseActivePhase()).resolves.toMatchObject({ ok: true });
    
    const run = store.getRun()!;
    expect(run.manualPauseCause).toBe('operator-paused');
  });
});
