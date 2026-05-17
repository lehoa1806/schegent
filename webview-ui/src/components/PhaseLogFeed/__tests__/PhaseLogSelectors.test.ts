// Feature 020 T019 → Feature 021 — PhaseLogSelectors breadcrumb + jump button.
//
// After the dropdown removal, this test suite validates:
// - Breadcrumb trail reflects selection state (queue → task → phase).
// - "No selection" label when nothing is selected.
// - Jump-to-current button enabled/disabled states.
// - Jump-to-current click delegation.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import PhaseLogSelectors from '../PhaseLogSelectors.svelte';
import type {
  HistoryEntry,
  QueueItem,
  QueueProjection
} from '../../../lib/snapshot-types';

afterEach(() => cleanup());

function item(over: Partial<QueueItem> & Pick<QueueItem, 'id' | 'label' | 'startedAt'>): QueueItem {
  return {
    enqueuedAt: '2026-05-14T10:00:00.000Z',
    updatedAt: over.startedAt ?? '2026-05-14T10:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0,
    ...over
  } as QueueItem;
}

function makeQueue(over: Partial<QueueProjection> = {}): QueueProjection {
  return {
    inFlight: null,
    pending: [],
    recent: [],
    queues: [
      { id: 'default', name: 'Default', position: 0, state: 'active', pauseSource: null, schedule: null, taskCount: 0 }
    ],
    paused: false,
    ...over
  };
}

describe('Feature 021 — PhaseLogSelectors breadcrumb trail', () => {
  it('shows "No selection" when queueId is null', () => {
    const { getByTestId } = render(PhaseLogSelectors, {
      props: {
        snapshot: { queue: makeQueue(), history: [] },
        selection: {
          queueId: null,
          taskId: null,
          pipelineId: null,
          phaseId: null,
          iterationN: null
        },
        iterations: [],
        onSelectQueue: vi.fn(),
        onSelectTask: vi.fn(),
        onSelectPhase: vi.fn(),
        onJumpToCurrent: vi.fn()
      }
    });
    const breadcrumb = getByTestId('phase-log-breadcrumb');
    expect(breadcrumb.textContent).toContain('No selection');
  });

  it('shows queue name when queueId is set', () => {
    const { getByTestId } = render(PhaseLogSelectors, {
      props: {
        snapshot: { queue: makeQueue(), history: [] },
        selection: {
          queueId: 'default',
          taskId: null,
          pipelineId: null,
          phaseId: null,
          iterationN: null
        },
        iterations: [],
        onSelectQueue: vi.fn(),
        onSelectTask: vi.fn(),
        onSelectPhase: vi.fn(),
        onJumpToCurrent: vi.fn()
      }
    });
    const breadcrumb = getByTestId('phase-log-breadcrumb');
    expect(breadcrumb.textContent).toContain('Default');
  });

  it('shows queue → task breadcrumb when both are selected', () => {
    const inFlight = item({
      id: 'run-1',
      label: 'Build login page',
      startedAt: '2026-05-14T12:00:00.000Z',
      queueId: 'default',
      status: 'in-flight'
    });
    const { getByTestId } = render(PhaseLogSelectors, {
      props: {
        snapshot: { queue: makeQueue({ inFlight }), history: [] },
        selection: {
          queueId: 'default',
          taskId: 'run-1',
          pipelineId: 'standard',
          phaseId: null,
          iterationN: null
        },
        iterations: [],
        onSelectQueue: vi.fn(),
        onSelectTask: vi.fn(),
        onSelectPhase: vi.fn(),
        onJumpToCurrent: vi.fn()
      }
    });
    const breadcrumb = getByTestId('phase-log-breadcrumb');
    expect(breadcrumb.textContent).toContain('Default');
    expect(breadcrumb.textContent).toContain('Build login page');
  });
});

// Feature 020 T054 — Jump-to-current-phase affordance contract (US3).
describe('Feature 020 T054 — Jump-to-current-phase button (US3)', () => {
  it('is disabled with tooltip when there is no in-flight task', () => {
    const { getByTestId } = render(PhaseLogSelectors, {
      props: {
        snapshot: { queue: makeQueue({ inFlight: null }), history: [] },
        selection: {
          queueId: null,
          taskId: null,
          pipelineId: null,
          phaseId: null,
          iterationN: null
        },
        iterations: [],
        onSelectQueue: vi.fn(),
        onSelectTask: vi.fn(),
        onSelectPhase: vi.fn(),
        onJumpToCurrent: vi.fn()
      }
    });
    const button = getByTestId('phase-log-jump-current') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe('No in-flight phase');
  });

  it('is enabled when a task is in-flight', () => {
    const inFlight = item({
      id: 'run-1',
      label: 'live one',
      startedAt: '2026-05-14T12:00:00.000Z',
      queueId: 'default',
      status: 'in-flight',
      currentPhase: 'speckit-plan',
      currentPipelineId: 'standard'
    });
    const { getByTestId } = render(PhaseLogSelectors, {
      props: {
        snapshot: { queue: makeQueue({ inFlight }), history: [] },
        selection: {
          queueId: null,
          taskId: null,
          pipelineId: null,
          phaseId: null,
          iterationN: null
        },
        iterations: [],
        onSelectQueue: vi.fn(),
        onSelectTask: vi.fn(),
        onSelectPhase: vi.fn(),
        onJumpToCurrent: vi.fn()
      }
    });
    const button = getByTestId('phase-log-jump-current') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe('Jump to the currently executing phase');
  });

  it('invokes onJumpToCurrent when clicked while enabled', async () => {
    const inFlight = item({
      id: 'run-1',
      label: 'live one',
      startedAt: '2026-05-14T12:00:00.000Z',
      queueId: 'default',
      status: 'in-flight',
      currentPhase: 'speckit-plan',
      currentPipelineId: 'standard'
    });
    const onJumpToCurrent = vi.fn();
    const { getByTestId } = render(PhaseLogSelectors, {
      props: {
        snapshot: { queue: makeQueue({ inFlight }), history: [] },
        selection: {
          queueId: null,
          taskId: null,
          pipelineId: null,
          phaseId: null,
          iterationN: null
        },
        iterations: [],
        onSelectQueue: vi.fn(),
        onSelectTask: vi.fn(),
        onSelectPhase: vi.fn(),
        onJumpToCurrent
      }
    });
    await fireEvent.click(getByTestId('phase-log-jump-current'));
    expect(onJumpToCurrent).toHaveBeenCalledTimes(1);
  });

  it('does NOT invoke onJumpToCurrent when clicked while disabled', async () => {
    const onJumpToCurrent = vi.fn();
    const { getByTestId } = render(PhaseLogSelectors, {
      props: {
        snapshot: { queue: makeQueue({ inFlight: null }), history: [] },
        selection: {
          queueId: null,
          taskId: null,
          pipelineId: null,
          phaseId: null,
          iterationN: null
        },
        iterations: [],
        onSelectQueue: vi.fn(),
        onSelectTask: vi.fn(),
        onSelectPhase: vi.fn(),
        onJumpToCurrent
      }
    });
    await fireEvent.click(getByTestId('phase-log-jump-current'));
    expect(onJumpToCurrent).not.toHaveBeenCalled();
  });
});
