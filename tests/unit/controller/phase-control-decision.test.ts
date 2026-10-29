// FR-R3-151 — direct unit coverage for `decidePhaseControl` itself.
//
// `phase-control-service.test.ts`'s table-driven matrix proves every
// `PhaseControlService` method actually consults this classifier before
// writing; it deliberately does not exercise the classifier directly (see
// its own header comment), which left two of this file's branches with no
// coverage anywhere: 'restart' only ever reaches its own phase-currency
// check with `targetPhaseId === run.currentPhase` (its only real caller,
// `restartActivePhase`, never passes a mismatched id), and the breakpoint
// operations' null-`run` rejection is a fact `PhaseControlService`'s
// "provably unreachable" guard comments lean on without a test pinning it.
// This file drives `decidePhaseControl` directly so every branch — reached
// or not through the service layer — is asserted here.

import { describe, expect, it } from 'vitest';
import { decidePhaseControl } from '../../../src/controller/phase-control-decision';
import type { WorkflowRun } from '../../../src/state/workflow-run';

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
function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    featureId: 'task-1',
    featureDir: '',
    startedAt: 1,
    lastTransitionAt: 1,
    status: 'running',
    pipeline: PIPELINE,
    currentPhase: 'beta',
    currentIteration: 0,
    phasesCompleted: [
      { phase: 'alpha', iteration: 1, result: 'clean' }
    ] as unknown as WorkflowRun['phasesCompleted'],
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

