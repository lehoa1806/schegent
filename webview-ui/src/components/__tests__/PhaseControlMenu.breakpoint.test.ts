// Feature 028 US3 — Svelte component test for the future-phase
// breakpoint actions surfaced in PhaseControlMenu. Verifies that:
//   - "Pause when reached" is rendered only when the selected phase is
//     pending, not in-flight, not completed, has no override, and no
//     breakpoint already set.
//   - "Cancel scheduled pause" is rendered only when the selected phase
//     has an entry in `phaseBreakpoints`.
//   - Both buttons dispatch the corresponding helper from
//     `phase-breakpoint-ipc.ts` (mocked).
//   - Both buttons are gated by `isPrimary` and `activeRunId !== null`.
//
// Mirrors the dispatch pattern of the existing PhaseControlMenu test
// (mocks vscode-api → postCommand). For breakpoint helpers we mock
// the dedicated module so the test exercises the menu's wiring rather
// than the IPC plumbing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import PhaseControlMenu from '../PhaseControlMenu.svelte';

// Feature 093 (T080) — lifecycle controls are queue-addressed, so the component
// under test needs the queue whose Run it acts on.
const TEST_QUEUE_ID = 'q-alpha';

const setPhaseBreakpointSpy = vi.fn(
  (_runId: string, _phaseId: string) =>
    Promise.resolve({ status: 'accepted' as const })
);
const clearPhaseBreakpointSpy = vi.fn(
  (_runId: string, _phaseId: string) =>
    Promise.resolve({ status: 'accepted' as const })
);
vi.mock('../../lib/phase-breakpoint-ipc', () => ({
  setPhaseBreakpoint: (runId: string, phaseId: string) =>
    setPhaseBreakpointSpy(runId, phaseId),
  clearPhaseBreakpoint: (runId: string, phaseId: string) =>
    clearPhaseBreakpointSpy(runId, phaseId)
}));

// PhaseControlMenu also imports phase-control helpers and the IPC
// constants — stub vscode-api so nothing posts to a real bridge.
vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'corr-stub' }))
}));

beforeEach(() => {
  setPhaseBreakpointSpy.mockReset();
  setPhaseBreakpointSpy.mockResolvedValue({ status: 'accepted' as const });
  clearPhaseBreakpointSpy.mockReset();
  clearPhaseBreakpointSpy.mockResolvedValue({ status: 'accepted' as const });
});

afterEach(() => cleanup());

