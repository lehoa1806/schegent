import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueueManager } from '../../../src/queue/queue-manager';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { Memento } from '../../../src/state/workspace-state';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';

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

describe('QueueManager Audit Emissions (Feature 072)', () => {
  let store: WorkspaceStateStore;
  let queue: QueueManager;
  let appendSpy: ReturnType<typeof vi.fn>;
  let mockAuditHook: Pick<AuditLogWriter, 'append'>;

  beforeEach(async () => {
    const memento = new FakeMemento();
    store = new WorkspaceStateStore(memento);
    await store.initialize();
    
    appendSpy = vi.fn().mockResolvedValue(undefined);
    mockAuditHook = { append: appendSpy };
    queue = new QueueManager(store);
    queue.setLifecycleAuditHook(mockAuditHook as any);
  });

  it('emits task-execution-started after markInFlight succeeds with isResume=false for fresh starts (T015, T022)', async () => {
    const task = await queue.enqueue('Test task', { pipelineId: 'my-pipeline' });
    const runId = 'run-123';
    
    // Set a dummy run so pipelineId can be extracted.
    vi.spyOn(store, 'getRun').mockReturnValue({
      id: runId,
      taskId: task.id,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'in-flight',
      pipeline: { id: 'my-pipeline', name: 'My Pipeline', phases: [] },
      phasesCompleted: [],
      pendingRetry: false,
      delayedRetryCount: 0,
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      phaseOverrides: [],
      resumeTargetPhaseId: null
    } as any);

    await queue.markInFlight(task.id, runId, false);
    
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const event = appendSpy.mock.calls[0][0];
    expect(event).toMatchObject({
      runId,
      phase: 'queue-manager',
      eventType: 'task-execution-started',
      payload: {
        taskId: task.id,
        runId,
        queueId: task.queueId,
        pipelineId: 'my-pipeline',
        isResume: false
      }
    });
  });

  it('emits task-execution-started with isResume=true for restarts (T023)', async () => {
    const task = await queue.enqueue('Test task');
    const runId = 'run-456';
    
    await queue.markInFlight(task.id, runId, true);
    
    expect(appendSpy).toHaveBeenCalledTimes(1);
    const event = appendSpy.mock.calls[0][0];
    expect(event.payload.isResume).toBe(true);
  });

  it('does not break markInFlight success if audit emission fails', async () => {
    appendSpy.mockRejectedValue(new Error('Audit disk write failed'));
    
    const task = await queue.enqueue('Test task');
    const runId = 'run-789';
    
    // The promise should still resolve.
    await expect(queue.markInFlight(task.id, runId, false)).resolves.toBeUndefined();
    
    // And the state should be updated to in-flight.
    const inFlight = store.getQueue('default').requests.find(r => r.id === task.id);
    expect(inFlight?.status).toBe('in-flight');
  });
});
