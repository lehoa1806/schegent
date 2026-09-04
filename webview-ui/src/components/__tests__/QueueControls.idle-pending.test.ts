// Feature 065 (T028c, BUG-007 / 2026-05-23) — QueueControls MUST suppress
// its `action === 'start'` branch when `queueLifecycle === 'idle-pending'`
// so the FR-018 chooser surface, now `QueueIdlePendingPanel.svelte`, remains
// the sole dispatcher of `CMD_START_QUEUE` against an idle-pending queue.
//
// Why this test exists: prior to BUG-007 the tri-state derivation read
// only (paused, hasInFlight, pendingCount). A queue in `idle-pending` with
// `pendingCount > 0` resolved to `action === 'start'`, which dispatched a
// bare `CMD_START_QUEUE` (no `startIntent`) that the host correctly no-ops
// per `contracts/sidebar-ipc.diff.md` line 119. The result was a silently
// stuck queue. This test pins the suppression at the per-component layer;
// `QueueListView.running-enqueue.test.ts` covers the cross-surface
// composition invariant (operator sees exactly one Start affordance).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import QueueControls from '../QueueControls.svelte';
import { snapshotStore } from '../../lib/snapshot-store.svelte';
import { CMD_ACK, CMD_START_QUEUE } from '../../lib/messages';
import type { QueueItem, QueueLifecycle } from '../../lib/snapshot-types';

// FR-R3-154 (T1646) — the stub returns a `correlationId` because the real
// `postCommand` does, and the Start/Pause/Resume action now awaits its ACK
// instead of dropping it. A bare `vi.fn()` returns `undefined`, and reading
// `.correlationId` off that throws inside the click handler: an unhandled
// rejection that exits `vitest run` 1 while every assertion below still
// passes, since they all assert the post that already happened.
let nextCorrelationId = 0;
const postCommandSpy = vi.fn((..._args: readonly unknown[]) => ({
  correlationId: `corr-${++nextCorrelationId}`
}));
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args)
}));

/** Answer the post at `callIndex` through the real store, as the host would. */
function ack(
  callIndex: number,
  status: 'accepted' | 'rejected',
  reason?: string,
  outcome?: 'accepted' | 'no-op' | 'refused' | 'failed'
): void {
  const result = postCommandSpy.mock.results[callIndex];
  expect(result, `no post at index ${callIndex}`).toBeDefined();
  const { correlationId } = result!.value as { correlationId: string };
  snapshotStore.apply({
    type: CMD_ACK,
    correlationId,
    status,
    ...(reason !== undefined ? { reason } : {}),
    ...(outcome !== undefined ? { outcome } : {})
  } as never);
}

beforeEach(() => {
  postCommandSpy.mockReset();
});

afterEach(() => cleanup());

const QUEUE_ID = 'q-beta';

function defaultProps(overrides: Partial<{
  isPrimary: boolean;
  queueId: string;
  paused: boolean;
  pendingCount: number;
  hasInFlight: boolean;
  clearDoneDisabled: boolean;
  cleanDisabled: boolean;
  queueLifecycle: QueueLifecycle | null;
  haltedTask: QueueItem | null;
}> = {}) {
  return {
    isPrimary: true,
    queueId: QUEUE_ID,
    paused: false,
    pendingCount: 0,
    hasInFlight: false,
    clearDoneDisabled: true,
    cleanDisabled: true,
    queueLifecycle: null as QueueLifecycle | null,
    haltedTask: null as QueueItem | null,
    onResume: vi.fn(),
    onPause: vi.fn(),
    onClearDone: vi.fn(),
    onClean: vi.fn(),
    ...overrides
  };
}

