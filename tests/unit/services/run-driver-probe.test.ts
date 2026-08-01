import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunDriver } from '../../../src/services/run-driver';
import type { WorkflowRun } from '../../../src/state/workflow-run';
import { execFile } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((file, _args, optionsOrCallback, maybeCallback) => {
    const cb = typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : maybeCallback;
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
        errorMessage: 'Runner probe failed for codex: CLI executable is unavailable or invalid.'
      })
    );
    expect(deps.appendRunnerProbeFailedAudit.mock.calls[0][1].errorMessage).not.toContain('ENOENT');
    expect(deps.persistTransition).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running' }),
      expect.objectContaining({ status: 'failed' })
    );
    expect(deps.statusBar.update).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'failed' })
    );
    expect(deps.notifier.warn).toHaveBeenCalled();
    expect(deps.queue.finish).toHaveBeenCalledWith(
      'task-1',
      'failed',
      expect.objectContaining({ code: 'runner-probe-failed' })
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

  it('uses the snapshotted effective backend for probing and invocation paths', async () => {
    const pathResolver = vi.fn((runner: string) => `${runner}-bin`);
    deps.options = {
      ...deps.options,
      defaultRunnerKind: 'codex',
      cliPathResolver: pathResolver
    };
    const run = {
      id: 'run-global-agy',
      featureId: 'task-global-agy',
      startedAt: Date.now(),
      status: 'running',
      currentPhase: 'plan',
      currentIteration: 0,
      pipeline: {
        id: 'pipe-global-agy',
        name: 'Global Agy',
        phases: [{ id: 'plan', name: 'Plan', instruction: 'do something', runner: 'agy' }]
      },
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

    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'agy-bin',
      ['--help'],
      expect.objectContaining({ cwd: '/tmp' }),
      expect.any(Function)
    );
    expect(deps.runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ cliPath: 'agy-bin' })
    );
    expect(pathResolver).toHaveBeenCalledWith('agy');
  });

  it('probes with the same cwd and restricted environment policy as invocation', async () => {
    deps.options = {
      ...deps.options,
      cwd: '/workspace/project',
      inheritProcessEnv: false,
      defaultRunnerKind: 'agy',
      cliPathResolver: () => './tools/agy'
    };
    const run = {
      id: 'run-context',
      featureId: 'task-context',
      startedAt: Date.now(),
      status: 'running',
      currentPhase: 'plan',
      currentIteration: 0,
      pipeline: {
        id: 'pipe-context',
        name: 'Context',
        phases: [{ id: 'plan', name: 'Plan', instruction: 'work', runner: 'agy' }]
      },
      phasesCompleted: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      phaseOverrides: [],
      resumeTargetPhaseId: null
    };
    deps.store.getRun.mockReturnValue(run);
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await new RunDriver(deps).drive(run as unknown as WorkflowRun, 'desc');
    } finally {
      process.env.NODE_ENV = originalEnv;
    }

    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      './tools/agy',
      ['--help'],
      {
        cwd: '/workspace/project',
        env: {
          SCHEGENT_PHASE: 'runner-probe',
          SCHEGENT_ITERATION: '0'
        }
      },
      expect.any(Function)
    );
  });

  it('uses the same names-only allowlist for probing and phase invocation', async () => {
    const originalAllowed = process.env.SCHEGENT_ENV_ALLOWED_TEST;
    const originalBlocked = process.env.SCHEGENT_ENV_BLOCKED_TEST;
    process.env.SCHEGENT_ENV_ALLOWED_TEST = 'approved';
    process.env.SCHEGENT_ENV_BLOCKED_TEST = 'secret';
    deps.options = {
      ...deps.options,
      inheritProcessEnv: false,
      processEnvAllowlist: ['SCHEGENT_ENV_ALLOWED_TEST'],
      defaultRunnerKind: 'claude'
    };
    const run = {
      id: 'run-allowlist',
      featureId: 'task-allowlist',
      startedAt: Date.now(),
      status: 'running',
      currentPhase: 'plan',
      currentIteration: 0,
      pipeline: {
        id: 'pipe-allowlist',
        name: 'Allowlist',
        phases: [{ id: 'plan', name: 'Plan', instruction: 'work', runner: 'claude' }]
      },
      phasesCompleted: [],
      manualPauseAt: null,
      manualPauseCause: null,
      phaseBreakpoints: [],
      phaseOverrides: [],
      resumeTargetPhaseId: null
    };
    deps.store.getRun.mockReturnValue(run);
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      await new RunDriver(deps).drive(run as unknown as WorkflowRun, 'desc');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalAllowed === undefined) delete process.env.SCHEGENT_ENV_ALLOWED_TEST;
      else process.env.SCHEGENT_ENV_ALLOWED_TEST = originalAllowed;
      if (originalBlocked === undefined) delete process.env.SCHEGENT_ENV_BLOCKED_TEST;
      else process.env.SCHEGENT_ENV_BLOCKED_TEST = originalBlocked;
    }

    const probeOptions = vi.mocked(execFile).mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv };
    expect(probeOptions.env?.SCHEGENT_ENV_ALLOWED_TEST).toBe('approved');
    expect(probeOptions.env?.SCHEGENT_ENV_BLOCKED_TEST).toBeUndefined();
    expect(deps.runner.run).toHaveBeenCalledWith(expect.objectContaining({
      inheritProcessEnv: false,
      processEnvAllowlist: ['SCHEGENT_ENV_ALLOWED_TEST']
    }));
  });
});
