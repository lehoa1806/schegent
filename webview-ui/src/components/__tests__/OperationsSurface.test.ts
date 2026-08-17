// Feature 092 (T102, T103, T104, T105, FR-059, FR-060, FR-062, FR-065, SC-007,
// US5 scenarios 1, 4, 5, 6) — the surface that owns the drill-down location.
//
// `App.svelte` still routes to one `operations` component; which tier that
// component shows is a `DashboardLocation`, held here. These tests are about the
// *navigation*, not the tiers: each tier has its own suite, and what this one
// asserts is that moving between them is a navigation step with a remembered
// position, that a destination which no longer resolves lands somewhere with an
// explanation, and that a non-primary window can travel but not mutate.

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import OperationsSurface from '../OperationsSurface.svelte';
import { buildQueueRuntime } from '../../lib/__tests__/queue-runtime-fixture';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import type {
  QueueItem,
  QueueRuntime,
  QueueSummary,
  WorkflowSnapshot
} from '../../lib/snapshot-types';

const postCommandSpy = vi.fn((..._args: readonly unknown[]) => ({ correlationId: 'corr-1' }));
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args),
  onHostMessage: () => () => {},
  getWebviewState: () => undefined,
  setWebviewState: () => {}
}));

vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

function task(id: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    label: `task ${id}`,
    enqueuedAt: '2026-08-12T00:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-08-12T00:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0,
    ...overrides
  };
}

const QUEUES: readonly QueueRuntime[] = Object.freeze([
  buildQueueRuntime({
    queueId: 'default',
    name: 'Default',
    position: 0,
    lifecycle: 'active-empty',
    tasks: [task('d-1')]
  }),
  buildQueueRuntime({
    queueId: 'q-beta',
    name: 'nightly',
    position: 1,
    lifecycle: 'running',
    tasks: [task('r-1', { label: 'generate the RFC' })]
  })
]);

function summary(runtime: QueueRuntime): QueueSummary {
  return {
    id: runtime.queueId,
    name: runtime.name,
    position: runtime.position,
    state: 'active',
    pauseSource: null,
    schedule: null,
    taskCount: runtime.tasks.length
  };
}

function buildSnapshot(queues: readonly QueueRuntime[] = QUEUES): WorkflowSnapshot {
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    queues,
    queue: Object.freeze({
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      orderedItems: Object.freeze([]),
      queues: Object.freeze(queues.map(summary)),
      paused: false
    }),
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-08-12T00:00:30.000Z',
    availablePipelines: Object.freeze([
      Object.freeze({ id: 'standard', name: 'Standard', phases: Object.freeze(['speckit-specify']) })
    ]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze({ claude: [], codex: [], agy: [] }),
    availableBackends: Object.freeze(['claude']),
    generalSettings: IDLE_GENERAL_SETTINGS
  }) as unknown as WorkflowSnapshot;
}

function mount(snapshot: WorkflowSnapshot = buildSnapshot()) {
  return render(OperationsSurface, { props: { snapshot } });
}

// Tier 2 and tier 3 are loaded on descent rather than at startup, so arriving at
// one is asynchronous and every assertion about a tier's *content* — including an
// assertion that some control is absent — has to wait for the tier itself.
// Asserting against the loading placeholder would pass vacuously.
const awaitTier = (view: ReturnType<typeof mount>, testId: string): Promise<HTMLElement> =>
  view.findByTestId(testId);

/** Tier 1 → tier 2 → tier 3, the path US5 scenario 1 walks. */
async function drillToRunDetail(view: ReturnType<typeof mount>): Promise<void> {
  await fireEvent.click(view.getByTestId('queue-card-q-beta'));
  await awaitTier(view, 'queue-detail-tier');
  await fireEvent.click(view.getByTestId('queue-task-row-r-1'));
  await awaitTier(view, 'run-detail-tier');
}

