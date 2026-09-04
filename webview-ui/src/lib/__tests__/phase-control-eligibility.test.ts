// FR-R3-154 (T1646) — the phase-control eligibility predicates, asserted
// without rendering.
//
// `PhaseControlMenu.test.ts` already observes these through `aria-disabled`,
// and that is the right level for "does the button look clickable". It is the
// wrong level for the two distinctions this file pins, because both are
// invisible in a passing render:
//
//   * the off-target guard applies to every `queueId`-addressed control and
//     deliberately NOT to Delete — a component test that renders one surface
//     cannot show that the exception is intentional rather than an omission;
//   * Enable is eligible only for a `disabled` override, never a `skipped`
//     one. The earlier "any override" check left Enable clickable for a stale
//     `skipped` selection and the host silently refused it, which is exactly
//     the shape a render assertion reads as working.

import { describe, expect, it } from 'vitest';

import {
  phaseControlEligibility,
  type PhaseControlEligibilityInput
} from '../phase-control-eligibility';

/**
 * Everything eligible: primary host, on-target surface, an active phase, a
 * future selection with no override and no breakpoint. Each case below turns
 * exactly one fact off, so what it proves is what it changed.
 */
function base(over: Partial<PhaseControlEligibilityInput> = {}): PhaseControlEligibilityInput {
  return {
    isPrimary: true,
    targetsSubjectRun: true,
    currentPhase: 'speckit-implement',
    activeTaskId: 'task-7',
    activeRunId: 'run-3',
    manualPauseAt: null,
    selectedPhase: 'speckit-plan',
    selectedPhaseState: 'not-started',
    phaseOverrides: [],
    phaseBreakpoints: [],
    ...over
  };
}

describe('the off-target guard', () => {
  it('disables every queue-addressed control when the surface is not about this Run', () => {
    const gate = phaseControlEligibility(base({ targetsSubjectRun: false }));
    expect({
      pause: gate.pauseDisabled,
      resume: gate.resumeDisabled,
      restart: gate.restartDisabled,
      skip: gate.skipDisabled,
      retryNow: gate.retryNowDisabled,
      disable: gate.disableDisabled,
      enable: gate.enableDisabled
    }).toEqual({
      pause: true,
      resume: true,
      restart: true,
      skip: true,
      retryNow: true,
      disable: true,
      enable: true
    });
  });

  it('leaves Delete enabled off-target, which is the documented exception', () => {
    // Not an omission: Delete posts a Task id and a selected phase, both drawn
    // from the surface's own subject, and resolves its queue from the Task.
    // There is no off-target Run for it to hit. Asserted so that "conjoin the
    // guard into every control" — which the bug report proposed — fails here
    // rather than passing quietly as extra safety.
    expect(phaseControlEligibility(base({ targetsSubjectRun: false })).deleteDisabled).toBe(false);
  });

  it('hides both breakpoint actions off-target rather than disabling them', () => {
    const armed = [{ phaseId: 'speckit-plan' }];
    expect(
      phaseControlEligibility(base({ targetsSubjectRun: false })).showSetBreakpoint
    ).toBe(false);
    expect(
      phaseControlEligibility(
        base({ targetsSubjectRun: false, phaseBreakpoints: armed })
      ).showClearBreakpoint
    ).toBe(false);
    // The on-target control for both, so the two above are not passing on some
    // other missing precondition.
    expect(phaseControlEligibility(base()).showSetBreakpoint).toBe(true);
    expect(
      phaseControlEligibility(base({ phaseBreakpoints: armed })).showClearBreakpoint
    ).toBe(true);
  });

  it('disables everything on a non-primary host', () => {
    const gate = phaseControlEligibility(base({ isPrimary: false }));
    expect(gate.pauseDisabled).toBe(true);
    expect(gate.deleteDisabled).toBe(true);
    expect(gate.showSetBreakpoint).toBe(false);
  });
});

