// Feature 028 US3 — Svelte component test for the three-way phase-tile
// indicator. Verifies:
//   - 'paused-active' renders only when the tile is the active phase and
//     `manualPauseCause === 'operator-paused'`.
//   - 'breakpoint-fired' renders only when the tile is the active phase
//     and `manualPauseCause === 'breakpoint-paused'` and the tile's id
//     matches `resumeTargetPhaseId`.
//   - 'breakpoint-scheduled' renders only when the tile is a pending
//     phase whose name appears in `phaseBreakpoints`.
//   - The three indicators carry distinct `data-state` attributes so a
//     visual-regression snapshot can detect drift.

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import PhaseProgression from '../PhaseProgression.svelte';
import type { PhaseTile } from '../../lib/snapshot-types';

// Feature 093 (T080) — lifecycle controls are queue-addressed, so the component
// under test needs the queue whose Run it acts on.
const TEST_QUEUE_ID = 'q-alpha';

afterEach(() => cleanup());

function buildPhase(
  name: PhaseTile['name'],
  order: PhaseTile['order'],
  state: PhaseTile['state']
): PhaseTile {
  return Object.freeze({
    name,
    order,
    state,
    iteration: 1,
    lastResult: null,
    elapsedMs: 0,
    subProgress: null
  });
}

function buildStandardPhases(): readonly PhaseTile[] {
  return Object.freeze([
    buildPhase('speckit-specify', 1, 'completed'),
    buildPhase('speckit-clarify', 2, 'completed'),
    buildPhase('speckit-plan', 3, 'active'),
    buildPhase('speckit-tasks', 4, 'not-started'),
    buildPhase('speckit-analyze', 5, 'not-started'),
    buildPhase('speckit-implement', 6, 'not-started'),
    buildPhase('finalize', 7, 'not-started')
  ]);
}

describe('PhaseProgression — breakpoint indicators (028 US3)', () => {
  it('paused-active: active tile carries data-state="paused-active" when manualPauseCause is operator-paused', () => {
    const { getByTestId } = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID,
        phases: buildStandardPhases(),
        activeTaskId: 'req-1',
        activeRunId: 'run-1',
        isPrimary: true,
        manualPauseAt: '2026-05-15T00:00:00.000Z',
        manualPauseCause: 'operator-paused',
        resumeTargetPhaseId: null,
        phaseBreakpoints: []
      }
    });

    const tile = getByTestId('phase-progression-speckit-plan');
    expect(tile.getAttribute('data-state')).toBe('paused-active');
    expect(getByTestId('phase-indicator-paused-active-speckit-plan')).not.toBeNull();
  });

  it('breakpoint-fired: active tile carries data-state="breakpoint-fired" when manualPauseCause is breakpoint-paused AND resumeTargetPhaseId matches', () => {
    const { getByTestId } = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID,
        phases: buildStandardPhases(),
        activeTaskId: 'req-1',
        activeRunId: 'run-1',
        isPrimary: true,
        manualPauseAt: '2026-05-15T00:00:00.000Z',
        manualPauseCause: 'breakpoint-paused',
        resumeTargetPhaseId: 'speckit-plan',
        phaseBreakpoints: []
      }
    });

    const tile = getByTestId('phase-progression-speckit-plan');
    expect(tile.getAttribute('data-state')).toBe('breakpoint-fired');
    expect(getByTestId('phase-indicator-breakpoint-fired-speckit-plan')).not.toBeNull();
  });

  it('breakpoint-scheduled: pending tile with an entry in phaseBreakpoints carries data-state="breakpoint-scheduled"', () => {
    const { getByTestId } = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID,
        phases: buildStandardPhases(),
        activeTaskId: 'req-1',
        activeRunId: 'run-1',
        isPrimary: true,
        manualPauseAt: null,
        manualPauseCause: null,
        resumeTargetPhaseId: null,
        phaseBreakpoints: [
          { phaseId: 'speckit-implement', setAt: '2026-05-15T00:00:00.000Z', actor: 'operator' as const }
        ]
      }
    });

    const armedTile = getByTestId('phase-progression-speckit-implement');
    expect(armedTile.getAttribute('data-state')).toBe('breakpoint-scheduled');
    expect(getByTestId('phase-indicator-breakpoint-scheduled-speckit-implement')).not.toBeNull();

    // A pending tile without a breakpoint stays in its base state.
    const otherTile = getByTestId('phase-progression-speckit-tasks');
    expect(otherTile.getAttribute('data-state')).toBe('not-started');
  });

  it('completed tile does NOT pick up a breakpoint-scheduled indicator even if listed in phaseBreakpoints', () => {
    const { getByTestId } = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID,
        phases: buildStandardPhases(),
        activeTaskId: 'req-1',
        activeRunId: 'run-1',
        isPrimary: true,
        manualPauseAt: null,
        manualPauseCause: null,
        resumeTargetPhaseId: null,
        phaseBreakpoints: [
          { phaseId: 'speckit-clarify', setAt: '2026-05-15T00:00:00.000Z', actor: 'operator' as const }
        ]
      }
    });

    const completedTile = getByTestId('phase-progression-speckit-clarify');
    expect(completedTile.getAttribute('data-state')).toBe('completed');
  });

  it('three indicators expose distinct data-state values for visual regression', () => {
    // Render three separate snapshots and verify the data-state strings
    // are pairwise distinct. This is what protects against accidental
    // consolidation into a single "paused" indicator.
    const a = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID,
        phases: buildStandardPhases(),
        activeTaskId: 'req-1',
        activeRunId: 'run-1',
        isPrimary: true,
        manualPauseAt: '2026-05-15T00:00:00.000Z',
        manualPauseCause: 'operator-paused',
        resumeTargetPhaseId: null,
        phaseBreakpoints: []
      }
    });
    const aState = a.getByTestId('phase-progression-speckit-plan').getAttribute('data-state');
    a.unmount();

    const b = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID,
        phases: buildStandardPhases(),
        activeTaskId: 'req-1',
        activeRunId: 'run-1',
        isPrimary: true,
        manualPauseAt: '2026-05-15T00:00:00.000Z',
        manualPauseCause: 'breakpoint-paused',
        resumeTargetPhaseId: 'speckit-plan',
        phaseBreakpoints: []
      }
    });
    const bState = b.getByTestId('phase-progression-speckit-plan').getAttribute('data-state');
    b.unmount();

    const c = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID,
        phases: buildStandardPhases(),
        activeTaskId: 'req-1',
        activeRunId: 'run-1',
        isPrimary: true,
        manualPauseAt: null,
        manualPauseCause: null,
        resumeTargetPhaseId: null,
        phaseBreakpoints: [
          { phaseId: 'speckit-implement', setAt: '2026-05-15T00:00:00.000Z', actor: 'operator' as const }
        ]
      }
    });
    const cState = c.getByTestId('phase-progression-speckit-implement').getAttribute('data-state');
    c.unmount();

    expect(aState).toBe('paused-active');
    expect(bState).toBe('breakpoint-fired');
    expect(cState).toBe('breakpoint-scheduled');
    const set = new Set([aState, bState, cState]);
    expect(set.size).toBe(3);
  });
});