describe('QueueControls — idle-pending suppression (BUG-007 / FR-018)', () => {
  it('hides Start Queue when queueLifecycle === "idle-pending" even with pending tasks', () => {
    const { queryByTestId } = render(QueueControls, {
      props: defaultProps({
        pendingCount: 3,
        hasInFlight: false,
        paused: false,
        queueLifecycle: 'idle-pending'
      })
    });
    expect(queryByTestId('dashboard-queue-action')).toBeNull();
  });

  it('shows Start Queue when queueLifecycle === "active-empty" with pending tasks', () => {
    const { queryByTestId } = render(QueueControls, {
      props: defaultProps({
        pendingCount: 3,
        hasInFlight: false,
        paused: false,
        queueLifecycle: 'active-empty'
      })
    });
    const btn = queryByTestId('dashboard-queue-action');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Start Queue');
  });

  it('shows Start Queue when queueLifecycle === "running" with pending tasks (host appends silently)', () => {
    // 'running' with pending tasks is unusual but legal — the tri-state
    // derivation falls back to 'idle' only via the !hasInFlight branch.
    // The lifecycle gate is `!== 'idle-pending'`, so 'running' is allowed.
    const { queryByTestId } = render(QueueControls, {
      props: defaultProps({
        pendingCount: 3,
        hasInFlight: false,
        paused: false,
        queueLifecycle: 'running'
      })
    });
    const btn = queryByTestId('dashboard-queue-action');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Start Queue');
  });

  it('shows Start Queue when queueLifecycle is null (backward-compat for pre-065 callers)', () => {
    // Callers that haven't been threaded with queueLifecycle pass null;
    // the gate is `!== 'idle-pending'`, so null permits the start branch.
    const { queryByTestId } = render(QueueControls, {
      props: defaultProps({
        pendingCount: 3,
        hasInFlight: false,
        paused: false,
        queueLifecycle: null
      })
    });
    const btn = queryByTestId('dashboard-queue-action');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Start Queue');
  });

  it('still shows Pause when in-flight with queueLifecycle === "idle-pending" (suppression scoped to Start)', () => {
    // Defense-in-depth: even if a snapshot somehow reports both an
    // in-flight task and `idle-pending` (it should not — `running` is the
    // expected lifecycle), the suppression MUST be narrow: it only blocks
    // the 'start' branch, not 'pause' or 'resume'.
    const { queryByTestId } = render(QueueControls, {
      props: defaultProps({
        pendingCount: 3,
        hasInFlight: true,
        paused: false,
        queueLifecycle: 'idle-pending'
      })
    });
    const btn = queryByTestId('dashboard-queue-action');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Pause');
  });

  it('still shows Resume when paused with queueLifecycle === "idle-pending"', () => {
    const { queryByTestId } = render(QueueControls, {
      props: defaultProps({
        pendingCount: 3,
        hasInFlight: false,
        paused: true,
        queueLifecycle: 'idle-pending'
      })
    });
    const btn = queryByTestId('dashboard-queue-action');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Resume');
  });

  it('does NOT dispatch CMD_START_QUEUE via this component when queueLifecycle === "idle-pending"', async () => {
    // The button is not rendered at all (covered above); this guard
    // verifies that even a synthetic click on a non-existent affordance
    // cannot trigger postCommand. If the button is absent, no post path
    // exists from this component.
    const { queryByTestId } = render(QueueControls, {
      props: defaultProps({
        pendingCount: 5,
        hasInFlight: false,
        paused: false,
        queueLifecycle: 'idle-pending'
      })
    });
    const btn = queryByTestId('dashboard-queue-action');
    expect(btn).toBeNull();
    expect(postCommandSpy).not.toHaveBeenCalled();
  });

  it('regression: dispatches CMD_START_QUEUE on click when queueLifecycle !== "idle-pending"', async () => {
    const { getByTestId } = render(QueueControls, {
      props: defaultProps({
        pendingCount: 2,
        hasInFlight: false,
        paused: false,
        queueLifecycle: 'active-empty'
      })
    });
    await fireEvent.click(getByTestId('dashboard-queue-action'));
    expect(postCommandSpy).toHaveBeenCalledTimes(1);
  });

  // Bug "there is no way to start a pending task": a bare CMD_START_QUEUE is
  // read by the host as the default queue, so this button started a queue the
  // operator was not looking at.
  it('names the queue it controls in the CMD_START_QUEUE payload', async () => {
    const { getByTestId } = render(QueueControls, {
      props: defaultProps({
        pendingCount: 2,
        hasInFlight: false,
        paused: false,
        queueLifecycle: 'active-empty'
      })
    });

    await fireEvent.click(getByTestId('dashboard-queue-action'));

    expect(postCommandSpy).toHaveBeenCalledWith(CMD_START_QUEUE, { queueId: QUEUE_ID });
  });

  // FR-R3-154 (T1646) — the dashboard's Start/Pause/Resume button reports what
  // the host answered. This is the surface where the false acceptance was
  // cheapest to hit: `start-queue.ts`'s bare-drain path can no-op, and the
  // button's own label flips on the projection rather than on the post, so a
  // refused Start left a button that said "Pause" over a queue that never
  // started.
  it('renders a no-op start as a sentence rather than reporting success', async () => {
    const { getByTestId, queryByTestId } = render(QueueControls, {
      props: defaultProps({
        pendingCount: 2,
        hasInFlight: false,
        paused: false,
        queueLifecycle: 'active-empty'
      })
    });

    await fireEvent.click(getByTestId('dashboard-queue-action'));
    expect(queryByTestId('dashboard-queue-start-message')).toBeNull();

    // `no-op`, not `refused`: nothing was rejected, the queue was already in
    // the requested state. The distinction is the host's and this layer keeps
    // it — see `lifecycle-control-ipc.ts`.
    ack(0, 'rejected', 'start-intent-no-change', 'no-op');

    await waitFor(() => {
      expect(getByTestId('dashboard-queue-start-message').textContent).toBe(
        'The queue was already set that way, so nothing changed.'
      );
    });
  });

  it('says nothing when the host accepts the start', async () => {
    const { getByTestId, queryByTestId } = render(QueueControls, {
      props: defaultProps({
        pendingCount: 2,
        hasInFlight: false,
        paused: false,
        queueLifecycle: 'active-empty'
      })
    });

    await fireEvent.click(getByTestId('dashboard-queue-action'));
    ack(0, 'accepted', undefined, 'accepted');

    await waitFor(() => expect(postCommandSpy).toHaveBeenCalledTimes(1));
    // The queue starting is the report. A confirmation sentence on every
    // accepted click is noise the operator learns to look past.
    expect(queryByTestId('dashboard-queue-start-message')).toBeNull();
  });
});