beforeAll(async () => {
  // Prime the module graph the two tiers pull in — tier 2's own row-list and
  // controls machinery, and the `WorkflowRun` topology view tier 3 mounts — so
  // the first descent in this file is not also paying Vite's one-off transform
  // cost. Without it the first
  // `findByTestId` races that cost against its own timeout under a loaded suite;
  // the tier still arrives through the `{#await}`, which is what is under test.
  await Promise.all([
    import('../drilldown/QueueDetailTier.svelte'),
    import('../drilldown/RunDetailTier.svelte')
  ]);
});

beforeEach(() => {
  postCommandSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('OperationsSurface — drilling in and back out (FR-060, SC-007)', () => {
  it('lands on the Queues tier', () => {
    const { getByTestId, queryByTestId } = mount();

    expect(getByTestId('queues-tier')).not.toBeNull();
    expect(queryByTestId('queue-detail-tier')).toBeNull();
    expect(queryByTestId('run-detail-tier')).toBeNull();
  });

  it('opens the Queue Detail tier for the queue that was selected', async () => {
    const view = mount();

    await fireEvent.click(view.getByTestId('queue-card-q-beta'));

    expect(await awaitTier(view, 'queue-detail-tier')).not.toBeNull();
    expect(view.getByTestId('queue-detail-title').textContent).toContain('nightly');
    // A navigation step replaces the tier; it is not a pane toggled open beside it.
    expect(view.queryByTestId('queues-tier')).toBeNull();
  });

  it('opens the Run Detail tier for the Run that was selected', async () => {
    const view = mount();

    await drillToRunDetail(view);

    expect(view.getByTestId('run-detail-tier')).not.toBeNull();
    expect(view.getByTestId('run-detail-prompt').textContent).toContain('generate the RFC');
    expect(view.queryByTestId('queue-detail-tier')).toBeNull();
  });

  it('walks back one tier at a time rather than jumping to the root', async () => {
    const view = mount();
    await drillToRunDetail(view);

    await fireEvent.click(view.getByTestId('run-detail-back'));
    expect(await awaitTier(view, 'queue-detail-tier')).not.toBeNull();
    expect(view.queryByTestId('queues-tier')).toBeNull();

    await fireEvent.click(view.getByTestId('queue-detail-back'));
    expect(view.getByTestId('queues-tier')).not.toBeNull();
  });

  it('restores the tier’s remembered scroll position on the way back (SC-007)', async () => {
    const view = mount();
    const scroller = view.getByTestId('operations-scroll');
    // jsdom reports 0 for every layout read, so the surface must record what it
    // is told rather than what it can measure; the assertion is that whatever it
    // recorded is written back.
    Object.defineProperty(scroller, 'scrollTop', { value: 240, writable: true });
    await fireEvent.scroll(scroller);

    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    (view.getByTestId('operations-scroll') as HTMLElement).scrollTop = 0;
    await fireEvent.click(view.getByTestId('queue-detail-back'));

    expect((view.getByTestId('operations-scroll') as HTMLElement).scrollTop).toBe(240);
  });

  it('restores the selection the operator left behind on the parent tier', async () => {
    const view = mount();

    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    await fireEvent.click(view.getByTestId('queue-detail-back'));

    expect(
      view.getByTestId('queue-card-q-beta').getAttribute('data-selected')
    ).toBe('true');
    expect(view.getByTestId('queue-card-default').getAttribute('data-selected')).toBe('false');
  });
});

describe('OperationsSurface — keyboard operability (FR-059)', () => {
  it('drills in from the keyboard alone', async () => {
    const view = mount();

    await fireEvent.keyDown(view.getByTestId('queue-card-q-beta'), { key: 'Enter' });
    expect(await awaitTier(view, 'queue-detail-tier')).not.toBeNull();

    await fireEvent.keyDown(view.getByTestId('queue-task-row-r-1'), { key: 'Enter' });
    expect(await awaitTier(view, 'run-detail-tier')).not.toBeNull();
  });

  it('walks back from the keyboard alone', async () => {
    const view = mount();
    await drillToRunDetail(view);

    await fireEvent.keyDown(view.getByTestId('run-detail-back'), { key: 'Enter' });
    expect(await awaitTier(view, 'queue-detail-tier')).not.toBeNull();
  });

  it('gives every navigation affordance a real button so focus and activation are native', async () => {
    const view = mount();

    expect(view.getByTestId('queue-card-q-beta').tagName).toBe('BUTTON');
    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    expect(view.getByTestId('queue-detail-back').tagName).toBe('BUTTON');
    expect(view.getByTestId('queue-task-row-r-1').tagName).toBe('BUTTON');
  });

  it('exposes exactly one main landmark at every tier', async () => {
    const view = mount();
    expect(view.container.querySelectorAll('main')).toHaveLength(1);

    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    expect(view.container.querySelectorAll('main')).toHaveLength(1);

    await fireEvent.click(view.getByTestId('queue-task-row-r-1'));
    await awaitTier(view, 'run-detail-tier');
    expect(view.container.querySelectorAll('main')).toHaveLength(1);
  });
});

describe('OperationsSurface — a destination that no longer resolves (FR-062)', () => {
  it('falls back to the Queues tier when the queue is deleted underneath it', async () => {
    const view = mount();
    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');

    await view.rerender({ snapshot: buildSnapshot([QUEUES[0]]) });

    expect(view.getByTestId('queues-tier')).not.toBeNull();
    expect(view.queryByTestId('queue-detail-tier')).toBeNull();
  });

  it('explains the fallback rather than silently relocating the operator', async () => {
    const view = mount();
    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');

    await view.rerender({ snapshot: buildSnapshot([QUEUES[0]]) });

    expect(view.getByTestId('operations-fallback-notice').textContent).toMatch(
      /no longer|not available/i
    );
  });

  it('falls back one tier — to Queue Detail — when only the Run is gone', async () => {
    const view = mount();
    await drillToRunDetail(view);

    await view.rerender({
      snapshot: buildSnapshot([
        QUEUES[0],
        buildQueueRuntime({
          queueId: 'q-beta',
          name: 'nightly',
          position: 1,
          lifecycle: 'active-empty',
          tasks: []
        })
      ])
    });

    expect(await awaitTier(view, 'queue-detail-tier')).not.toBeNull();
    expect(view.queryByTestId('run-detail-tier')).toBeNull();
    expect(view.getByTestId('operations-fallback-notice')).not.toBeNull();
  });

  it('clears the explanation once the operator navigates again', async () => {
    const view = mount();
    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    await view.rerender({ snapshot: buildSnapshot([QUEUES[0]]) });
    expect(view.getByTestId('operations-fallback-notice')).not.toBeNull();

    await fireEvent.click(view.getByTestId('queue-card-default'));
    await awaitTier(view, 'queue-detail-tier');

    expect(view.queryByTestId('operations-fallback-notice')).toBeNull();
  });
});

describe('OperationsSurface — a non-primary window (FR-065)', () => {
  function readOnly(): WorkflowSnapshot {
    return { ...buildSnapshot(), isPrimary: false } as WorkflowSnapshot;
  }

  it('still lets the operator travel every tier', async () => {
    const view = mount(readOnly());

    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    expect(await awaitTier(view, 'queue-detail-tier')).not.toBeNull();

    await fireEvent.click(view.getByTestId('queue-task-row-r-1'));
    await awaitTier(view, 'run-detail-tier');
    expect(view.getByTestId('run-detail-prompt')).not.toBeNull();
  });

  it('offers no mutating control on any tier', async () => {
    const view = mount(readOnly());
    expect(view.queryByTestId('queue-create')).toBeNull();

    await fireEvent.click(view.getByTestId('queue-card-q-beta'));
    await awaitTier(view, 'queue-detail-tier');
    expect(view.queryByTestId('queue-config-open')).toBeNull();

    await fireEvent.click(view.getByTestId('queue-task-row-r-1'));
    await awaitTier(view, 'run-detail-tier');
    expect(view.queryByTestId('run-detail-controls')).toBeNull();
  });

  it('posts no command while travelling', async () => {
    const view = mount(readOnly());

    await drillToRunDetail(view);
    await fireEvent.click(view.getByTestId('run-detail-back'));
    await awaitTier(view, 'queue-detail-tier');

    expect(postCommandSpy).not.toHaveBeenCalled();
  });
});
