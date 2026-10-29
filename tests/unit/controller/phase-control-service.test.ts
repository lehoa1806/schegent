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
  // The real `updateRun` applies the patch to the Run as it is inside the chain; the double
  // does the same to the fixture, so a patch that throws (a refusal) behaves as it does live.
  const updateRun = vi.fn(
    async (
      _queueId: string,
      update: { patch: (current: WorkflowRun) => Partial<WorkflowRun> }
    ): Promise<WorkflowRun> => ({ ...run, ...update.patch(run) })
  );
  const appendBreakpoint = vi.fn(async () => {});
  const appendPhaseControl = vi.fn(async () => {});
  // FR-R4-F20 — hoisted so a Skip test can serve a different Run on the re-read and count the
  // effects a refused or half-applied Skip must not have.
  const getRun = vi.fn(() => run);
  const cancelActive = vi.fn();
  const cancelPendingTimer = vi.fn();
  const resumeExisting = vi.fn(async () => true);
  const emitPhaseJumped = vi.fn(async () => {});
  const noteActivePhaseOverrideAbort = vi.fn();
  const armIsContinue = vi.fn();
  const service = new PhaseControlService({
    store: {
      getRun,
      updateRun,
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
    retryCoordinator: { cancelPendingTimer },
    isDriving: vi.fn(() => false),
    noteActivePhaseOverrideAbort,
    armIsContinue,
    cancelActive,
    resumeExisting,
    auditor: {
      appendPhaseControl,
      emitTaskPaused: vi.fn(async () => {}),
      emitPhaseJumped,
      appendBreakpoint
    }
  } as unknown as ConstructorParameters<typeof PhaseControlService>[0]);
  return {
    service,
    updateRun,
    appendBreakpoint,
    appendPhaseControl,
    getRun,
    cancelActive,
    cancelPendingTimer,
    resumeExisting,
    emitPhaseJumped,
    noteActivePhaseOverrideAbort,
    armIsContinue
  };
}

