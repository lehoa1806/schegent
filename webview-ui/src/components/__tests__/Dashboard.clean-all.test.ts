// Feature 063 — T025 Dashboard "Clean All" wiring test, revised by T051
// (US3). T025's pre-T028 shim mocked `window.confirm`; now that the
// in-webview `ConfirmDialog` + `useConfirm` flow has landed (T027/T028),
// this test mocks `useConfirm` to capture the gating decision and the
// `context` payload that drives the dialog body's substitutions.
//
// What this test pins:
//
//   (a) the button is rendered with label "Clean All";
//   (b) the button is DISABLED when all five reset surfaces are empty
//       (idle gate, FR-008);
//   (c) clicking the button posts exactly `CMD_CLEAR_ALL` when the
//       operator confirms;
//   (d) confirming posts ZERO `CMD_CLEAR_COMPLETED`/`CMD_CLEAR_FAILED`
//       calls (the legacy compound IPC pair is fully retired by Clean All);
//   (e) canceling posts nothing;
//   (f) T051: `useConfirm('queue.clean-all', ...)` receives a context that
//       matches the snapshot, and the rendered body string contains every
//       substituted value (in-flight title, pause source, active-run
//       summary, and the four counts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import Dashboard from '../Dashboard.svelte';
import {
  CMD_CLEAR_ALL,
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_FAILED
} from '../../lib/messages';
import type {
  HistoryEntry,
  PhaseTile,
  PipelineDefinition,
  QueueItem,
  QueueProjection,
  WorkflowSnapshot
} from '../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../lib/snapshot-types';
import { renderActionBody, type ActionKey, type ActionCopyContext } from '../../lib/action-copy';

let nextCorrelationId = 0;
const postCommandSpy = vi.fn(
  (..._args: readonly unknown[]) => ({ correlationId: `corr-${++nextCorrelationId}` })
);
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args)
}));

// `useConfirm` is mocked so the test controls the confirm/cancel outcome
// and inspects the (actionKey, options) tuple the Dashboard handler
// passed. The default resolves(false) — call sites that need confirmation
// override per-test.
const useConfirmSpy = vi.fn<
  (actionKey: ActionKey, options: { context: unknown }) => Promise<boolean>
>(async () => false);
vi.mock('../../lib/use-confirm', () => ({
  useConfirm: (...args: unknown[]) =>
    useConfirmSpy(args[0] as ActionKey, args[1] as { context: unknown })
}));

function buildQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'q-item',
    label: '',
    status: 'pending',
    position: 0,
    enqueuedAt: '2026-05-10T10:00:00.000Z',
    updatedAt: '2026-05-10T10:00:00.000Z',
    startedAt: null,
    completedAt: null,
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    ...overrides
  } as QueueItem;
}

function buildQueue(
  overrides: Partial<QueueProjection> & { inFlight?: QueueItem | null } = {}
): QueueProjection {
  const inFlight = overrides.inFlight ?? null;
  const pending = (overrides.pending ?? []) as readonly QueueItem[];
  const recent = (overrides.recent ?? []) as readonly QueueItem[];
  const queues =
    (overrides as { queues?: QueueProjection['queues'] }).queues ?? [];
  return {
    inFlight,
    pending,
    recent,
    paused: overrides.paused ?? false,
    pausedReason: overrides.pausedReason ?? null,
    queues
  } as unknown as QueueProjection;
}

function buildSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  const queue = overrides.queue ?? buildQueue();
  return {
    status: overrides.status ?? 'idle',
    isPrimary: true,
    queue,
    phases: (overrides.phases ?? []) as readonly PhaseTile[],
    monitor: null,
    activeRunId: overrides.activeRunId ?? null,
    activeFeature: overrides.activeFeature ?? null,
    activePipeline: null,
    availablePhases: [],
    availablePipelines: (overrides.availablePipelines ?? []) as readonly PipelineDefinition[],
    history: (overrides.history ?? []) as readonly HistoryEntry[],
    manualPauseAt: null,
    manualPauseCause: null,
    phaseOverrides: [],
    generalSettings: IDLE_GENERAL_SETTINGS,
    ...overrides
  } as unknown as WorkflowSnapshot;
}

beforeEach(() => {
  postCommandSpy.mockClear();
  useConfirmSpy.mockClear();
  useConfirmSpy.mockImplementation(async () => false);
  nextCorrelationId = 0;
});

afterEach(() => {
  cleanup();
});

