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
  const appendPhaseControl = vi.fn(async () => {});
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
      appendPhaseControl,
      emitTaskPaused: vi.fn(async () => {}),
      emitPhaseJumped: vi.fn(async () => {}),
      appendBreakpoint
    }
  } as unknown as ConstructorParameters<typeof PhaseControlService>[0]);
  return { service, setRun, appendBreakpoint, appendPhaseControl };
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

// FR-R3-151 — table-driven eligibility matrix over the operation/source-state
// space in spec.md §User Story 1 (T1624). Every row asserts both the
// accept/refuse outcome and, for refused rows, that nothing was written:
// `store.setRun`, `appendPhaseControl`, and `appendBreakpoint` are all
// asserted un-called. This is deliberately over `PhaseControlService`'s own
// public methods, not `decidePhaseControl` directly (see
// phase-control-decision.test.ts for the classifier's own unit tests) — the
// point of this suite is to prove every method actually consults the
// classifier before writing, not merely that the classifier itself is
// correct.
const PIPELINE = {
  id: 'abc-flow',
  name: 'Alpha Beta Gamma',
  phases: [
    { id: 'alpha', name: 'Alpha', instruction: 'a' },
    { id: 'beta', name: 'Beta', instruction: 'b' },
    { id: 'gamma', name: 'Gamma', instruction: 'g' }
  ]
} as unknown as WorkflowRun['pipeline'];

// alpha: completed; beta: active (currentPhase); gamma: future, no override.
function makeThreePhaseRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return makeRun({
    pipeline: PIPELINE,
    currentPhase: 'beta',
    phasesCompleted: [
      {
        phase: 'alpha',
        iteration: 1,
        startedAt: 0,
        endedAt: 1,
        result: 'clean',
        terminationReason: 'error',
        exitCode: 0,
        stdoutSummary: '',
        stderrSummary: '',
        auditEntryId: null
      }
    ] as unknown as WorkflowRun['phasesCompleted'],
    ...overrides
  } as Partial<WorkflowRun>);
}

async function expectZeroWrites(
  mocks: ReturnType<typeof makeService>,
  act: () => Promise<unknown>
): Promise<void> {
  await act();
  expect(mocks.setRun).not.toHaveBeenCalled();
  expect(mocks.appendPhaseControl).not.toHaveBeenCalled();
  expect(mocks.appendBreakpoint).not.toHaveBeenCalled();
}

