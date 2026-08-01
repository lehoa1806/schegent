import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunDriver } from '../../../src/services/run-driver';
import type { WorkflowRun } from '../../../src/state/workflow-run';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((file, _args, cb) => {
    if (file === 'bad-bin') {
      cb(new Error('ENOENT: no such file or directory'), '', '');
    } else {
      cb(null, 'help text', '');
    }
  })
}));

describe('RunDriver Probing (Feature 074)', () => {
  let deps: any;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      runner: { run: vi.fn().mockResolvedValue({
        result: { kind: 'clean', auditEntry: null },
        outcome: 'clean',
        terminationReason: 'token',
        stdoutSummary: '',
        stderrSummary: '',
        exitCode: 0,
        warnings: [],
        auditEntryId: null
      }) },
      store: { setRun: vi.fn(), getRun: vi.fn() },
      queue: { notifyStatusChange: vi.fn(), finish: vi.fn() },
      statusBar: { update: vi.fn() },
      notifier: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
      lock: { withLock: vi.fn(async (_scope: string, fn: any) => fn({ retain: vi.fn() })) },
      options: { cliPath: 'good-bin', cwd: '/tmp', iterationCap: 5, cliPathResolver: (r: string) => r === 'claude' ? 'good-bin' : 'bad-bin' },
      monitor: { emit: vi.fn() },
      historyRecorder: { recordPhaseOutput: vi.fn(), record: vi.fn() },
      retryCoordinator: { registerAttempt: vi.fn(), resetPhase: vi.fn(), maybeEmitRetryRecovered: vi.fn(async (run) => run) },
      isContinueGate: { consume: vi.fn().mockReturnValue(false) },
      persistTransition: vi.fn(async (_prev, next) => next),
      appendPhaseControlAudit: vi.fn(),
      appendRunnerProbeFailedAudit: vi.fn(),
      appendBreakpointAudit: vi.fn(),
      emitRunEndedBreakpointAudit: vi.fn(),
      emitTaskLifecycleAudit: vi.fn(),
      scheduleAutoDrain: vi.fn()
    };
  });

  it('probes binaries at start and fails run if probe fails', async () => {
    const run = {
      id: 'run-1',
      featureId: 'task-1',
      startedAt: Date.now(),
      status: 'running',
      currentPhase: 'plan',
      currentIteration: 0,
      pipeline: { id: 'pipe-1', name: 'Pipe', phases: [{ id: 'phase1', name: 'Phase 1', instruction: 'do something', runner: 'codex', effort: 'low', model: 'claude-3-haiku-20240307' }] },
      phasesCompleted: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      phaseOverrides: [],
      resumeTargetPhaseId: null
    };

    deps.store.getRun.mockReturnValue(run);

    const driver = new RunDriver(deps);
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await driver.drive(run as unknown as WorkflowRun, 'desc');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }

    expect(deps.appendRunnerProbeFailedAudit).toHaveBeenCalledTimes(1);
    expect(deps.appendRunnerProbeFailedAudit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'run-1' }),
      expect.objectContaining({
        runnerKind: 'codex',
        cliPath: 'bad-bin'
      })
    );
    expect(deps.persistTransition).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running' }),
      expect.objectContaining({ status: 'failed' })
    );
  });

  it('succeeds probe and continues to run phase', async () => {
    const run = {
      id: 'run-1',
      featureId: 'task-1',
      startedAt: Date.now(),
      status: 'running',
      currentPhase: 'plan',
      currentIteration: 0,
      pipeline: { id: 'pipe-1', name: 'Pipe', phases: [{ id: 'phase1', name: 'Phase 1', instruction: 'do something', runner: 'claude', effort: 'low', model: 'claude-3-haiku-20240307' }] },
      phasesCompleted: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      phaseOverrides: [],
      resumeTargetPhaseId: null
    };

    deps.store.getRun.mockReturnValue(run);

    const driver = new RunDriver(deps);
    await driver.drive(run as unknown as WorkflowRun, 'desc');

    expect(deps.appendRunnerProbeFailedAudit).not.toHaveBeenCalled();
    expect(deps.runner.run).toHaveBeenCalled();
  });
});
