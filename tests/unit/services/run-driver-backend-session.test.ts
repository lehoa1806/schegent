import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunDriver } from '../../../src/services/run-driver';
import { buildMutationPlan } from '../../../src/services/mutation-plan';
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
      // Feature 093 (T039/T040) — the driver resolves the persisted snapshot by
      // the Run's own Task instead of reading the one ambient slot. This
      // harness's `getRun` answered `null`, so its replacement answers `null`
      // too: no persisted snapshot, which is all these session tests need.
      store: { findRunByTask: vi.fn(() => null) },
      // `findById` is asked for the frozen plan's declared outputs at completion
      // (Feature 091, T011). No plan here means nothing is recorded.
      queue: { finish: vi.fn(), findById: vi.fn(() => null) },
      statusBar: { update: vi.fn() },
      notifier: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
      lock: {},
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
          // Feature 098 T018 — the pin follows the declared class rather than the
          // id, so the snapshot phase declares it. `effectiveRunnerKindForPhase`
          // reads `sideEffects` and returns `claude` for a `git` Phase that names
          // no runner, which is what the assertion below still checks.
          sideEffects: 'git',
          instruction: 'Create the feature branch.'
        },
        run.pipeline!.phases[1]
      ]
    };
    run.currentPhase = 'speckit-specify';
    run.defaultRunnerKind = 'codex';
    deps.options.defaultRunnerKind = 'codex';
    // Feature 098 T018 — a consequence of the re-keying, and the reason it is
    // spelled out rather than stubbed. The runner pin and the mutation-plan
    // approval gate at `run-driver.ts:470` used to read different inputs: the pin
    // came off the five-id list while `sideEffects` stayed undefined, so a
    // "protected" phase got a pinned runner *without* being Git-class to the
    // gate. Both now read the one declaration, so a phase that earns the pin also
    // needs an approved plan — and this fixture has to supply one or the dispatch
    // it is asserting about never happens.
    const plan = buildMutationPlan(run.pipeline!);
    run.mutationPlan = plan;
    run.gitApprovalReceipt = {
      approvedAt: plan.capturedAt,
      planFingerprint: plan.fingerprint,
      approvedPhaseIds: plan.gitCapablePhaseIds
    };

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
