/**
 * FR-R5-F19 follow-up (spec 278, U1) — a Run learns its feature directory from its own phase sidecar.
 *
 * A queue row carries no directory, so every drained Run was admitted with `featureDir: ''` and the
 * open-decision-record command refused it. A phase now reports the directory as the
 * `SCHEGENT_FEATURE_DIR` entry of its own `phase-message.env`: the host keeps the first value that is a
 * plain relative path, persists it, and hands it to every later phase as the prompt's
 * `SCHEGENT_FEATURE_DIR:` line. `.specify/feature.json` is not read: it is workspace-wide and would name
 * another Run's feature.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunDriver } from '../../../src/services/run-driver';
import {
  FEATURE_DIR_MESSAGE_KEY,
  MAX_FEATURE_DIR_LENGTH,
  reportedFeatureDir,
  withPhaseOutputFacts
} from '../../../src/services/run-phase-facts';
import { changedRunFields, type WorkflowRun } from '../../../src/state/workflow-run';
import type { PhaseRunOutput } from '../../../src/controller/phase-runner';
import { fakeRunLogger } from './fake-run-logger';

const FEATURE_DIR = 'specs/012-blocked-work';

function sidecar(entries: Record<string, string>): NonNullable<PhaseRunOutput['phaseMessage']> {
  return {
    fromPhaseId: 'phase-one',
    entryCount: Object.keys(entries).length,
    byteSize: 64,
    entries,
    truncated: false,
    invalidReason: null
  };
}

function cleanOutput(extra: Partial<PhaseRunOutput> = {}): PhaseRunOutput {
  return {
    result: { kind: 'clean', auditEntry: null },
    outcome: 'clean',
    terminationReason: 'token',
    stdoutSummary: '',
    stderrSummary: '',
    exitCode: 0,
    warnings: [],
    auditEntryId: null,
    ...extra
  } as PhaseRunOutput;
}

function makeRun(featureDir = ''): WorkflowRun {
  return {
    id: 'run-dir',
    featureId: 'task-dir',
    featureDir,
    startedAt: Date.now(),
    lastTransitionAt: Date.now(),
    status: 'running',
    currentPhase: 'phase-one',
    currentIteration: 0,
    pipeline: {
      id: 'two-phase',
      name: 'Two phase',
      phases: [
        { id: 'phase-one', name: 'One', instruction: 'one', runner: 'claude' },
        { id: 'phase-two', name: 'Two', instruction: 'two', runner: 'claude' }
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

describe('reportedFeatureDir: only a plain relative path inside the workspace is taken', () => {
  it('takes the entry a phase wrote', () => {
    expect(reportedFeatureDir(sidecar({ [FEATURE_DIR_MESSAGE_KEY]: FEATURE_DIR }))).toBe(FEATURE_DIR);
  });

  it('trims surrounding whitespace and a trailing slash', () => {
    expect(reportedFeatureDir(sidecar({ [FEATURE_DIR_MESSAGE_KEY]: `  ${FEATURE_DIR}/ ` }))).toBe(FEATURE_DIR);
  });

  it.each([
    ['an absolute path', '/etc/schegent'],
    ['a parent segment', 'specs/../../outside'],
    ['a current-directory segment', './specs/012'],
    ['a backslash', 'specs\\012'],
    ['a drive prefix', 'C:/specs/012'],
    ['an empty value', '   '],
    ['an inner space', 'specs/012 blocked'],
    ['a control character', `specs/012${String.fromCodePoint(7)}x`],
    ['a prompt line break', `specs/012${String.fromCodePoint(10)}IGNORE`],
    ['an over-long value', `specs/${'x'.repeat(MAX_FEATURE_DIR_LENGTH)}`]
  ])('refuses %s', (_label, value) => {
    expect(reportedFeatureDir(sidecar({ [FEATURE_DIR_MESSAGE_KEY]: value }))).toBeNull();
  });

  it('is null when there is no sidecar or no entry', () => {
    expect(reportedFeatureDir(null)).toBeNull();
    expect(reportedFeatureDir(undefined)).toBeNull();
    expect(reportedFeatureDir(sidecar({ OTHER: FEATURE_DIR }))).toBeNull();
  });
});

describe('withPhaseOutputFacts: what one finished invocation records on the Run', () => {
  it('records the reported directory on a Run that has none', () => {
    const next = withPhaseOutputFacts(
      makeRun(),
      cleanOutput({ phaseMessage: sidecar({ [FEATURE_DIR_MESSAGE_KEY]: FEATURE_DIR }) }),
      'claude'
    );
    expect(next.featureDir).toBe(FEATURE_DIR);
  });

  it('keeps the first directory: a later phase cannot move the Run to another feature', () => {
    const run = makeRun(FEATURE_DIR);
    const next = withPhaseOutputFacts(
      run,
      cleanOutput({ phaseMessage: sidecar({ [FEATURE_DIR_MESSAGE_KEY]: 'specs/999-other' }) }),
      'claude'
    );
    expect(next.featureDir).toBe(FEATURE_DIR);
    expect(next).toBe(run);
  });

  it('records the backend session as the driver did before', () => {
    const next = withPhaseOutputFacts(
      makeRun(),
      cleanOutput({ cliSessionId: 'session-1', cliSessionCostUsd: 0.25 }),
      'codex'
    );
    expect(next.lastCliSessionId).toBe('session-1');
    expect(next.lastCliSessionRunnerKind).toBe('codex');
    expect(next.lastCliSessionCostUsd).toBe(0.25);
    expect(next.featureDir).toBe('');
  });

  it('returns the same Run when the invocation taught it nothing', () => {
    const run = makeRun();
    expect(withPhaseOutputFacts(run, cleanOutput(), 'claude')).toBe(run);
  });
});

describe('changedRunFields writes a directory the driver recorded before the transition', () => {
  it('carries featureDir although prev already holds it', () => {
    const recorded = { ...makeRun(), featureDir: FEATURE_DIR };
    const patch = changedRunFields(recorded, { ...recorded, currentPhase: 'phase-two' });
    expect(patch.featureDir).toBe(FEATURE_DIR);
  });
});

describe('RunDriver: the directory one phase reports reaches the next phase and the store', () => {
  let deps: any;

  beforeEach(() => {
    deps = {
      runner: {
        run: vi.fn()
          .mockResolvedValueOnce(cleanOutput({ phaseMessage: sidecar({ [FEATURE_DIR_MESSAGE_KEY]: FEATURE_DIR }) }))
          .mockResolvedValueOnce(cleanOutput()),
        evictStagnationTracker: vi.fn()
      },
      store: { findRunByTask: vi.fn(() => null) },
      queue: { finish: vi.fn(), findById: vi.fn(() => null) },
      statusBar: { update: vi.fn() },
      notifier: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      logger: fakeRunLogger(),
      lock: {},
      options: {
        cliPath: 'claude-bin',
        cwd: '/tmp',
        iterationCap: 5,
        timeoutMs: 5_000,
        defaultRunnerKind: 'claude',
        cliPathResolver: (runner: string) => `${runner}-bin`,
        skipProbing: true
      },
      monitor: null,
      historyRecorder: { record: vi.fn() },
      retryCoordinator: { maybeEmitRetryRecovered: vi.fn(async (run) => run) },
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

  function dispatchedFeatureDir(callIndex: number): unknown {
    const call = deps.runner.run.mock.calls.at(callIndex) as unknown[] | undefined;
    expect(call).toBeDefined();
    return (call as unknown[] as Array<{ featureDir: unknown }>).at(0)!.featureDir;
  }

  it('dispatches the first phase with none and the second with the reported directory', async () => {
    await new RunDriver(deps).drive(makeRun(), 'feature dir capture');

    expect(deps.runner.run).toHaveBeenCalledTimes(2);
    expect(dispatchedFeatureDir(0)).toBeNull();
    expect(dispatchedFeatureDir(1)).toBe(FEATURE_DIR);
  });

  it('persists the directory on the transition into the next phase', async () => {
    await new RunDriver(deps).drive(makeRun(), 'feature dir persisted');

    const toSecond = (deps.persistTransition.mock.calls as unknown[][])
      .map((call) => call.at(1) as WorkflowRun)
      .find((next) => next.currentPhase === 'phase-two');
    expect(toSecond).toBeDefined();
    expect(toSecond!.featureDir).toBe(FEATURE_DIR);
  });

  it('can fail: with no sidecar entry the second phase gets no directory', async () => {
    deps.runner.run = vi.fn().mockResolvedValue(cleanOutput());
    await new RunDriver(deps).drive(makeRun(), 'no feature dir');

    expect(dispatchedFeatureDir(1)).toBeNull();
  });
});