describe('decidePhaseControl — pause', () => {
  it('refuses with no Run', () => {
    expect(decidePhaseControl({ operation: 'pause', run: null, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'no-run-in-flight'
    });
  });

  it('refuses a Run that is neither running nor in a retry countdown', () => {
    const run = makeRun({ status: 'failed', pendingRetryAt: null });
    expect(decidePhaseControl({ operation: 'pause', run, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'no-run-in-flight'
    });
  });

  it('refuses an already-paused Run', () => {
    const run = makeRun({ manualPauseAt: Date.now() });
    expect(decidePhaseControl({ operation: 'pause', run, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'run-already-paused'
    });
  });

  it('allows pausing a running Run', () => {
    const run = makeRun({ status: 'running' });
    expect(decidePhaseControl({ operation: 'pause', run, targetPhaseId: 'beta' })).toEqual({ eligible: true });
  });

  it('allows pausing a Run mid retry-countdown', () => {
    const run = makeRun({ status: 'paused', pendingRetryAt: Date.now() + 1000 });
    expect(decidePhaseControl({ operation: 'pause', run, targetPhaseId: 'beta' })).toEqual({ eligible: true });
  });
});

describe('decidePhaseControl — resume', () => {
  it('refuses with no Run', () => {
    expect(decidePhaseControl({ operation: 'resume', run: null, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'no-run-in-flight'
    });
  });

  it('refuses a Run that is neither manually paused nor in retry countdown', () => {
    const run = makeRun({ status: 'running' });
    expect(decidePhaseControl({ operation: 'resume', run, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'run-not-paused'
    });
  });

  it('allows resuming a manually-paused Run', () => {
    const run = makeRun({ manualPauseAt: Date.now() });
    expect(decidePhaseControl({ operation: 'resume', run, targetPhaseId: 'beta' })).toEqual({ eligible: true });
  });

  // FR-R4-F02 (contract W6 G19, US6-6) — a Run paused for credits has no manual pause and no retry
  // countdown, so before this case the operator's Resume refused it as `run-not-paused`, and a Run
  // whose credit polling stopped had no way back. Open or stopped, it is resumable.
  it.each([
    ['an open credit window', { pausedAt: 1, windowStartedAt: 2, stoppedAt: null }],
    ['a stopped credit window', { pausedAt: 1, windowStartedAt: 2, stoppedAt: 3 }]
  ])('allows resuming a Run paused for credits (%s)', (_name, creditPause) => {
    const run = makeRun({ status: 'paused', creditPause });
    expect(decidePhaseControl({ operation: 'resume', run, targetPhaseId: 'beta' })).toEqual({ eligible: true });
  });

  it('control: a paused Run with creditPause null and nothing else is still refused', () => {
    const run = makeRun({ status: 'paused', creditPause: null });
    expect(decidePhaseControl({ operation: 'resume', run, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'run-not-paused'
    });
  });
});

describe('decidePhaseControl — restart', () => {
  it('refuses with no Run', () => {
    expect(decidePhaseControl({ operation: 'restart', run: null, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'no-run-in-flight'
    });
  });

  it('refuses a terminal Run (completed) even before the phase-currency check', () => {
    const run = makeRun({ status: 'completed' });
    expect(decidePhaseControl({ operation: 'restart', run, targetPhaseId: 'not-beta' })).toEqual({
      eligible: false,
      reason: 'run-terminal'
    });
  });

  it('refuses a target that is not the current Phase — unreachable via PhaseControlService, whose only caller always passes run.currentPhase', () => {
    const run = makeRun({ status: 'running' });
    expect(decidePhaseControl({ operation: 'restart', run, targetPhaseId: 'gamma' })).toEqual({
      eligible: false,
      reason: 'phase-not-active'
    });
  });

  it('allows restarting an operable Run at its current Phase', () => {
    const run = makeRun({ status: 'running' });
    expect(decidePhaseControl({ operation: 'restart', run, targetPhaseId: 'beta' })).toEqual({ eligible: true });
  });
});

describe('decidePhaseControl — skip', () => {
  it('refuses with no Run', () => {
    expect(decidePhaseControl({ operation: 'skip', run: null, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'no-run-in-flight'
    });
  });

  it('refuses an unknown Phase id', () => {
    const run = makeRun();
    expect(decidePhaseControl({ operation: 'skip', run, targetPhaseId: 'not-a-phase' })).toEqual({
      eligible: false,
      reason: 'phase-id-not-in-pipeline-snapshot'
    });
  });

  it('refuses a terminal Run (canceled) even when currentPhase still names a real Phase', () => {
    const run = makeRun({ status: 'canceled' });
    expect(decidePhaseControl({ operation: 'skip', run, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'run-terminal'
    });
  });

  it('refuses a Phase id that is not the current active Phase', () => {
    const run = makeRun();
    expect(decidePhaseControl({ operation: 'skip', run, targetPhaseId: 'gamma' })).toEqual({
      eligible: false,
      reason: 'phase-not-active'
    });
  });

  // FR-R4-F20 (feature 248, contract T1) — Skip of a failed Run is retired. `failed` stays operable
  // for Restart, Resume and Retry, so `isOperableRunStatus` does not refuse it; the arm refuses it by
  // name, after `run-terminal` and before Phase currency (Clarify Q4).
  it('refuses the current Phase on a failed Run as run-failed (T1.1)', () => {
    const run = makeRun({ status: 'failed', pendingRetryAt: null });
    expect(decidePhaseControl({ operation: 'skip', run, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'run-failed'
    });
  });

  it('refuses a failed Run with a pending retry the same way (T1.2)', () => {
    const run = makeRun({
      status: 'failed',
      pendingRetryAt: Date.now() + 60_000,
      pendingRetryCause: 'transient_error'
    });
    expect(decidePhaseControl({ operation: 'skip', run, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'run-failed'
    });
  });

  it('answers run-failed, not phase-not-active, for a snapshot Phase that is not current (T1.3)', () => {
    const run = makeRun({ status: 'failed', pendingRetryAt: null });
    expect(decidePhaseControl({ operation: 'skip', run, targetPhaseId: 'gamma' })).toEqual({
      eligible: false,
      reason: 'run-failed'
    });
  });

  // FR-R4-F20 (US2, FR-005) — pins: both verdicts held at 5c015930 and must hold after. T1.7 differs
  // from T1.3 only by the Run's status, so the pair fixes the order of the two checks it separates.
  it.each(['running', 'paused'] as const)(
    'still answers phase-not-active for a snapshot Phase that is not current on a %s Run (T1.7)',
    (status) => {
      const run = makeRun({ status });
      expect(decidePhaseControl({ operation: 'skip', run, targetPhaseId: 'gamma' })).toEqual({
        eligible: false,
        reason: 'phase-not-active'
      });
    }
  );

  it.each(['running', 'paused'] as const)(
    'still admits the current Phase on a %s Run (T1.8)',
    (status) => {
      const run = makeRun({ status });
      expect(decidePhaseControl({ operation: 'skip', run, targetPhaseId: 'beta' })).toEqual({
        eligible: true
      });
    }
  );

  // FR-R4-F20 (US3, Clarify Q3) — pins: the refusals the new check must not capture. T1.4 differs from
  // T1.3 only by whether the Phase is in the snapshot, so the pair fixes the order of those two checks.
  it('answers phase-id-not-in-pipeline-snapshot for a Phase the failed Run does not carry (T1.4)', () => {
    const run = makeRun({ status: 'failed', pendingRetryAt: null });
    expect(decidePhaseControl({ operation: 'skip', run, targetPhaseId: 'not-a-phase' })).toEqual({
      eligible: false,
      reason: 'phase-id-not-in-pipeline-snapshot'
    });
  });

  it('answers run-terminal for a completed Run, even for a Phase in its snapshot (T1.5)', () => {
    const run = makeRun({ status: 'completed' });
    expect(decidePhaseControl({ operation: 'skip', run, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'run-terminal'
    });
  });

  it('answers run-terminal for a canceled Run on its current Phase (T1.6)', () => {
    const run = makeRun({ status: 'canceled' });
    expect(decidePhaseControl({ operation: 'skip', run, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'run-terminal'
    });
  });
});

describe('decidePhaseControl — disable', () => {
  it('refuses with no Run', () => {
    expect(decidePhaseControl({ operation: 'disable', run: null, targetPhaseId: 'gamma' })).toEqual({
      eligible: false,
      reason: 'no-run-in-flight'
    });
  });

  it('refuses an unknown Phase id', () => {
    const run = makeRun();
    expect(decidePhaseControl({ operation: 'disable', run, targetPhaseId: 'not-a-phase' })).toEqual({
      eligible: false,
      reason: 'phase-id-not-in-pipeline-snapshot'
    });
  });

  it('refuses the active Phase — already started', () => {
    const run = makeRun();
    expect(decidePhaseControl({ operation: 'disable', run, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'phase-already-started'
    });
  });

  it('refuses a completed Phase — already started', () => {
    const run = makeRun();
    expect(decidePhaseControl({ operation: 'disable', run, targetPhaseId: 'alpha' })).toEqual({
      eligible: false,
      reason: 'phase-already-started'
    });
  });

  it('allows disabling a future Phase', () => {
    const run = makeRun();
    expect(decidePhaseControl({ operation: 'disable', run, targetPhaseId: 'gamma' })).toEqual({ eligible: true });
  });
});

describe('decidePhaseControl — enable', () => {
  it('refuses with no Run', () => {
    expect(decidePhaseControl({ operation: 'enable', run: null, targetPhaseId: 'gamma' })).toEqual({
      eligible: false,
      reason: 'no-run-in-flight'
    });
  });

  it('refuses a future Phase with no override', () => {
    const run = makeRun();
    expect(decidePhaseControl({ operation: 'enable', run, targetPhaseId: 'gamma' })).toEqual({
      eligible: false,
      reason: 'no-disabled-override'
    });
  });

  it('refuses a future Phase whose override is not "disabled" — "any override exists" was the confirmed defect', () => {
    const run = makeRun({ phaseOverrides: [{ phaseId: 'gamma', action: 'skipped' }] as unknown as WorkflowRun['phaseOverrides'] });
    expect(decidePhaseControl({ operation: 'enable', run, targetPhaseId: 'gamma' })).toEqual({
      eligible: false,
      reason: 'no-disabled-override'
    });
  });

  it('refuses a disabled override on a Phase that is no longer future', () => {
    const run = makeRun({ phaseOverrides: [{ phaseId: 'alpha', action: 'disabled' }] as unknown as WorkflowRun['phaseOverrides'] });
    expect(decidePhaseControl({ operation: 'enable', run, targetPhaseId: 'alpha' })).toEqual({
      eligible: false,
      reason: 'phase-not-future'
    });
  });

  it('allows enabling a future Phase carrying a disabled override', () => {
    const run = makeRun({ phaseOverrides: [{ phaseId: 'gamma', action: 'disabled' }] as unknown as WorkflowRun['phaseOverrides'] });
    expect(decidePhaseControl({ operation: 'enable', run, targetPhaseId: 'gamma' })).toEqual({ eligible: true });
  });
});

describe('decidePhaseControl — delete', () => {
  it('stays permissive by design (Feature 022 FR-008–FR-013) — eligible for any state, even a null Run', () => {
    // `PhaseControlService#removeTaskPhase` keeps its own task-id/phase-id/
    // already-removed checks after this call returns eligible; this branch
    // exists only so Delete still routes through the one shared decision
    // point (census guard), not to add a restriction of its own.
    expect(decidePhaseControl({ operation: 'delete', run: null, targetPhaseId: 'anything' })).toEqual({
      eligible: true
    });
    expect(decidePhaseControl({ operation: 'delete', run: makeRun(), targetPhaseId: 'beta' })).toEqual({
      eligible: true
    });
  });
});

describe('decidePhaseControl — set-breakpoint', () => {
  it('refuses with no Run — unreachable via PhaseControlService today (its callers only ever pass a matched Run or take the run-not-in-flight fallback below), pinned directly here', () => {
    expect(decidePhaseControl({ operation: 'set-breakpoint', run: null, targetPhaseId: 'gamma' })).toEqual({
      eligible: false,
      reason: 'run-not-in-flight'
    });
  });

  it('refuses an unknown Phase id', () => {
    const run = makeRun();
    expect(decidePhaseControl({ operation: 'set-breakpoint', run, targetPhaseId: 'not-a-phase' })).toEqual({
      eligible: false,
      reason: 'phase-unknown'
    });
  });

  it('refuses the active Phase', () => {
    const run = makeRun();
    expect(decidePhaseControl({ operation: 'set-breakpoint', run, targetPhaseId: 'beta' })).toEqual({
      eligible: false,
      reason: 'phase-in-flight'
    });
  });

  it('refuses a completed Phase', () => {
    const run = makeRun();
    expect(decidePhaseControl({ operation: 'set-breakpoint', run, targetPhaseId: 'alpha' })).toEqual({
      eligible: false,
      reason: 'phase-completed'
    });
  });

  it('refuses an overridden Phase', () => {
    const run = makeRun({ phaseOverrides: [{ phaseId: 'gamma', action: 'disabled' }] as unknown as WorkflowRun['phaseOverrides'] });
    expect(decidePhaseControl({ operation: 'set-breakpoint', run, targetPhaseId: 'gamma' })).toEqual({
      eligible: false,
      reason: 'phase-overridden'
    });
  });

  it('refuses a Phase that already has a breakpoint armed', () => {
    const run = makeRun({
      phaseBreakpoints: [{ phaseId: 'gamma', setAt: 1, actor: 'operator' }] as unknown as WorkflowRun['phaseBreakpoints']
    });
    expect(decidePhaseControl({ operation: 'set-breakpoint', run, targetPhaseId: 'gamma' })).toEqual({
      eligible: false,
      reason: 'breakpoint-already-set'
    });
  });

  it('allows arming a breakpoint on a pending, unoverridden Phase', () => {
    const run = makeRun();
    expect(decidePhaseControl({ operation: 'set-breakpoint', run, targetPhaseId: 'gamma' })).toEqual({
      eligible: true
    });
  });
});

describe('decidePhaseControl — clear-breakpoint', () => {
  it('refuses with no Run', () => {
    expect(decidePhaseControl({ operation: 'clear-breakpoint', run: null, targetPhaseId: 'gamma' })).toEqual({
      eligible: false,
      reason: 'run-not-in-flight'
    });
  });

  it('refuses a Phase with no breakpoint set', () => {
    const run = makeRun();
    expect(decidePhaseControl({ operation: 'clear-breakpoint', run, targetPhaseId: 'gamma' })).toEqual({
      eligible: false,
      reason: 'breakpoint-not-set'
    });
  });

  it('allows clearing an armed breakpoint', () => {
    const run = makeRun({
      phaseBreakpoints: [{ phaseId: 'gamma', setAt: 1, actor: 'operator' }] as unknown as WorkflowRun['phaseBreakpoints']
    });
    expect(decidePhaseControl({ operation: 'clear-breakpoint', run, targetPhaseId: 'gamma' })).toEqual({
      eligible: true
    });
  });
});
