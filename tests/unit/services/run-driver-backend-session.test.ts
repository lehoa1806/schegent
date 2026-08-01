import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunDriver } from '../../../src/services/run-driver';
import type { WorkflowRun } from '../../../src/state/workflow-run';

function cleanOutput(cliSessionId?: string) {
  return {
    result: { kind: 'clean' as const, auditEntry: null },
    outcome: 'clean' as const,
    terminationReason: 'token' as const,
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    warnings: [],
    auditEntryId: null,
    ...(cliSessionId ? { cliSessionId } : {})
  };
}

function makeRun(secondRunner?: 'claude' | 'codex' | 'agy'): WorkflowRun {
  return {
    id: 'run-session',
    featureId: 'task-session',
    featureDir: '',
    startedAt: Date.now(),
    lastTransitionAt: Date.now(),
    status: 'running',
    currentPhase: 'phase-one',
    currentIteration: 0,
    pipeline: {
      id: 'mixed',
      name: 'Mixed',
      phases: [
        { id: 'phase-one', name: 'One', instruction: 'one', runner: 'agy' },
        {
          id: 'phase-two',
          name: 'Two',
          instruction: 'two',
          ...(secondRunner ? { runner: secondRunner } : {})
        }
      ]
    },
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    phaseOverrides: [],
    resumeTargetPhaseId: null
  } as unknown as WorkflowRun;
}