describe('Dashboard Clean All wiring (T025, revised by T051)', () => {
  it('(a) renders the button labeled "Clean All"', () => {
    const snap = buildSnapshot({
      queue: buildQueue({
        recent: Object.freeze([buildQueueItem({ id: 'q-f', status: 'failed' })])
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const btn = getByTestId('dashboard-queue-clean');
    expect(btn.textContent?.trim()).toBe('Clean All');
  });

  it('(b) is DISABLED when all five reset surfaces are empty (idle gate, FR-008)', () => {
    const snap = buildSnapshot({
      queue: buildQueue({
        pending: Object.freeze([]),
        recent: Object.freeze([])
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const btn = getByTestId('dashboard-queue-clean') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('(b) is enabled when there is a pending task', () => {
    const snap = buildSnapshot({
      queue: buildQueue({
        pending: Object.freeze([buildQueueItem({ id: 'q-p', status: 'pending' })])
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const btn = getByTestId('dashboard-queue-clean') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('(b) is enabled when there is an in-flight task', () => {
    const snap = buildSnapshot({
      queue: buildQueue({
        inFlight: buildQueueItem({ id: 'q-i', status: 'in-flight' })
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const btn = getByTestId('dashboard-queue-clean') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('(b) is enabled when the queue is paused (even with empty queue)', () => {
    const snap = buildSnapshot({
      queue: buildQueue({ paused: true, pausedReason: 'maintenance' })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const btn = getByTestId('dashboard-queue-clean') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('(b) is enabled when there is an active run (even with empty queue)', () => {
    const snap = buildSnapshot({
      queue: buildQueue(),
      activeRunId: 'run-active'
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    const btn = getByTestId('dashboard-queue-clean') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('(c)/(d) confirming posts CMD_CLEAR_ALL exactly once and never the legacy pair', async () => {
    useConfirmSpy.mockResolvedValue(true);
    const snap = buildSnapshot({
      queue: buildQueue({
        pending: Object.freeze([buildQueueItem({ id: 'q-p', status: 'pending' })]),
        recent: Object.freeze([
          buildQueueItem({ id: 'q-c', status: 'completed' }),
          buildQueueItem({ id: 'q-f', status: 'failed' })
        ])
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });

    await fireEvent.click(getByTestId('dashboard-queue-clean'));

    const calls = postCommandSpy.mock.calls.map((c) => c[0]);
    expect(calls.filter((t) => t === CMD_CLEAR_ALL)).toHaveLength(1);
    expect(calls).not.toContain(CMD_CLEAR_COMPLETED);
    expect(calls).not.toContain(CMD_CLEAR_FAILED);
  });

  it('(e) canceling posts nothing', async () => {
    useConfirmSpy.mockResolvedValue(false);
    const snap = buildSnapshot({
      queue: buildQueue({
        pending: Object.freeze([buildQueueItem({ id: 'q-p', status: 'pending' })])
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    await fireEvent.click(getByTestId('dashboard-queue-clean'));
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('(f) [T051] the confirm context drives every body-template substitution', async () => {
    useConfirmSpy.mockResolvedValue(true);
    const snap = buildSnapshot({
      queue: buildQueue({
        inFlight: buildQueueItem({
          id: 'q-i',
          status: 'in-flight',
          label: 'Run feature 063 specify'
        }),
        pending: Object.freeze([
          buildQueueItem({ id: 'q-p1', status: 'pending', position: 1 }),
          buildQueueItem({ id: 'q-p2', status: 'pending', position: 2 }),
          buildQueueItem({ id: 'q-p3', status: 'pending', position: 3 })
        ]),
        recent: Object.freeze([
          buildQueueItem({ id: 'q-c1', status: 'completed' }),
          buildQueueItem({ id: 'q-c2', status: 'completed' }),
          buildQueueItem({ id: 'q-f1', status: 'failed' }),
          buildQueueItem({ id: 'q-x1', status: 'canceled' })
        ]),
        queues: [
          {
            id: 'default',
            name: 'Default queue',
            position: 0,
            state: 'manually-paused',
            pauseSource: 'cascade',
            schedule: null,
            taskCount: 4
          }
        ],
        paused: true
      }),
      activeRunId: 'run-abc'
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    await fireEvent.click(getByTestId('dashboard-queue-clean'));

    expect(useConfirmSpy).toHaveBeenCalledTimes(1);
    const [actionKey, options] = useConfirmSpy.mock.calls[0];
    expect(actionKey).toBe('queue.clean-all');

    const context = (options as { context: ActionCopyContext['queue.clean-all'] }).context;
    expect(context).toEqual({
      pendingCount: 3,
      completedCount: 2,
      failedCount: 1,
      canceledCount: 1,
      inflightTitle: 'Run feature 063 specify',
      pauseSource: 'cascade',
      hasActiveRun: true
    });

    // The body string that `renderActionBody` would substitute is the
    // exact string the dialog renders inside `<p data-testid="confirm-dialog-body">`.
    // Asserting each substitution here catches both context-shape drift
    // AND template-string regressions in one shot.
    const body = renderActionBody('queue.clean-all', context);
    expect(body).toContain('**3** pending');
    expect(body).toContain('**2** completed');
    expect(body).toContain('**1** failed');
    expect(body).toContain('**1** canceled');
    expect(body).toContain('abort the running task ("Run feature 063 specify")');
    expect(body).toContain('clear the cascade pause');
    expect(body).toContain('clear the active workflow run');
  });

  it('(f) [T051] empty/idle non-zero-only snapshot omits the conditional summaries', async () => {
    useConfirmSpy.mockResolvedValue(true);
    // 1 pending, no in-flight, no pause, no active run — the optional
    // summaries should collapse to empty strings.
    const snap = buildSnapshot({
      queue: buildQueue({
        pending: Object.freeze([buildQueueItem({ id: 'q-p', status: 'pending' })])
      })
    });
    const { getByTestId } = render(Dashboard, { props: { snapshot: snap } });
    await fireEvent.click(getByTestId('dashboard-queue-clean'));

    expect(useConfirmSpy).toHaveBeenCalledTimes(1);
    const [, options] = useConfirmSpy.mock.calls[0];
    const context = (options as { context: ActionCopyContext['queue.clean-all'] }).context;
    const body = renderActionBody('queue.clean-all', context);
    expect(body).toContain('**1** pending');
    expect(body).not.toContain('abort the running task');
    expect(body).not.toContain('pause');
    expect(body).not.toContain('active workflow run');
  });
});