describe('Phase control eligibility matrix (FR-R3-151, T1624)', () => {
  describe('Restart Phase', () => {
    it('refuses a terminal Run (completed) even though a Run record exists (FR-002, SC-002)', async () => {
      const run = makeThreePhaseRun({ status: 'completed' });
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.restartActivePhase(QUEUE_ID)).toEqual({
          ok: false,
          reason: 'run-terminal'
        });
      });
    });

    it('refuses a terminal Run (canceled) — closes the confirmed defect (spec §1, US1 Scenario 1)', async () => {
      const run = makeThreePhaseRun({ status: 'canceled' });
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.restartActivePhase(QUEUE_ID)).toEqual({
          ok: false,
          reason: 'run-terminal'
        });
      });
      // FR-009 regression guard: this refusal is driven solely by run.status
      // via the shared classifier — there is no separate "just came from a
      // canceled-task fresh-Run restart" bypass anywhere in this path, so
      // completing that distinct Feature 017 operation cannot grant
      // permission to restart a Phase inside a Run this terminal.
    });

    it('allows Restart on an operable Run (failed, no pending retry) — failed is not terminal (workflow-run.ts isOperableRunStatus)', async () => {
      const run = makeThreePhaseRun({ status: 'failed', pendingRetryAt: null });
      const { service, setRun } = makeService(run);
      expect(await service.restartActivePhase(QUEUE_ID)).toEqual({ ok: true });
      expect(setRun).toHaveBeenCalledTimes(1);
    });

    it('allows Restart on a manually paused, operable Run', async () => {
      const run = makeThreePhaseRun({ status: 'running', manualPauseAt: Date.now() });
      const { service, setRun } = makeService(run);
      expect(await service.restartActivePhase(QUEUE_ID)).toEqual({ ok: true });
      expect(setRun).toHaveBeenCalledTimes(1);
    });
  });

  describe('Skip', () => {
    it('refuses a Phase id that is not the current active Phase (FR-004; Edge Cases)', async () => {
      const run = makeThreePhaseRun();
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.skipPhase(QUEUE_ID, 'gamma')).toEqual({
          ok: false,
          reason: 'phase-not-active'
        });
      });
    });

    it('refuses an unknown Phase id before checking activeness (FR-018)', async () => {
      const run = makeThreePhaseRun();
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.skipPhase(QUEUE_ID, 'not-a-phase')).toEqual({
          ok: false,
          reason: 'phase-id-not-in-pipeline-snapshot'
        });
      });
    });

    it('refuses a terminal Run (canceled) even though its currentPhase still names a real Phase (FR-004 — same "wrong-state" class FR-002 closed for Restart)', async () => {
      // A canceled Run's `currentPhase` is left unchanged by cancellation
      // (unlike a completed Run's, which moves to a sentinel), so Skip's
      // phase-currency check alone would not have caught this on its own.
      const run = makeThreePhaseRun({ status: 'canceled' });
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.skipPhase(QUEUE_ID, 'beta')).toEqual({
          ok: false,
          reason: 'run-terminal'
        });
      });
    });

    it('refuses a terminal Run (completed)', async () => {
      const run = makeThreePhaseRun({ status: 'completed' });
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.skipPhase(QUEUE_ID, 'beta')).toEqual({
          ok: false,
          reason: 'run-terminal'
        });
      });
    });

    it('allows Skip on a failed Run with the target Phase still current — a legitimate skip-to-recover path', async () => {
      const run = makeThreePhaseRun({ status: 'failed', pendingRetryAt: null });
      const { service, setRun } = makeService(run);
      expect(await service.skipPhase(QUEUE_ID, 'beta')).toEqual({ ok: true });
      expect(setRun).toHaveBeenCalled();
    });

    it('allows Skip on the current active Phase', async () => {
      const run = makeThreePhaseRun({ status: 'running' });
      const { service, setRun } = makeService(run);
      expect(await service.skipPhase(QUEUE_ID, 'beta')).toEqual({ ok: true });
      expect(setRun).toHaveBeenCalled();
    });
  });

  describe('Disable', () => {
    it('refuses the active Phase — already started (FR-005; closes the confirmed defect)', async () => {
      const run = makeThreePhaseRun();
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.disablePhase(QUEUE_ID, 'beta')).toEqual({
          ok: false,
          reason: 'phase-already-started'
        });
      });
    });

    it('refuses a completed Phase — already started (FR-005)', async () => {
      const run = makeThreePhaseRun();
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.disablePhase(QUEUE_ID, 'alpha')).toEqual({
          ok: false,
          reason: 'phase-already-started'
        });
      });
    });

    it('allows Disable on a future Phase', async () => {
      const run = makeThreePhaseRun();
      const { service, setRun } = makeService(run);
      expect(await service.disablePhase(QUEUE_ID, 'gamma')).toEqual({ ok: true });
      expect(setRun).toHaveBeenCalledTimes(1);
    });
  });

  describe('Enable', () => {
    it('refuses a future Phase with no override (FR-006; US1 Scenario 3)', async () => {
      const run = makeThreePhaseRun();
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.enablePhase(QUEUE_ID, 'gamma')).toEqual({
          ok: false,
          reason: 'no-disabled-override'
        });
      });
    });

    it('refuses a future Phase whose override is not "disabled" (FR-006 — "any override exists" is the confirmed defect)', async () => {
      const run = makeThreePhaseRun({
        phaseOverrides: [{ phaseId: 'gamma', action: 'skipped', setAt: 0, actor: 'operator' }]
      });
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.enablePhase(QUEUE_ID, 'gamma')).toEqual({
          ok: false,
          reason: 'no-disabled-override'
        });
      });
    });

    it('refuses a disabled override on a Phase that is no longer future (FR-006 — "not both future and disabled")', async () => {
      const run = makeThreePhaseRun({
        phaseOverrides: [{ phaseId: 'alpha', action: 'disabled', setAt: 0, actor: 'operator' }]
      });
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.enablePhase(QUEUE_ID, 'alpha')).toEqual({
          ok: false,
          reason: 'phase-not-future'
        });
      });
    });

    it('allows Enable on a future Phase carrying a disabled override', async () => {
      const run = makeThreePhaseRun({
        phaseOverrides: [{ phaseId: 'gamma', action: 'disabled', setAt: 0, actor: 'operator' }]
      });
      const { service, setRun } = makeService(run);
      expect(await service.enablePhase(QUEUE_ID, 'gamma')).toEqual({ ok: true });
      expect(setRun).toHaveBeenCalledTimes(1);
    });

    it('refuses an unknown Phase id (FR-018)', async () => {
      const run = makeThreePhaseRun();
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.enablePhase(QUEUE_ID, 'not-a-phase')).toEqual({
          ok: false,
          reason: 'phase-id-not-in-pipeline-snapshot'
        });
      });
    });
  });

  describe('Delete stays permissive (Feature 022 non-regression)', () => {
    it('still allows deleting the active Phase (targeting-only change, not eligibility)', async () => {
      const run = makeThreePhaseRun();
      const { service, setRun } = makeService(run);
      expect(await service.removeTaskPhase(QUEUE_ID, 'task-1', 'beta')).toMatchObject({ ok: true });
      expect(setRun).toHaveBeenCalledTimes(1);
    });

    it('still allows deleting a completed Phase', async () => {
      const run = makeThreePhaseRun();
      const { service, setRun } = makeService(run);
      expect(await service.removeTaskPhase(QUEUE_ID, 'task-1', 'alpha')).toMatchObject({ ok: true });
      expect(setRun).toHaveBeenCalledTimes(1);
    });

    it('still allows deleting a future Phase', async () => {
      const run = makeThreePhaseRun();
      const { service, setRun } = makeService(run);
      expect(await service.removeTaskPhase(QUEUE_ID, 'task-1', 'gamma')).toMatchObject({ ok: true });
      expect(setRun).toHaveBeenCalledTimes(1);
    });
  });

  // Feature 201 (US3, FR-018, FR-022, FR-023) — what deletion refuses, and
  // whether the word it refuses with describes the cause.
  //
  // The service sees a queue id it was handed and a Task id it was asked
  // about. It cannot tell "this Task does not exist" from "this Task exists
  // but the queue you addressed is running something else" — both arrive as
  // `run.featureId !== taskId`. Answering `unknown-task-id` for the second is
  // a reason that misdescribes the cause: the operator is told their Task is
  // unknown when it is known and merely not in flight. The id's existence is
  // decided one layer up, at the controller, where the request rows are
  // (T036); the service answers the question it can actually see.
  describe('Delete refusals name their cause (Feature 201)', () => {
    it("refuses no-active-run-for-task when the addressed queue's Run is not this Task's", async () => {
      // The Run is real, in flight, and holds the Phase being named — so no
      // other guard on this path can be the one that fires. Only the
      // Task-identity comparison distinguishes this from the passing cases
      // above, which is what makes the assertion about the reason word.
      const run = makeThreePhaseRun();
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.removeTaskPhase(QUEUE_ID, 'task-99', 'gamma')).toEqual({
          ok: false,
          reason: 'no-active-run-for-task'
        });
      });
    });

    it('still refuses no-run-in-flight on an idle queue', async () => {
      // Unchanged row. Checked before the Task comparison, so it must keep
      // winning: an idle queue has no Run to compare a Task id against, and
      // saying the Task is not running this queue's Run would invent one.
      const mocks = makeService(null as unknown as WorkflowRun);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.removeTaskPhase(QUEUE_ID, 'task-1', 'gamma')).toEqual({
          ok: false,
          reason: 'no-run-in-flight'
        });
      });
    });

    it('still refuses unknown-phase-id for a Phase the Run does not carry', async () => {
      // Unchanged row, and the ordering control for the one above: the Task id
      // is correct here, so this refusal can only come from the Phase check.
      const mocks = makeService(makeThreePhaseRun());
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.removeTaskPhase(QUEUE_ID, 'task-1', 'omega')).toEqual({
          ok: false,
          reason: 'unknown-phase-id'
        });
      });
    });

    it('still refuses phase-already-removed for a Phase already deleted', async () => {
      // Unchanged row. Distinct from `unknown-phase-id` on purpose: the Phase
      // is in the pipeline, so "unknown" would be false, and an operator who
      // deleted it once should be told it is already gone rather than that it
      // never existed.
      const run = makeThreePhaseRun({
        phaseOverrides: [
          { phaseId: 'gamma', action: 'removed', setAt: 1 }
        ] as unknown as WorkflowRun['phaseOverrides']
      });
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.removeTaskPhase(QUEUE_ID, 'task-1', 'gamma')).toEqual({
          ok: false,
          reason: 'phase-already-removed'
        });
      });
    });
  });

  describe('Pause / Resume — routed through the classifier without behavior change (FR-004)', () => {
    it('still refuses Pause with no in-flight Run', async () => {
      const run = makeThreePhaseRun({ status: 'completed' });
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.pauseActivePhase(QUEUE_ID)).toEqual({
          ok: false,
          reason: 'no-run-in-flight'
        });
      });
    });

    it('still refuses Resume when the Run is not paused', async () => {
      const run = makeThreePhaseRun({ status: 'running', manualPauseAt: null, pendingRetryAt: null });
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.resumeActivePhase(QUEUE_ID)).toEqual({
          ok: false,
          reason: 'run-not-paused'
        });
      });
    });
  });
});