describe('phase membership without a pipeline snapshot (T022)', () => {
  it('refuses a breakpoint on a built-in Phase id when the Run carries no snapshot', async () => {
    // `speckit-specify` is the first of the seventeen ids the built-in layer used
    // to claim, so it is the id that demonstrates the substitution rather than
    // merely a miss: pre-feature this resolved through `BUILT_IN_PHASES` and the
    // breakpoint was accepted onto a Run whose Pipeline never named it.
    const { service, updateRun, appendBreakpoint } = makeService(makeRun({ pipeline: undefined }));

    const result = await service.setPhaseBreakpoint(QUEUE_ID, 'run-1', 'speckit-specify');

    expect(result).toEqual({ ok: false, reason: 'phase-unknown' });
    expect(updateRun).not.toHaveBeenCalled();
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
    const { service, updateRun } = makeService(run);

    expect(await service.setPhaseBreakpoint(QUEUE_ID, 'run-1', 'beta')).toEqual({ ok: true });
    expect(updateRun).toHaveBeenCalledTimes(1);
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
// `store.updateRun`, `appendPhaseControl`, and `appendBreakpoint` are all
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
  expect(mocks.updateRun).not.toHaveBeenCalled();
  expect(mocks.appendPhaseControl).not.toHaveBeenCalled();
  expect(mocks.appendBreakpoint).not.toHaveBeenCalled();
}

/** Lets the `setImmediate` that a Skip's resume would have been scheduled on run. */
const drainImmediates = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * FR-R4-F20 (FR-003) — a refused Skip leaves no effect beyond the writes `expectZeroWrites` checks:
 * no phase-jumped row, no abort, no timer cancelled, and, once the `setImmediate` queue has drained,
 * no resume.
 */
async function expectNoSkipEffects(mocks: ReturnType<typeof makeService>): Promise<void> {
  await drainImmediates();
  expect(mocks.emitPhaseJumped).not.toHaveBeenCalled();
  expect(mocks.cancelActive).not.toHaveBeenCalled();
  expect(mocks.cancelPendingTimer).not.toHaveBeenCalled();
  expect(mocks.resumeExisting).not.toHaveBeenCalled();
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
      const { service, updateRun } = makeService(run);
      expect(await service.restartActivePhase(QUEUE_ID)).toEqual({ ok: true });
      expect(updateRun).toHaveBeenCalledTimes(1);
    });

    it('allows Restart on a manually paused, operable Run', async () => {
      const run = makeThreePhaseRun({ status: 'running', manualPauseAt: Date.now() });
      const { service, updateRun } = makeService(run);
      expect(await service.restartActivePhase(QUEUE_ID)).toEqual({ ok: true });
      expect(updateRun).toHaveBeenCalledTimes(1);
    });
  });

  describe('Skip', () => {
    it('refuses a Phase id that is not the current active Phase (FR-004; Edge Cases)', async () => {
      const run = makeThreePhaseRun();
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.skipPhase(QUEUE_ID, run.id, 'gamma')).toEqual({
          ok: false,
          reason: 'phase-not-active'
        });
      });
    });

    it('refuses an unknown Phase id before checking activeness (FR-018)', async () => {
      const run = makeThreePhaseRun();
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.skipPhase(QUEUE_ID, run.id, 'not-a-phase')).toEqual({
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
        expect(await mocks.service.skipPhase(QUEUE_ID, run.id, 'beta')).toEqual({
          ok: false,
          reason: 'run-terminal'
        });
      });
    });

    it('refuses a terminal Run (completed)', async () => {
      const run = makeThreePhaseRun({ status: 'completed' });
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.skipPhase(QUEUE_ID, run.id, 'beta')).toEqual({
          ok: false,
          reason: 'run-terminal'
        });
      });
    });

    // FR-R4-F20 (T2.1) — replaces the test that asserted a failed Run's Skip as admitted, "a
    // legitimate skip-to-recover path". It revived the Run and lifted its queue's halt with no
    // operator choice; the classifier now refuses it before anything is written.
    it('refuses Skip on a failed Run with the target Phase still current, and writes nothing (T2.1)', async () => {
      const run = makeThreePhaseRun({ status: 'failed', pendingRetryAt: null });
      const mocks = makeService(run);
      await expectZeroWrites(mocks, async () => {
        expect(await mocks.service.skipPhase(QUEUE_ID, run.id, 'beta')).toEqual({
          ok: false,
          reason: 'run-failed'
        });
      });
      await expectNoSkipEffects(mocks);
    });

    it('allows Skip on the current active Phase', async () => {
      const run = makeThreePhaseRun({ status: 'running' });
      const { service, updateRun } = makeService(run);
      expect(await service.skipPhase(QUEUE_ID, run.id, 'beta')).toEqual({ ok: true });
      expect(updateRun).toHaveBeenCalled();
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
      const { service, updateRun } = makeService(run);
      expect(await service.disablePhase(QUEUE_ID, 'gamma')).toEqual({ ok: true });
      expect(updateRun).toHaveBeenCalledTimes(1);
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
      const { service, updateRun } = makeService(run);
      expect(await service.enablePhase(QUEUE_ID, 'gamma')).toEqual({ ok: true });
      expect(updateRun).toHaveBeenCalledTimes(1);
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
      const { service, updateRun } = makeService(run);
      expect(await service.removeTaskPhase(QUEUE_ID, 'task-1', 'beta')).toMatchObject({ ok: true });
      expect(updateRun).toHaveBeenCalledTimes(1);
    });

    it('still allows deleting a completed Phase', async () => {
      const run = makeThreePhaseRun();
      const { service, updateRun } = makeService(run);
      expect(await service.removeTaskPhase(QUEUE_ID, 'task-1', 'alpha')).toMatchObject({ ok: true });
      expect(updateRun).toHaveBeenCalledTimes(1);
    });

    it('still allows deleting a future Phase', async () => {
      const run = makeThreePhaseRun();
      const { service, updateRun } = makeService(run);
      expect(await service.removeTaskPhase(QUEUE_ID, 'task-1', 'gamma')).toMatchObject({ ok: true });
      expect(updateRun).toHaveBeenCalledTimes(1);
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

// FR-R4-F14 (spec 242, contract W4.1, TA6) — a failed Run carrying a failure cause leaves `failed`
// through each of the writers below without it. FR-R4-F20 retired the third, Skip's revive, which is
// why its case is now a refusal that leaves the cause where it was. The patch writes `failureCause: undefined`
// explicitly: `updateRun` removes a key whose patch value is `undefined`, and
// `validateRunInvariants` refuses the Run if the key stays beside a non-failed status.
describe('a failed Run leaves failed without its failure cause (FR-R4-F14, W4.1)', () => {
  type RecordedUpdate = { patch: (current: WorkflowRun) => Partial<WorkflowRun>; label?: string };

  /** The patch the writer handed `updateRun` last, built against the Run it read. */
  function lastPatch(
    updateRun: ReturnType<typeof makeService>['updateRun'],
    run: WorkflowRun
  ): Partial<WorkflowRun> {
    const calls = updateRun.mock.calls as unknown as Array<[string, RecordedUpdate]>;
    const last = calls.at(-1);
    if (last === undefined) throw new Error('expected a Run update, found none');
    return last[1].patch(run);
  }

  function expectClearsCause(patch: Partial<WorkflowRun>): void {
    expect(Object.keys(patch)).toContain('failureCause');
    expect(patch.failureCause).toBeUndefined();
  }

  it('resumeActivePhase resumes a failed Run without the key', async () => {
    const run = makeThreePhaseRun({
      status: 'failed',
      failureCause: 'phase_failed',
      manualPauseAt: 1,
      manualPauseCause: 'operator-paused'
    });
    const { service, updateRun } = makeService(run);

    expect(await service.resumeActivePhase(QUEUE_ID)).toEqual({ ok: true });
    const patch = lastPatch(updateRun, run);
    expect(patch.status).toBe('running');
    expectClearsCause(patch);
  });

  it('restartActivePhase restarts a failed Run without the key', async () => {
    const run = makeThreePhaseRun({ status: 'failed', failureCause: 'phase_failed' });
    const { service, updateRun } = makeService(run);

    expect(await service.restartActivePhase(QUEUE_ID)).toEqual({ ok: true });
    const patch = lastPatch(updateRun, run);
    expect(patch.status).toBe('running');
    expectClearsCause(patch);
  });

  // FR-R4-F20 (T2.2) — replaces the skip-to-recover revive case. Skip no longer writes the Run, so
  // there is no patch to carry the key: the refusal leaves `failureCause` where it was.
  it('Skip is refused on a failed Run, and the Run keeps its failure cause (T2.2)', async () => {
    const run = makeThreePhaseRun({ status: 'failed', failureCause: 'phase_failed', pendingRetryAt: null });
    const { service, updateRun } = makeService(run);

    expect(await service.skipPhase(QUEUE_ID, run.id, 'beta')).toEqual({ ok: false, reason: 'run-failed' });
    expect(updateRun).not.toHaveBeenCalled();
    expect(run.failureCause).toBe('phase_failed');
  });
});

// FR-R4-F20 (feature 248, contract T2.5 and T2.6, D5) — a Skip names the Run the operator confirmed.
// `skipPhase(queueId, runId, phaseId)` compares `runId` with the queue's Run the way
// `setPhaseBreakpoint` does, so a Skip confirmed against a Run that has since been replaced is
// refused rather than applied to its successor. The re-read after the write compares the id too: a
// Run that replaced the confirmed one in that gap is neither aborted nor resumed (research R3).
describe('Skip names its Run (FR-R4-F20, D5)', () => {
  it('refuses a runId that is not the queue Run, and writes nothing (T2.5)', async () => {
    const run = makeThreePhaseRun({ id: 'run-current' });
    const mocks = makeService(run);
    await expectZeroWrites(mocks, async () => {
      expect(await mocks.service.skipPhase(QUEUE_ID, 'run-replaced', 'beta')).toEqual({
        ok: false,
        reason: 'no-run-in-flight'
      });
    });
    await expectNoSkipEffects(mocks);
    expect(mocks.armIsContinue).not.toHaveBeenCalled();
  });

  // A paused re-read Run is resumable only with a pause or a countdown on it, so the fixture
  // carries a manual pause; otherwise the resume classifier would refuse before it did anything.
  const rereadOf = (id: string, status: 'running' | 'paused'): WorkflowRun =>
    makeThreePhaseRun(
      status === 'paused'
        ? { id, status, manualPauseAt: 1, manualPauseCause: 'operator-paused' }
        : { id, status }
    );

  it.each(['running', 'paused'] as const)(
    'accepts a Skip whose re-read is a different %s Run on the same Phase, and aborts or resumes nothing (T2.6)',
    async (status) => {
      const run = makeThreePhaseRun({ id: 'run-confirmed' });
      const mocks = makeService(run);
      mocks.getRun.mockReturnValueOnce(run).mockReturnValue(rereadOf('run-replacement', status));

      expect(await mocks.service.skipPhase(QUEUE_ID, 'run-confirmed', 'beta')).toEqual({ ok: true });
      await drainImmediates();

      expect(mocks.updateRun).toHaveBeenCalledTimes(1);
      expect(mocks.cancelActive).not.toHaveBeenCalled();
      expect(mocks.noteActivePhaseOverrideAbort).not.toHaveBeenCalled();
      expect(mocks.emitPhaseJumped).not.toHaveBeenCalled();
      expect(mocks.armIsContinue).not.toHaveBeenCalled();
      expect(mocks.resumeExisting).not.toHaveBeenCalled();
    }
  );

  // The sibling that makes T2.6 non-vacuous: the same re-read with the confirmed Run's own id takes
  // the branch T2.6 shows is skipped (FR-005, unchanged at 5c015930).
  it('control: the same Run on the re-read aborts a running Phase', async () => {
    const run = makeThreePhaseRun({ id: 'run-confirmed' });
    const mocks = makeService(run);
    mocks.getRun.mockReturnValueOnce(run).mockReturnValue(rereadOf('run-confirmed', 'running'));

    expect(await mocks.service.skipPhase(QUEUE_ID, 'run-confirmed', 'beta')).toEqual({ ok: true });

    expect(mocks.noteActivePhaseOverrideAbort).toHaveBeenCalledWith(QUEUE_ID, 'run-confirmed', 'beta');
    expect(mocks.emitPhaseJumped).toHaveBeenCalledTimes(1);
    expect(mocks.cancelActive).toHaveBeenCalledWith(QUEUE_ID);
  });

  it('control: the same Run on the re-read resumes a paused Phase', async () => {
    const run = makeThreePhaseRun({ id: 'run-confirmed' });
    const mocks = makeService(run);
    mocks.getRun.mockReturnValueOnce(run).mockReturnValue(rereadOf('run-confirmed', 'paused'));

    expect(await mocks.service.skipPhase(QUEUE_ID, 'run-confirmed', 'beta')).toEqual({ ok: true });

    expect(mocks.armIsContinue).toHaveBeenCalledWith(QUEUE_ID);
    expect(mocks.cancelActive).not.toHaveBeenCalled();
  });
});

// FR-R4-F20 (feature 248, contract T2.3 and T2.4, D3 and D4) — a Run can fail in either gap a Skip has.
//
// Before the write: the pre-read saw it `running`, so the service's own decision admitted it, and by
// the time the update chain ran it had failed. The chain re-decides with the same classifier (`admit`),
// so the refusal comes from there and nothing is written (FR-002).
//
// After the write: the override was written while the Run was still operable, and the re-read finds it
// `failed`. The override and its `phase-skipped` row stand; nothing is revived, resumed, scheduled or
// cancelled, and the Skip is acknowledged accepted (D4). At 5c015930 the two failed branches here
// cleared the retry pair or revived the Run to `running` and scheduled a resume.
describe('Skip of a Run that fails while the Skip is in flight (FR-R4-F20, D3, D4)', () => {
  it('refuses inside the update chain when the Run has failed since the pre-read (T2.3)', async () => {
    const run = makeThreePhaseRun({ status: 'running' });
    const failedNow = makeThreePhaseRun({ status: 'failed', pendingRetryAt: null });
    const mocks = makeService(run);
    // The real `updateRun` applies the patch to the Run as it is at write time; here that Run is the
    // failed one, where the service's pre-read saw the running one.
    mocks.updateRun.mockImplementationOnce(async (_queueId, update) => ({
      ...failedNow,
      ...update.patch(failedNow)
    }));

    expect(await mocks.service.skipPhase(QUEUE_ID, run.id, 'beta')).toEqual({
      ok: false,
      reason: 'run-failed'
    });

    expect(mocks.updateRun).toHaveBeenCalledTimes(1);
    expect(mocks.appendPhaseControl).not.toHaveBeenCalled();
    expect(mocks.appendBreakpoint).not.toHaveBeenCalled();
    await expectNoSkipEffects(mocks);
  });

  // Both deleted branches are covered: a failed Run with a pending retry, and one without.
  it.each([
    ['no pending retry', null],
    ['a pending retry', Date.now() + 60_000]
  ])(
    'acknowledges accepted and does nothing further when the re-read is failed with %s (T2.4)',
    async (_label, pendingRetryAt) => {
      const run = makeThreePhaseRun({ status: 'running' });
      const failedAfterWrite = makeThreePhaseRun({
        status: 'failed',
        pendingRetryAt,
        pendingRetryCause: pendingRetryAt === null ? null : 'transient_error',
        failureCause: 'phase_failed'
      });
      const mocks = makeService(run);
      mocks.getRun.mockReturnValueOnce(run).mockReturnValue(failedAfterWrite);

      expect(await mocks.service.skipPhase(QUEUE_ID, run.id, 'beta')).toEqual({ ok: true });

      // One write, the override; its audit row stands; no second write revives or clears anything.
      expect(mocks.updateRun).toHaveBeenCalledTimes(1);
      expect(mocks.appendPhaseControl).toHaveBeenCalledTimes(1);
      expect(mocks.appendPhaseControl).toHaveBeenCalledWith('phase-skipped', expect.anything(), expect.anything());
      await expectNoSkipEffects(mocks);
      expect(mocks.noteActivePhaseOverrideAbort).not.toHaveBeenCalled();
      expect(mocks.armIsContinue).not.toHaveBeenCalled();
    }
  );
});