describe('Enable and Disable read the selected tile, not the active phase', () => {
  it('Enable is eligible for a `disabled` selection', () => {
    const gate = phaseControlEligibility(
      base({
        selectedPhaseState: 'disabled',
        phaseOverrides: [{ phaseId: 'speckit-plan' }]
      })
    );
    expect(gate.enableDisabled).toBe(false);
    expect(gate.selectedHasOverride).toBe(true);
  });

  it('Enable stays disabled for a `skipped` selection, which the host refuses', () => {
    // The closed defect: `selectedHasOverride` is true here — so the template
    // shows the Enable label — while `decidePhaseControl`'s 'enable' branch
    // requires a `disabled` override. A clickable Enable here produces a
    // refusal and nothing else.
    const gate = phaseControlEligibility(
      base({
        selectedPhaseState: 'skipped',
        phaseOverrides: [{ phaseId: 'speckit-plan' }]
      })
    );
    expect(gate.selectedHasOverride).toBe(true);
    expect(gate.enableDisabled).toBe(true);
  });

  it('Disable is eligible only while the selection is still future', () => {
    expect(phaseControlEligibility(base()).disableDisabled).toBe(false);
    for (const state of ['active', 'completed', 'skipped', 'disabled'] as const) {
      expect(
        phaseControlEligibility(base({ selectedPhaseState: state })).disableDisabled,
        `a ${state} selection must not be disable-able`
      ).toBe(true);
    }
  });

  it('a null selection disables both rather than falling back to the active phase', () => {
    // The fallback to `currentPhase` was FR-R3-151's defect: it acted on a
    // phase the operator had not selected. `currentPhase` stays set here, so
    // the fallback would be available if it existed.
    const gate = phaseControlEligibility(base({ selectedPhase: null }));
    expect(gate.disableDisabled).toBe(true);
    expect(gate.enableDisabled).toBe(true);
    expect(gate.deleteDisabled).toBe(true);
    expect(gate.restartDisabled).toBe(false);
  });

  it('reads the override list by phase id, not by position', () => {
    const gate = phaseControlEligibility(
      base({ phaseOverrides: [{ phaseId: 'speckit-specify' }] })
    );
    expect(gate.selectedHasOverride).toBe(false);
  });
});

describe('Pause and Resume are exclusive on the manual-pause fact', () => {
  it('offers Pause while running and Resume while paused', () => {
    const running = phaseControlEligibility(base());
    expect([running.isManuallyPaused, running.pauseDisabled, running.resumeDisabled]).toEqual([
      false,
      false,
      true
    ]);

    const paused = phaseControlEligibility(base({ manualPauseAt: '2026-09-03T12:00:00.000Z' }));
    expect([paused.isManuallyPaused, paused.pauseDisabled, paused.resumeDisabled]).toEqual([
      true,
      true,
      false
    ]);
  });

  it('disables both when there is no active phase to act on', () => {
    const gate = phaseControlEligibility(base({ currentPhase: null }));
    expect(gate.pauseDisabled).toBe(true);
    expect(gate.resumeDisabled).toBe(true);
    expect(gate.restartDisabled).toBe(true);
    expect(gate.retryNowDisabled).toBe(true);
    // Selection-addressed controls are unaffected: they never read the active
    // phase, which is the whole point of the split.
    expect(gate.disableDisabled).toBe(false);
    expect(gate.deleteDisabled).toBe(false);
  });
});

describe('breakpoint visibility', () => {
  it('offers arming only for a future, un-overridden, un-armed selection', () => {
    expect(phaseControlEligibility(base()).showSetBreakpoint).toBe(true);
    expect(
      phaseControlEligibility(base({ selectedPhaseState: 'active' })).showSetBreakpoint
    ).toBe(false);
    expect(
      phaseControlEligibility(base({ phaseOverrides: [{ phaseId: 'speckit-plan' }] }))
        .showSetBreakpoint
    ).toBe(false);
    expect(
      phaseControlEligibility(base({ phaseBreakpoints: [{ phaseId: 'speckit-plan' }] }))
        .showSetBreakpoint
    ).toBe(false);
  });

  it('offers cancelling only for an armed selection, and the two never both show', () => {
    const armed = phaseControlEligibility(base({ phaseBreakpoints: [{ phaseId: 'speckit-plan' }] }));
    expect([armed.showSetBreakpoint, armed.showClearBreakpoint]).toEqual([false, true]);
    const unarmed = phaseControlEligibility(base());
    expect([unarmed.showSetBreakpoint, unarmed.showClearBreakpoint]).toEqual([true, false]);
  });

  it('hides both when the run id the IPC would target is unknown', () => {
    const gate = phaseControlEligibility(
      base({ activeRunId: null, phaseBreakpoints: [{ phaseId: 'speckit-plan' }] })
    );
    expect(gate.showSetBreakpoint).toBe(false);
    expect(gate.showClearBreakpoint).toBe(false);
  });
});
