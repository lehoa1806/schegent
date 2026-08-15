import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import PhaseProgression from '../PhaseProgression.svelte';
import type { PhaseTile, ActivePipelineSummary } from '../../lib/snapshot-types';

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

function buildPhases(): readonly PhaseTile[] {
  return Object.freeze([
    buildPhase('speckit-specify', 1, 'not-started'),
    buildPhase('speckit-clarify', 2, 'not-started'),
    buildPhase('speckit-plan', 3, 'not-started'),
    buildPhase('speckit-tasks', 4, 'not-started'),
    buildPhase('speckit-analyze', 5, 'not-started'),
    buildPhase('speckit-implement', 6, 'not-started'),
    buildPhase('finalize', 7, 'not-started')
  ]);
}

describe('PhaseProgression — header (016)', () => {
  it('I-4.1 header contains "(Active: <id>)" when activeTaskId is set', () => {
    const { getByTestId } = render(PhaseProgression, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID, phases: buildPhases(), activeTaskId: 'req-abc' }
    });
    const header = getByTestId('dashboard-phase-progression-header');
    expect(header.textContent ?? '').toContain('(Active: req-abc)');
  });

  it('I-4.1 header re-renders when activeTaskId transitions to a new id', async () => {
    const { getByTestId, rerender } = render(PhaseProgression, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID, phases: buildPhases(), activeTaskId: 'req-1' }
    });
    expect(getByTestId('dashboard-phase-progression-header').textContent ?? '').toContain('(Active: req-1)');
    await rerender({ targetsSubjectRun: true, queueId: TEST_QUEUE_ID, phases: buildPhases(), activeTaskId: 'req-2' });
    expect(getByTestId('dashboard-phase-progression-header').textContent ?? '').toContain('(Active: req-2)');
  });

  it('header appends " — Pipeline: <name>" when a non-standard pipeline is active', () => {
    const pipeline: ActivePipelineSummary = Object.freeze({
      id: 'custom',
      name: 'Custom Pipeline'
    });
    const { getByTestId } = render(PhaseProgression, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        phases: buildPhases(),
        activeTaskId: 'req-X',
        activePipeline: pipeline
      }
    });
    const text = (getByTestId('dashboard-phase-progression-header').textContent ?? '').trim();
    expect(text).toBe('Phase Progression (Active: req-X) — Pipeline: Custom Pipeline');
  });
});

describe('PhaseProgression — phase controls (017)', () => {
  it('renders phase controls for the active phase', () => {
    const phases = Object.freeze([
      buildPhase('speckit-specify', 1, 'completed'),
      buildPhase('speckit-plan', 2, 'active')
    ]);
    const { getByTestId } = render(PhaseProgression, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID, phases, activeTaskId: 'req-1', isPrimary: true }
    });

    expect(getByTestId('phase-control-menu')).not.toBeNull();
    expect(getByTestId('phase-control-pause').getAttribute('aria-disabled')).toBe('false');
  });

  it('renders phase-message metadata without values', () => {
    const phases = Object.freeze([
      {
        ...buildPhase('speckit-plan', 1, 'completed'),
        phaseMessage: {
          fromPhaseId: 'speckit-plan',
          entryCount: 2,
          byteSize: 32,
          truncated: false,
          invalidReason: null
        }
      }
    ]);
    const { getByTestId, queryByText } = render(PhaseProgression, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID, phases, activeTaskId: 'req-1', isPrimary: true }
    });

    expect(getByTestId('phase-message-meta-speckit-plan').textContent).toContain('message 2 entries');
    expect(queryByText(/secret-value/)).toBeNull();
  });

  it('renders a manual pause badge and enables Resume when paused', () => {
    const phases = Object.freeze([buildPhase('speckit-plan', 1, 'active')]);
    const { getByTestId, queryByTestId } = render(PhaseProgression, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        phases,
        activeTaskId: 'req-1',
        isPrimary: true,
        manualPauseAt: '2026-05-13T00:00:00.000Z',
        manualPauseCause: 'operator-paused'
      }
    });

    expect(getByTestId('phase-manual-pause-badge').textContent).toContain('Phase paused');
    // When paused, the contextual toggle shows Resume (Pause is hidden)
    expect(queryByTestId('phase-control-pause')).toBeNull();
    expect(getByTestId('phase-control-resume').getAttribute('aria-disabled')).toBe('false');
  });
});

describe('PhaseProgression — Activity Feed selection (021)', () => {
  it('calls onSelectPhase when a phase step is activated', async () => {
    const onSelectPhase = vi.fn();
    const phases = Object.freeze([
      buildPhase('speckit-specify', 1, 'completed'),
      buildPhase('speckit-plan', 2, 'active')
    ]);
    const { getByTestId } = render(PhaseProgression, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID, phases, selectedPhaseId: 'speckit-plan', onSelectPhase }
    });

    const specify = getByTestId('phase-progression-speckit-specify');
    await fireEvent.click(specify);

    expect(onSelectPhase).toHaveBeenCalledWith('speckit-specify');
    expect(getByTestId('phase-progression-speckit-plan').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('PhaseProgression — empty state (016 US4)', () => {
  it('I-4.2 header does NOT contain "(Active:" when activeTaskId is null', () => {
    const { getByTestId } = render(PhaseProgression, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID, phases: buildPhases(), activeTaskId: null }
    });
    const text = getByTestId('dashboard-phase-progression-header').textContent ?? '';
    expect(text).not.toContain('(Active:');
    expect(text.trim()).toBe('Phase Progression');
  });

  it('I-4.3 no tile carries state-active class or aria-current when every phase is not-started', () => {
    const { getByTestId, container } = render(PhaseProgression, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID, phases: buildPhases(), activeTaskId: null }
    });
    const list = getByTestId('phase-progression-list');
    expect(list).not.toBeNull();
    const activeTiles = container.querySelectorAll('[class*="state-active"]');
    expect(activeTiles.length).toBe(0);
    const ariaCurrentEls = container.querySelectorAll('[aria-current="step"]');
    expect(ariaCurrentEls.length).toBe(0);
  });

  it('omits the pipeline suffix when activePipeline.id === "standard"', () => {
    const pipeline: ActivePipelineSummary = Object.freeze({
      id: 'standard',
      name: 'Standard'
    });
    const { getByTestId } = render(PhaseProgression, {
      props: { targetsSubjectRun: true, queueId: TEST_QUEUE_ID,
        phases: buildPhases(),
        activeTaskId: null,
        activePipeline: pipeline
      }
    });
    const text = (getByTestId('dashboard-phase-progression-header').textContent ?? '').trim();
    expect(text).toBe('Phase Progression');
  });
});