describe('RunDriver backend-scoped sessions', () => {
  let deps: any;

  beforeEach(() => {
    deps = {
      runner: {
        run: vi.fn()
          .mockResolvedValueOnce(cleanOutput('session-from-first'))
          .mockResolvedValueOnce(cleanOutput('session-from-second'))
      },
      store: { getRun: vi.fn().mockReturnValue(null) },
      queue: { finish: vi.fn() },
      statusBar: { update: vi.fn() },
      notifier: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
      lock: {
        withLock: vi.fn(async (_scope: string, fn: any) => fn({ retain: vi.fn() }))
      },
      options: {
        cliPath: 'claude-bin',
        cwd: '/tmp',
        iterationCap: 5,
        timeoutMs: 5_000,
        defaultRunnerKind: 'agy',
        cliPathResolver: (runner: string) => `${runner}-bin`,
        skipProbing: true
      },
      monitor: null,
      historyRecorder: { record: vi.fn() },
      retryCoordinator: {
        maybeEmitRetryRecovered: vi.fn(async (run) => run)
      },
      isContinueGate: { consume: vi.fn().mockReturnValue(false) },
      persistTransition: vi.fn(async (_previous, next) => next),
      appendPhaseControlAudit: vi.fn(),
      appendRunnerProbeFailedAudit: vi.fn(),
      appendBreakpointAudit: vi.fn(),
      emitRunEndedBreakpointAudit: vi.fn(),
      emitTaskLifecycleAudit: vi.fn(),
      scheduleAutoDrain: vi.fn()
    };
  });

  it('reuses a session when explicit and global selections resolve to the same backend', async () => {
    const run = makeRun('agy');
    await new RunDriver(deps).drive(run, 'same backend');

    expect(deps.runner.run).toHaveBeenCalledTimes(2);
    expect(deps.runner.run.mock.calls[0][0].cliPath).toBe('agy-bin');
    expect(deps.runner.run.mock.calls[1][0]).toMatchObject({
      cliPath: 'agy-bin',
      sessionReuse: true,
      resumeSessionId: 'session-from-first'
    });
  });

  it('clears session identity atomically when the effective backend changes', async () => {
    const run = makeRun('claude');
    await new RunDriver(deps).drive(run, 'different backend');

    expect(deps.runner.run).toHaveBeenCalledTimes(2);
    expect(deps.runner.run.mock.calls[1][0]).toMatchObject({
      cliPath: 'claude-bin',
      sessionReuse: false
    });
    expect(deps.runner.run.mock.calls[1][0].resumeSessionId).toBeUndefined();

    const transitionToSecond = deps.persistTransition.mock.calls
      .map((call: unknown[]) => call[1] as WorkflowRun)
      .find((next: WorkflowRun) => next.currentPhase === 'phase-two');
    expect(transitionToSecond?.lastCliSessionId).toBeUndefined();
    expect(transitionToSecond?.lastCliSessionRunnerKind).toBeUndefined();
  });

  it('does not reuse a legacy unowned session ID', async () => {
    const run = {
      ...makeRun('agy'),
      lastCliSessionId: 'legacy-session-without-owner'
    };
    deps.isContinueGate.consume.mockReturnValue(true);

    await new RunDriver(deps).drive(run, 'legacy session');

    expect(deps.runner.run.mock.calls[0][0]).toMatchObject({
      isContinue: false,
      sessionReuse: false
    });
    expect(deps.runner.run.mock.calls[0][0].resumeSessionId).toBeUndefined();
  });

  it('does not continue through the backend latest-session fallback after an owner change', async () => {
    const run = {
      ...makeRun('claude'),
      lastCliSessionId: 'agy-owned-session',
      lastCliSessionRunnerKind: 'agy' as const,
      resumePrompt: 'Resume safely from persisted state.'
    };
    run.currentPhase = 'phase-two';
    deps.options.defaultRunnerKind = 'claude';
    deps.isContinueGate.consume.mockReturnValue(true);

    await new RunDriver(deps).drive(run, 'backend changed');

    expect(deps.runner.run.mock.calls[0][0]).toMatchObject({
      cliPath: 'claude-bin',
      isContinue: false,
      sessionReuse: false,
      resumePrompt: 'Resume safely from persisted state.'
    });
    expect(deps.runner.run.mock.calls[0][0].resumeSessionId).toBeUndefined();
  });

  it('uses the persisted run default for a phase without a snapshotted runner', async () => {
    const run = { ...makeRun('agy'), defaultRunnerKind: 'agy' as const };
    delete (run.pipeline!.phases[0] as { runner?: string }).runner;
    deps.options.defaultRunnerKind = 'codex';

    await new RunDriver(deps).drive(run, 'partially migrated snapshot');

    expect(deps.runner.run.mock.calls[0][0]).toMatchObject({
      cliPath: 'agy-bin',
      phaseDef: expect.objectContaining({ runner: 'agy' })
    });
    expect(run.pipeline!.phases[0].runner).toBeUndefined();
  });

  it('uses a controller-pinned historical default when legacy phase metadata is absent', async () => {
    const run = makeRun('agy');
    delete (run.pipeline!.phases[0] as { runner?: string }).runner;
    run.defaultRunnerKind = 'claude';
    deps.options.defaultRunnerKind = 'codex';

    await new RunDriver(deps).drive(run, 'fully legacy snapshot');

    expect(deps.runner.run.mock.calls[0][0]).toMatchObject({
      cliPath: 'claude-bin',
      phaseDef: expect.objectContaining({ runner: 'claude' })
    });
  });

  it('retains the Claude Git-capability pin for a protected legacy phase', async () => {
    const run = makeRun('codex');
    run.pipeline = {
      ...run.pipeline!,
      phases: [
        {
          id: 'speckit-specify',
          name: 'Specify',
          instruction: 'Create the feature branch.'
        },
        run.pipeline!.phases[1]
      ]
    };
    run.currentPhase = 'speckit-specify';
    run.defaultRunnerKind = 'codex';
    deps.options.defaultRunnerKind = 'codex';

    await new RunDriver(deps).drive(run, 'legacy protected phase');

    expect(deps.runner.run.mock.calls[0][0]).toMatchObject({
      cliPath: 'claude-bin',
      phaseDef: expect.objectContaining({
        id: 'speckit-specify',
        runner: 'claude'
      })
    });
  });
});
