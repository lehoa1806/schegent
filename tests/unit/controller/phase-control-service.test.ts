// Feature 098 (T022, US3, FR-028, SC-010) — phase membership is answered from
// the Run's own snapshot, never from a code-resident catalog.
//
// `phaseExists` read `run.pipeline?.phases ?? BUILT_IN_PHASES`. A Run with no
// pipeline snapshot therefore had its membership questions answered by the
// seventeen built-in Phase ids, so an operator could set a breakpoint on — or
// remove — a Phase that Run was never going to execute. Once the built-in layer
// is empty the fallback answers `false` for everything, which is the correct
// answer arrived at for the wrong reason; the fallback goes, and the correct
// answer comes from the absent snapshot instead.
//
// This file exists because `PhaseControlService` had no unit suite of its own:
// the fallback was reachable only through the controller facade, and no test
// covered a snapshot-less Run.

import { describe, expect, it, vi } from 'vitest';
import { unfencedCommit } from '../../../src/state/ownership-claim';
import { PhaseControlService } from '../../../src/controller/phase-control-service';
import type { WorkflowRun } from '../../../src/state/workflow-run';

const QUEUE_ID = 'queue-1';

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'task-1',
    featureDir: '',
    startedAt: 1,
    lastTransitionAt: 1,
    status: 'running',
    currentPhase: 'alpha',
    currentIteration: 0,
    phasesCompleted: [],
    lastError: null,
    delayedRetryCount: 0,
    pendingRetryAt: null,
    pendingRetryCause: null,
    manualPauseAt: null,
    manualPauseCause: null,
    phaseBreakpoints: [],
    phaseOverrides: [],
    resumeTargetPhaseId: null,
    ...overrides
  } as unknown as WorkflowRun;
}

function makeService(run: WorkflowRun) {
  const setRun = vi.fn(async () => {});
  const appendBreakpoint = vi.fn(async () => {});
  const service = new PhaseControlService({
    store: {
      getRun: vi.fn(() => run),
      setRun,
      getQueue: vi.fn(() => null),
      setWatchdog: vi.fn(async () => {}),
      runCommitClaim: vi.fn(() => unfencedCommit('test-fixture'))
    },
    queue: {
      cascadedPause: vi.fn(async () => {}),
      cascadedResume: vi.fn(async () => {}),
      setQueuePausedState: vi.fn(async () => {})
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    retryCoordinator: { cancelPendingTimer: vi.fn() },
    isDriving: vi.fn(() => false),
    noteActivePhaseOverrideAbort: vi.fn(),
    armIsContinue: vi.fn(),
    cancelActive: vi.fn(),
    resumeExisting: vi.fn(async () => true),
    auditor: {
      appendPhaseControl: vi.fn(async () => {}),
      emitTaskPaused: vi.fn(async () => {}),
      emitPhaseJumped: vi.fn(async () => {}),
      appendBreakpoint
    }
  } as unknown as ConstructorParameters<typeof PhaseControlService>[0]);
  return { service, setRun, appendBreakpoint };
}

describe('phase membership without a pipeline snapshot (T022)', () => {
  it('refuses a breakpoint on a built-in Phase id when the Run carries no snapshot', async () => {
    // `speckit-specify` is the first of the seventeen ids the built-in layer used
    // to claim, so it is the id that demonstrates the substitution rather than
    // merely a miss: pre-feature this resolved through `BUILT_IN_PHASES` and the
    // breakpoint was accepted onto a Run whose Pipeline never named it.
    const { service, setRun, appendBreakpoint } = makeService(makeRun({ pipeline: undefined }));

    const result = await service.setPhaseBreakpoint(QUEUE_ID, 'run-1', 'speckit-specify');

    expect(result).toEqual({ ok: false, reason: 'phase-unknown' });
    expect(setRun).not.toHaveBeenCalled();
    expect(appendBreakpoint).not.toHaveBeenCalled();
  });

  it('refuses an arbitrary Phase id on a snapshot-less Run for the same reason', async () => {
    const { service } = makeService(makeRun({ pipeline: undefined }));

    expect(await service.setPhaseBreakpoint(QUEUE_ID, 'run-1', 'not-a-phase')).toEqual({
      ok: false,
      reason: 'phase-unknown'
    });
  });

  it('still answers from the snapshot when the Run has one', async () => {
    // The other half of FR-028: removing the fallback must not narrow the answer
    // for a Run that does carry its Pipeline. `beta` is in the snapshot and is
    // neither in flight nor completed, so the breakpoint lands.
    const run = makeRun({
      pipeline: {
        id: 'ab-flow',
        name: 'A then B',
        phases: [
          { id: 'alpha', name: 'Alpha', instruction: 'a' },
          { id: 'beta', name: 'Beta', instruction: 'b' }
        ]
      } as unknown as WorkflowRun['pipeline']
    });
    const { service, setRun } = makeService(run);

    expect(await service.setPhaseBreakpoint(QUEUE_ID, 'run-1', 'beta')).toEqual({ ok: true });
    expect(setRun).toHaveBeenCalledTimes(1);
  });

  it('refuses a built-in Phase id against a snapshot that does not name it', async () => {
    const run = makeRun({
      pipeline: {
        id: 'ab-flow',
        name: 'A then B',
        phases: [{ id: 'alpha', name: 'Alpha', instruction: 'a' }]
      } as unknown as WorkflowRun['pipeline']
    });
    const { service } = makeService(run);

    expect(await service.setPhaseBreakpoint(QUEUE_ID, 'run-1', 'speckit-plan')).toEqual({
      ok: false,
      reason: 'phase-unknown'
    });
  });
});
