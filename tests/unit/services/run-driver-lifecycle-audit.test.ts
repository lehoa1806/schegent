import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunDriver } from '../../../src/services/run-driver';
import type { RunDriverDeps } from '../../../src/services/run-driver';
import { WorkspaceStateStore } from '../../../src/state/workspace-state';
import type { Memento } from '../../../src/state/workspace-state';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { PhaseRunOutput } from '../../../src/controller/phase-runner';
import { RequiredEvidenceUnavailableError } from '../../../src/lib/errors';
import { DEFAULT_QUEUE_ID } from '../../../src/queue/queue-registry';

function makeLock(): any {
  return {
    release: vi.fn(async () => {}),
    tryAcquire: vi.fn(),
    heartbeat: vi.fn(),
    isHeld: vi.fn(),
    ownerOfRecord: vi.fn(),
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
  let phaseRunnerMock: {
    run: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    appendCapExhaustedPhaseEnd: ReturnType<typeof vi.fn>;
  };
  let onRunTerminalSpy: ReturnType<typeof vi.fn>;
  let deps: RunDriverDeps;
  let driver: RunDriver;

  beforeEach(async () => {
    store = new WorkspaceStateStore(new FakeMemento());
    await store.initialize();
    
    emitTaskLifecycleAuditSpy = vi.fn().mockResolvedValue(undefined);
    onRunTerminalSpy = vi.fn().mockResolvedValue(undefined);
    phaseRunnerMock = {
      run: vi.fn(),
      abort: vi.fn(),
      appendCapExhaustedPhaseEnd: vi.fn().mockResolvedValue(undefined)
    };
    
    deps = {
      store,
      runner: phaseRunnerMock as any,
      logger: new SanitizedLogger([]),
      options: { iterationCap: 5, cwd: '/test/cwd', cliPath: '/test/bin' } as any,
      monitor: null,
      retryCoordinator: { 
        registerAttempt: vi.fn(), 
        clear: vi.fn(),
        isRetryCapExhaustedOnNextFailure: vi.fn().mockReturnValue(false),
        handleDelayedRetry: vi.fn(),
        maybeEmitRetryRecovered: vi.fn().mockImplementation(async (r) => r) 
      } as any,
      queue: { finish: vi.fn(), pause: vi.fn(), findById: vi.fn(() => null) } as any,
      notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      statusBar: { update: vi.fn(), dispose: vi.fn() } as any,
      historyRecorder: { record: vi.fn() } as any,
      emitRunEndedBreakpointAudit: vi.fn(),
      emitTaskLifecycleAudit: emitTaskLifecycleAuditSpy,
      emitOptionalPhaseFailureContinued: vi.fn(),
      appendPhaseControlAudit: vi.fn(),
      appendRunnerProbeFailedAudit: vi.fn(),
      appendBreakpointAudit: vi.fn(),
      isContinueGate: { consume: vi.fn().mockReturnValue(false) } as any,
      lock: makeLock(),
      persistTransition: async (_oldRun, newRun) => {
        await store.setRun(DEFAULT_QUEUE_ID, newRun);
        return newRun;
      },
      scheduleAutoDrain: vi.fn(),
      onRunTerminal: onRunTerminalSpy
    };
    
    driver = new RunDriver(deps);
  });

  it('emits task-execution-ended on failure (T016)', async () => {
    const runId = 'run-fail-1';
    await store.setRun(DEFAULT_QUEUE_ID, {
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
      resumeTargetPhaseId: null
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

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    await driver.drive(run, 'Test description');
    
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
    expect(onRunTerminalSpy).toHaveBeenCalledOnce();
    expect(onRunTerminalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: runId,
      status: 'failed'
    }));
  });

  it('emits task-execution-ended on completion (T016)', async () => {
    const runId = 'run-complete-1';
    await store.setRun(DEFAULT_QUEUE_ID, {
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
      resumeTargetPhaseId: null
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

    const run = store.getRun(DEFAULT_QUEUE_ID)!;
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
    expect(onRunTerminalSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: runId,
      status: 'completed'
    }));
  });

  // Feature 091 (T004, US1) — recording declared outputs at completion.
  //
  // W7 is the one worth the setup. The `finally` at run-driver.ts:786-798 calls
  // `terminalTransitions?.complete(run, description)`, which re-persists the
  // outer `run`. Anything written *after* `persistTransition` is therefore
  // overwritten by a value captured before it. Folding `runOutputs` into the
  // `completed` literal is what makes it survive, and this test is what stops a
  // later edit from moving the write one line down.
  describe('declared outputs at completion (Feature 091, US1)', () => {
    const DECLARED = [
      { portId: 'report', type: 'markdown' as const, target: 'out/report.md', overwriteConfirmed: false },
      { portId: 'summary', type: 'file' as const, target: 'out/summary.txt', overwriteConfirmed: false }
    ];

    async function seedRunningRun(runId: string, currentPhase = 'plan'): Promise<void> {
      await store.setRun(DEFAULT_QUEUE_ID, {
        id: runId,
        taskId: runId,
        featureId: runId,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        status: 'running',
        currentPhase,
        currentIteration: 0,
        pipeline: { id: 'pipe-1', name: 'Pipe', phases: [{ id: 'plan', title: 'Plan', runner: 'claude', effort: 'normal' }] },
        phasesCompleted: [],
        pendingRetry: false,
        delayedRetryCount: 0,
        manualPauseAt: null,
        manualPauseCause: null,
        phaseBreakpoints: [],
        phaseOverrides: [],
        resumeTargetPhaseId: null
      } as any);
    }

    // FR-R3-001 (T266) — the declaration lives on the Run's frozen envelope, not
    // on the queue row. This used to stub `queue.findById` to hand back a plan;
    // the driver no longer looks there, and it must not, because the row can be
    // edited or removed while the Run it describes is still executing.
    async function declaring(outputs: readonly unknown[]): Promise<void> {
      const seeded = store.getRun(DEFAULT_QUEUE_ID)!;
      await store.setRun(DEFAULT_QUEUE_ID, { ...seeded, envelope: { outputs } } as any);
    }

    function cleanPhase(): void {
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
    }

    function failingPhase(): void {
      phaseRunnerMock.run.mockResolvedValue({
        result: { kind: 'malformed', warnings: [], fatalCause: 'Fatal error occurred', auditEntry: null },
        outcome: 'failed',
        terminationReason: 'error',
        stdoutSummary: '',
        stderrSummary: 'Fatal error occurred',
        exitCode: 1,
        warnings: ['Fatal error occurred'],
        auditEntryId: null
      } as PhaseRunOutput);
    }

    it('records one entry per declared output, in declared order (W1, W2)', async () => {
      await seedRunningRun('run-outputs-1');
      await declaring(DECLARED);
      cleanPhase();

      await driver.drive(store.getRun(DEFAULT_QUEUE_ID)!, 'Test description');

      expect(store.getRun(DEFAULT_QUEUE_ID)?.runOutputs?.map((record) => record.name)).toEqual([
        'report',
        'summary'
      ]);
    });

    it('survives the post-persistTransition finally re-persist (W7)', async () => {
      // The `finally` re-persists the outer `run`. If `runOutputs` were written
      // after `persistTransition` rather than folded into `completed`, the value
      // read back here would be undefined.
      const completeSpy = vi.fn(async () => {});
      deps = { ...deps, terminalTransitions: { complete: completeSpy } as any };
      driver = new RunDriver(deps);

      await seedRunningRun('run-outputs-2');
      await declaring(DECLARED);
      cleanPhase();

      await driver.drive(store.getRun(DEFAULT_QUEUE_ID)!, 'Test description');

      expect(completeSpy).toHaveBeenCalledOnce();
      expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
      expect(store.getRun(DEFAULT_QUEUE_ID)?.runOutputs).toHaveLength(2);
    });

    it('records nothing for a Run that ends failed (FR-008)', async () => {
      await seedRunningRun('run-outputs-3');
      await declaring(DECLARED);
      failingPhase();

      await driver.drive(store.getRun(DEFAULT_QUEUE_ID)!, 'Test description');

      expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('failed');
      expect(store.getRun(DEFAULT_QUEUE_ID)?.runOutputs).toBeUndefined();
    });

    it('records nothing when the plan declared no outputs (FR-008)', async () => {
      await seedRunningRun('run-outputs-4');
      await declaring([]);
      cleanPhase();

      await driver.drive(store.getRun(DEFAULT_QUEUE_ID)!, 'Test description');

      expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
      expect(store.getRun(DEFAULT_QUEUE_ID)?.runOutputs).toBeUndefined();
    });

    it('records nothing when the Run carries no envelope', async () => {
      // Not a failure: a Run started outside the composed path declared no
      // outputs. Under FR-R3-001 that is read off the Run itself, so the seeded
      // Run — which has no envelope — is already the case under test, and the
      // queue is not consulted at all.
      await seedRunningRun('run-outputs-5');
      cleanPhase();

      await driver.drive(store.getRun(DEFAULT_QUEUE_ID)!, 'Test description');

      expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
      expect(store.getRun(DEFAULT_QUEUE_ID)?.runOutputs).toBeUndefined();
    });

    it('adds no audit event type and puts no location in any audit payload (W9)', async () => {
      await seedRunningRun('run-outputs-6');
      await declaring(DECLARED);
      cleanPhase();

      await driver.drive(store.getRun(DEFAULT_QUEUE_ID)!, 'Test description');

      const eventTypes = emitTaskLifecycleAuditSpy.mock.calls.map(([type]) => type);
      expect(eventTypes).toEqual(['task-execution-ended']);

      const serialized = JSON.stringify(emitTaskLifecycleAuditSpy.mock.calls.map(([, , payload]) => payload));
      expect(serialized).not.toContain('out/report.md');
      expect(serialized).not.toContain('runOutputs');
      expect(serialized).not.toContain('reference');
    });

    it('leaves the terminal status unchanged when an output does not resolve (W8)', async () => {
      // Neither declared artifact exists under the test cwd, so both resolve
      // unresolved — and the Run still completes.
      await seedRunningRun('run-outputs-7');
      await declaring(DECLARED);
      cleanPhase();

      await driver.drive(store.getRun(DEFAULT_QUEUE_ID)!, 'Test description');

      expect(store.getRun(DEFAULT_QUEUE_ID)?.status).toBe('completed');
      expect(store.getRun(DEFAULT_QUEUE_ID)?.runOutputs?.every((record) => record.status === 'unresolved')).toBe(
        true
      );
      expect(store.getRun(DEFAULT_QUEUE_ID)?.runOutputs?.some((record) => 'reference' in record)).toBe(false);
    });
  });

  it.each(['failed', 'timeout'] as const)(
    'continues after direct optional %s with terminal evidence and no lastError',
    async (outcome) => {
      const runId = `run-optional-${outcome}`;
      await store.setRun(DEFAULT_QUEUE_ID, {
        id: runId,
        taskId: runId,
        featureId: runId,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        status: 'running',
        currentPhase: 'optional-audit',
        currentIteration: 0,
        pipeline: {
          id: 'pipe-optional',
          name: 'Optional pipeline',
          phases: [{
            id: 'optional-audit',
            name: 'Optional audit',
            instruction: 'Audit',
            runner: 'claude',
            isRequired: false
          }]
        },
        phasesCompleted: [],
        pendingRetryAt: null,
        pendingRetryCause: null,
        delayedRetryCount: 0,
        manualPauseAt: null,
        manualPauseCause: null,
        phaseBreakpoints: [],
        phaseOverrides: [],
        resumeTargetPhaseId: null
      } as any);
      phaseRunnerMock.run.mockResolvedValueOnce({
        result: { kind: 'malformed', warnings: [outcome], auditEntry: null },
        outcome,
        terminationReason: outcome === 'timeout' ? 'timeout' : 'error',
        stdoutSummary: '',
        stderrSummary: 'bounded failure',
        exitCode: outcome === 'timeout' ? null : 1,
        warnings: [outcome],
        auditEntryId: null
      } as PhaseRunOutput);

      await driver.drive(store.getRun(DEFAULT_QUEUE_ID)!, 'optional terminal');

      const finalRun = store.getRun(DEFAULT_QUEUE_ID)!;
      expect(finalRun.status).toBe('completed');
      expect(finalRun.lastError).toBeUndefined();
      expect(finalRun.phasesCompleted).toEqual([
        expect.objectContaining({
          phase: 'optional-audit',
          result: outcome,
          terminationReason: outcome === 'timeout' ? 'timeout' : 'error'
        })
      ]);
      expect(deps.emitOptionalPhaseFailureContinued).toHaveBeenCalledOnce();
      expect(deps.emitOptionalPhaseFailureContinued).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'running', currentPhase: 'done' }),
        {
          runId,
          pipelineId: 'pipe-optional',
          phaseId: 'optional-audit',
          runner: 'claude',
          iteration: 1,
          terminationReason: outcome === 'timeout' ? 'timeout' : 'error'
        }
      );
      expect(deps.queue.pause).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['rate_limited', 'rate_limit'],
    ['transient_error', 'error']
  ] as const)(
    'converts optional %s at retry cap into terminal failed evidence without pausing',
    async (outcome, terminationReason) => {
      const runId = `run-optional-cap-${outcome}`;
      await store.setRun(DEFAULT_QUEUE_ID, {
        id: runId,
        taskId: runId,
        featureId: runId,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        status: 'running',
        currentPhase: 'optional-audit',
        currentIteration: 1,
        pipeline: {
          id: 'pipe-optional',
          name: 'Optional pipeline',
          phases: [{
            id: 'optional-audit',
            name: 'Optional audit',
            instruction: 'Audit',
            runner: 'claude',
            isRequired: false
          }]
        },
        phasesCompleted: [],
        pendingRetryAt: null,
        pendingRetryCause: null,
        delayedRetryCount: 4,
        manualPauseAt: null,
        manualPauseCause: null,
        phaseBreakpoints: [],
        phaseOverrides: [],
        resumeTargetPhaseId: null
      } as any);
      (deps.retryCoordinator.isRetryCapExhaustedOnNextFailure as any)
        .mockReturnValue(true);
      phaseRunnerMock.run.mockResolvedValueOnce({
        result: outcome === 'rate_limited'
          ? { kind: 'rate_limited', cause: 'rate-limit', resetsAtMs: null, auditEntry: null }
          : { kind: 'transient_error', warnings: ['transient'], auditEntry: null },
        outcome,
        terminationReason,
        stdoutSummary: '',
        stderrSummary: 'bounded failure',
        exitCode: 1,
        warnings: [],
        auditEntryId: null
      } as unknown as PhaseRunOutput);

      await driver.drive(store.getRun(DEFAULT_QUEUE_ID)!, 'optional retry cap');

      const finalRun = store.getRun(DEFAULT_QUEUE_ID)!;
      expect(finalRun.status).toBe('completed');
      expect(finalRun.lastError).toBeUndefined();
      expect(finalRun.delayedRetryCount).toBe(0);
      expect(finalRun.phasesCompleted).toEqual([
        expect.objectContaining({
          phase: 'optional-audit',
          result: 'failed',
          terminationReason
        })
      ]);
      expect(deps.retryCoordinator.handleDelayedRetry).not.toHaveBeenCalled();
      expect(phaseRunnerMock.appendCapExhaustedPhaseEnd).toHaveBeenCalledOnce();
      expect(deps.emitOptionalPhaseFailureContinued).toHaveBeenCalledOnce();
      expect(deps.queue.pause).not.toHaveBeenCalled();
    }
  );

  it('does not break drive outcome if audit emission fails (T017)', async () => {
    emitTaskLifecycleAuditSpy.mockRejectedValue(new Error('Audit disk write failed'));
    
    const runId = 'run-complete-2';
    await store.setRun(DEFAULT_QUEUE_ID, {
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
      resumeTargetPhaseId: null
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

    const initialRun = store.getRun(DEFAULT_QUEUE_ID)!;
    await expect(driver.drive(initialRun, 'Test description')).resolves.toBeUndefined();
    
    const run = store.getRun(DEFAULT_QUEUE_ID)!;
    expect(run.status).toBe('completed');
  });

  it('contains terminal retention-hook failure and still schedules queue drain', async () => {
    onRunTerminalSpy.mockRejectedValueOnce(new Error('retention unavailable'));
    await store.setRun(DEFAULT_QUEUE_ID, {
      id: 'run-retention-failure',
      taskId: 'task-retention-failure',
      featureId: 'task-retention-failure',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'canceled',
      currentPhase: 'plan',
      currentIteration: 0,
      pipeline: { id: 'pipe-1', name: 'Pipe', phases: [] },
      phasesCompleted: [],
      pendingRetry: false,
      delayedRetryCount: 0,
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      phaseOverrides: [],
      resumeTargetPhaseId: null
    } as any);

    await expect(driver.drive(store.getRun(DEFAULT_QUEUE_ID)!, 'retention failure')).resolves.toBeUndefined();

    expect(onRunTerminalSpy).toHaveBeenCalledOnce();
    expect(deps.scheduleAutoDrain).toHaveBeenCalledOnce();
  });

  it('fails the active run and suppresses queue drain when required audit evidence is unavailable', async () => {
    await store.setRun(DEFAULT_QUEUE_ID, {
      id: 'run-audit-unavailable',
      taskId: 'task-audit-unavailable',
      featureId: 'task-audit-unavailable',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      status: 'running',
      currentPhase: 'plan',
      currentIteration: 0,
      pipeline: {
        id: 'pipe-1',
        name: 'Pipe',
        phases: [{ id: 'plan', title: 'Plan', runner: 'claude', effort: 'normal' }]
      },
      phasesCompleted: [],
      pendingRetry: false,
      delayedRetryCount: 0,
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      phaseOverrides: [],
      resumeTargetPhaseId: null
    } as any);
    phaseRunnerMock.run.mockRejectedValueOnce(
      new RequiredEvidenceUnavailableError('phase-start')
    );
    deps = {
      ...deps,
      options: {
        ...deps.options,
        isAuditEvidenceAvailable: vi.fn().mockReturnValue(true)
      }
    };

    await expect(
      new RunDriver(deps).drive(store.getRun(DEFAULT_QUEUE_ID)!, 'audit unavailable')
    ).resolves.toBeUndefined();

    expect(store.getRun(DEFAULT_QUEUE_ID)).toMatchObject({
      id: 'run-audit-unavailable',
      status: 'failed',
      lastError: {
        code: 'audit-evidence-unavailable',
        message: 'Required structured audit evidence is unavailable.',
        phase: 'plan',
        iteration: 0
      }
    });
    expect(deps.queue.finish).toHaveBeenCalledWith(
      'task-audit-unavailable',
      'failed',
      expect.objectContaining({ code: 'audit-evidence-unavailable' })
    );
    expect(deps.scheduleAutoDrain).not.toHaveBeenCalled();
    expect(onRunTerminalSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' })
    );
  });
});