describe('PhaseControlMenu — future-phase breakpoint actions (028 US3)', () => {
  it('renders "Pause when reached" when the selected phase is pending and has no breakpoint/override', () => {
    const { getByTestId, queryByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        isPrimary: true,
        activeRunId: 'run-1',
        manualPauseAt: null,
        selectedPhase: 'speckit-tasks',
        selectedPhaseState: 'not-started',
        phaseOverrides: [],
        phaseBreakpoints: []
      }
    });

    expect(queryByTestId('phase-control-set-breakpoint')).not.toBeNull();
    expect(queryByTestId('phase-control-clear-breakpoint')).toBeNull();
    // The action MUST not be aria-disabled — it's the affordance the
    // operator uses to arm a breakpoint.
    expect(getByTestId('phase-control-set-breakpoint').getAttribute('aria-disabled') ?? 'false').toBe(
      'false'
    );
  });

  it('hides "Pause when reached" when the selected phase is the active phase (in-flight)', () => {
    const { queryByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-tasks',
        isPrimary: true,
        activeRunId: 'run-1',
        manualPauseAt: null,
        selectedPhase: 'speckit-tasks',
        selectedPhaseState: 'active',
        phaseOverrides: [],
        phaseBreakpoints: []
      }
    });

    expect(queryByTestId('phase-control-set-breakpoint')).toBeNull();
  });

  it('hides "Pause when reached" when the selected phase has an override', () => {
    const { queryByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        isPrimary: true,
        activeRunId: 'run-1',
        manualPauseAt: null,
        selectedPhase: 'speckit-tasks',
        selectedPhaseState: 'not-started',
        phaseOverrides: [{ phaseId: 'speckit-tasks', action: 'disabled' }],
        phaseBreakpoints: []
      }
    });

    expect(queryByTestId('phase-control-set-breakpoint')).toBeNull();
  });

  it('renders "Cancel scheduled pause" (and hides Set) when a breakpoint is armed on the selected phase', () => {
    const { queryByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        isPrimary: true,
        activeRunId: 'run-1',
        manualPauseAt: null,
        selectedPhase: 'speckit-tasks',
        selectedPhaseState: 'not-started',
        phaseOverrides: [],
        phaseBreakpoints: [{ phaseId: 'speckit-tasks' }]
      }
    });

    expect(queryByTestId('phase-control-set-breakpoint')).toBeNull();
    expect(queryByTestId('phase-control-clear-breakpoint')).not.toBeNull();
  });

  it('hides both actions when not primary host', () => {
    const { queryByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        isPrimary: false,
        activeRunId: 'run-1',
        manualPauseAt: null,
        selectedPhase: 'speckit-tasks',
        selectedPhaseState: 'not-started',
        phaseOverrides: [],
        phaseBreakpoints: []
      }
    });

    expect(queryByTestId('phase-control-set-breakpoint')).toBeNull();
    expect(queryByTestId('phase-control-clear-breakpoint')).toBeNull();
  });

  it('hides both actions when activeRunId is null', () => {
    const { queryByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        isPrimary: true,
        activeRunId: null,
        manualPauseAt: null,
        selectedPhase: 'speckit-tasks',
        selectedPhaseState: 'not-started',
        phaseOverrides: [],
        phaseBreakpoints: [{ phaseId: 'speckit-tasks' }]
      }
    });

    expect(queryByTestId('phase-control-set-breakpoint')).toBeNull();
    expect(queryByTestId('phase-control-clear-breakpoint')).toBeNull();
  });

  it('hides both actions when the view is showing a task other than the executing run', () => {
    // Both actions post `activeRunId` — the Run the queue is executing —
    // together with `selectedPhase`, a tile from whatever the surface chose to
    // display. On a mismatched surface that arms a breakpoint on one Run at a
    // phase named by another, and the armed pause then fires on a Run the
    // operator never touched. Hidden rather than disabled, matching how these
    // two already behave when there is no pending phase to arm.
    const { queryByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: false, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        isPrimary: true,
        activeRunId: 'run-1',
        manualPauseAt: null,
        selectedPhase: 'speckit-tasks',
        selectedPhaseState: 'not-started',
        phaseOverrides: [],
        phaseBreakpoints: []
      }
    });

    expect(queryByTestId('phase-control-set-breakpoint')).toBeNull();
    expect(queryByTestId('phase-control-clear-breakpoint')).toBeNull();
  });

  it('hides "Cancel scheduled pause" on an armed phase the view is not showing', () => {
    const { queryByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: false, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        isPrimary: true,
        activeRunId: 'run-1',
        manualPauseAt: null,
        selectedPhase: 'speckit-tasks',
        selectedPhaseState: 'not-started',
        phaseOverrides: [],
        phaseBreakpoints: [{ phaseId: 'speckit-tasks' }]
      }
    });

    expect(queryByTestId('phase-control-clear-breakpoint')).toBeNull();
    expect(queryByTestId('phase-control-set-breakpoint')).toBeNull();
  });

  it('clicking "Pause when reached" calls setPhaseBreakpoint with the active run id and selected phase', async () => {
    const { getByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        isPrimary: true,
        activeRunId: 'run-42',
        manualPauseAt: null,
        selectedPhase: 'speckit-implement',
        selectedPhaseState: 'not-started',
        phaseOverrides: [],
        phaseBreakpoints: []
      }
    });

    await fireEvent.click(getByTestId('phase-control-set-breakpoint'));
    expect(setPhaseBreakpointSpy).toHaveBeenCalledWith('run-42', 'speckit-implement');
    expect(clearPhaseBreakpointSpy).not.toHaveBeenCalled();
  });

  it('clicking "Cancel scheduled pause" calls clearPhaseBreakpoint with the active run id and selected phase', async () => {
    const { getByTestId } = render(PhaseControlMenu, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        currentPhase: 'speckit-plan',
        isPrimary: true,
        activeRunId: 'run-42',
        manualPauseAt: null,
        selectedPhase: 'speckit-implement',
        selectedPhaseState: 'not-started',
        phaseOverrides: [],
        phaseBreakpoints: [{ phaseId: 'speckit-implement' }]
      }
    });

    await fireEvent.click(getByTestId('phase-control-clear-breakpoint'));
    expect(clearPhaseBreakpointSpy).toHaveBeenCalledWith('run-42', 'speckit-implement');
    expect(setPhaseBreakpointSpy).not.toHaveBeenCalled();
  });
});
