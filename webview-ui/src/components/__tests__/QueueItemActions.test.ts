import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import QueueItemActions from '../QueueItemActions.svelte';
import { disposeIntentLedger } from '../../lib/intent-ledger';
import type { QueueItem } from '../../lib/snapshot-types';

// BUG-002 (T119) — postCommand now returns `{ correlationId }` so the
// caller can listen for an ACK. The default stub returns a stable id so
// every test gets a deterministic correlation key.
let nextCorrelationId = 'corr-test';
const postCommandSpy = vi.fn((..._args: unknown[]) => ({ correlationId: nextCorrelationId }));
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args)
}));
// FR-R4-F05 (I4) — the remove action sends through the intent ledger, which supplies its own
// identity as the third argument of `postCommand`; this is what the assertions below expect of it.
const LEDGER_IDENTITY = expect.objectContaining({ correlationId: expect.any(String) });

// Feature 063 (T028, T034) — the per-row destructive actions now gate
// through the shared `useConfirm` helper. These tests treat the prompt as
// auto-accepted so the existing IPC dispatch assertions stay focused on
// the actual command payloads. A dedicated useConfirm.test.ts covers the
// modal lifecycle, suppression, and lock semantics.
vi.mock('../../lib/use-confirm', () => ({
  useConfirm: vi.fn(async () => true)
}));

// BUG-002 (T119) — capture the most recent `onceAck` listener so each
// test can synthesize an accepted / rejected ACK and assert the inline
// rejection text the operator sees.
const markPendingSpy = vi.fn();
const onceAckSpy = vi.fn();
let lastAckListener: ((ack: { status: string; reason?: string }) => void) | null = null;
vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    queues: [],
    markPending: (...args: unknown[]) => markPendingSpy(...args),
    onceAck: (correlationId: string, listener: (ack: { status: string; reason?: string }) => void) => {
      lastAckListener = listener;
      onceAckSpy(correlationId, listener);
      // FR-R4-F05 (I3) — the intent ledger keeps the unsubscribe it is handed.
      return () => undefined;
    }
  }
}));

import {
  CMD_RETRY_QUEUE_ITEM,
  CMD_CANCEL,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_RESTART_CANCELED_TASK,
  CMD_ATTEST_TASK_COMPLETED
} from '../../lib/messages';
import { useConfirm } from '../../lib/use-confirm';

const useConfirmMock = vi.mocked(useConfirm);

beforeEach(() => {
  nextCorrelationId = 'corr-test';
  postCommandSpy.mockReset();
  postCommandSpy.mockImplementation(() => ({ correlationId: nextCorrelationId }));
  markPendingSpy.mockReset();
  onceAckSpy.mockReset();
  lastAckListener = null;
  useConfirmMock.mockReset();
  useConfirmMock.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  // The ledger is module state: an unsettled intent from one case would be reused by the next.
  disposeIntentLedger();
});

// FR-R4-F05 — the ack now settles a promise the component awaits (the intent ledger), so the
// continuation that renders the outcome runs a few microtasks after the listener fires.
async function flushAck(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await tick();
}

function buildItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return Object.freeze({
    id: 'q-1',
    label: 'Add filters',
    enqueuedAt: '2026-05-10T10:00:00.000Z',
    startedAt: null,
    updatedAt: '2026-05-10T10:00:00.000Z',
    completedAt: null,
    status: 'pending',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: null,
    position: 0,
    phaseProgress: null,
    ...overrides
  });
}

async function confirmRemove(getByTestId: (id: string) => HTMLElement, id = 'q-1'): Promise<void> {
  await fireEvent.click(getByTestId(`queue-item-remove-${id}`));
  // Feature 063 (T028) — the click fans out through `useConfirm`, which
  // is mocked at the top of this file to resolve `true` synchronously.
  // We still need a microtask flush so the awaited handler can dispatch
  // CMD_REMOVE_QUEUE_ITEM before the assertion runs.
  await tick();
}

describe('QueueItemActions (FR-036 tightened, BUG-004)', () => {
  describe('Per-status action set is exhaustive', () => {
    it('in-flight row renders Cancel plus Delete', () => {
      const { container, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'in-flight' }), isPrimary: true }
      });
      expect(queryByTestId('queue-item-cancel-q-1')).not.toBeNull();
      expect(queryByTestId('queue-item-retry-q-1')).toBeNull();
      expect(queryByTestId('queue-item-remove-q-1')).not.toBeNull();
      // Feature 030 (US2, T034) — up/down arrows moved to QueueItem.svelte.
      expect(queryByTestId('queue-item-move-up-q-1')).toBeNull();
      expect(queryByTestId('queue-item-move-down-q-1')).toBeNull();
      expect(container.querySelectorAll('button').length).toBe(2);
    });

    it('pending row renders edit plus ✖ remove controls', () => {
      // Feature 030 (US2, T034) — up/down arrows are no longer rendered by
      // QueueItemActions; they live on QueueItem.svelte and route through
      // the shared helper at webview-ui/src/lib/reorder-task.ts.
      // Feature 030 (US3, T045) — the per-row "Move to another queue"
      // affordance (`queue-item-move-task-{id}`) was removed alongside
      // the multi-queue surfaces. A pending row now renders edit + ✖.
      const { container, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'pending' }), isPrimary: true }
      });
      expect(queryByTestId('queue-item-remove-q-1')?.textContent?.trim()).toBe('✖');
      expect(queryByTestId('queue-item-move-up-q-1')).toBeNull();
      expect(queryByTestId('queue-item-move-down-q-1')).toBeNull();
      expect(queryByTestId('queue-item-cancel-q-1')).toBeNull();
      expect(queryByTestId('queue-item-retry-q-1')).toBeNull();
      expect(queryByTestId('queue-item-edit-q-1')).not.toBeNull();
      expect(queryByTestId('queue-item-move-task-q-1')).toBeNull();
      expect(container.querySelectorAll('button').length).toBe(2);
    });

    // Feature 195 (T064, FR-025) — was "Retry plus Delete", asserting two
    // buttons. The failed row's action set genuinely gained a third member:
    // attested completion, for the task neither retry nor remove can serve.
    // The old title and count were correct for what they asserted and are
    // updated here rather than excused — an exhaustiveness assertion that
    // still names two of three actions is the defect T064 closes, one layer
    // down.
    it('failed row renders Retry plus Attest plus Delete', () => {
      const { container, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'failed' }), isPrimary: true }
      });
      const retry = queryByTestId('queue-item-retry-q-1');
      expect(retry).not.toBeNull();
      expect(retry?.textContent?.trim()).toBe('↻');
      expect(queryByTestId('queue-item-cancel-q-1')).toBeNull();
      expect(queryByTestId('queue-item-attest-q-1')).not.toBeNull();
      expect(queryByTestId('queue-item-remove-q-1')).not.toBeNull();
      expect(container.querySelectorAll('button').length).toBe(3);
    });

    // Feature 065 BUG-009 T080 (FR-026) — Retry (↻) is also available for
    // paused rows so the operator can resurrect a stuck task without
    // removing + re-enqueueing it.
    it('paused row renders Retry plus Delete (BUG-009 T080 — FR-026)', () => {
      const { container, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'paused' }), isPrimary: true }
      });
      const retry = queryByTestId('queue-item-retry-q-1');
      expect(retry).not.toBeNull();
      expect(retry?.textContent?.trim()).toBe('↻');
      expect(queryByTestId('queue-item-cancel-q-1')).toBeNull();
      expect(queryByTestId('queue-item-remove-q-1')).not.toBeNull();
      expect(container.querySelectorAll('button').length).toBe(2);
    });

    it('completed row renders Delete', () => {
      const { container, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'completed' }), isPrimary: true }
      });
      expect(queryByTestId('queue-item-remove-q-1')).not.toBeNull();
      expect(container.querySelectorAll('button').length).toBe(1);
    });

    it('canceled row renders Restart plus Delete (BUG-001 — resurrect canceled task)', () => {
      const { container, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'canceled' }), isPrimary: true }
      });
      const restart = queryByTestId('queue-item-restart-q-1');
      expect(restart).not.toBeNull();
      expect(restart?.textContent?.trim()).toBe('↻');
      expect(queryByTestId('queue-item-cancel-q-1')).toBeNull();
      expect(queryByTestId('queue-item-retry-q-1')).toBeNull();
      expect(queryByTestId('queue-item-remove-q-1')).not.toBeNull();
      expect(container.querySelectorAll('button').length).toBe(2);
    });
  });

  describe('IPC dispatch (FR-036 mapping)', () => {
    it('in-flight Cancel posts CMD_CANCEL with the row taskId (BUG-001)', async () => {
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'in-flight' }), isPrimary: true }
      });
      await fireEvent.click(getByTestId('queue-item-cancel-q-1'));
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_CANCEL, { taskId: 'q-1' });
    });

    it('canceled Restart posts CMD_RESTART_CANCELED_TASK with the row taskId', async () => {
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'canceled' }), isPrimary: true }
      });
      await fireEvent.click(getByTestId('queue-item-restart-q-1'));
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_RESTART_CANCELED_TASK, { taskId: 'q-1' });
    });

    it('pending ✖ confirms then posts CMD_REMOVE_QUEUE_ITEM (NOT CMD_CANCEL)', async () => {
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'pending' }), isPrimary: true }
      });
      await confirmRemove(getByTestId);
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_REMOVE_QUEUE_ITEM, { id: 'q-1', confirmed: true }, LEDGER_IDENTITY);
      expect(postCommandSpy).not.toHaveBeenCalledWith(CMD_CANCEL);
    });

    // Feature 030 (US2, T034) — reorder IPC dispatch tests moved to
    // QueueItem.reorder.test.ts since the up/down arrows now live on
    // QueueItem.svelte and route through the shared helper at
    // webview-ui/src/lib/reorder-task.ts.

    it('failed ↻ Retry posts CMD_RETRY_QUEUE_ITEM with the id', async () => {
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'failed' }), isPrimary: true }
      });
      await fireEvent.click(getByTestId('queue-item-retry-q-1'));
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_RETRY_QUEUE_ITEM, { id: 'q-1' });
    });

    // Feature 065 BUG-009 T080 (FR-026) — paused-row Retry routes through
    // the same CMD_RETRY_QUEUE_ITEM dispatch as the failed-row path.
    it('paused ↻ Retry posts CMD_RETRY_QUEUE_ITEM with the id (BUG-009 T080)', async () => {
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'paused' }), isPrimary: true }
      });
      await fireEvent.click(getByTestId('queue-item-retry-q-1'));
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_RETRY_QUEUE_ITEM, { id: 'q-1' });
    });
  });

  // BUG-002 (T119) — SC-010: a visible pending row's ✖ MUST dispatch
  // CMD_REMOVE_QUEUE_ITEM with the row id, mark the correlation pending so
  // a snapshot refresh ack is awaited, and surface inline rejection text
  // (matching the host's canonical reasons) when the host rejects the
  // request. Non-pending rows expose the same destructive affordance.
  describe('BUG-002 (T119) SC-010 pending-row remove regressions', () => {
    it('confirming ✖ on a visible pending row dispatches CMD_REMOVE_QUEUE_ITEM with the row id and marks pending', async () => {
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'pending', id: 'q-7' }), isPrimary: true }
      });
      await confirmRemove(getByTestId, 'q-7');
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_REMOVE_QUEUE_ITEM, { id: 'q-7', confirmed: true }, LEDGER_IDENTITY);
      // The identity is the intent ledger's, passed to `postCommand` and used for the ack listener.
      const correlationId = (postCommandSpy.mock.calls[0]![2] as { correlationId: string })
        .correlationId;
      expect(correlationId).toEqual(expect.any(String));
      expect(markPendingSpy).toHaveBeenCalledWith(correlationId);
      expect(onceAckSpy).toHaveBeenCalledTimes(1);
      expect(onceAckSpy.mock.calls[0]?.[0]).toBe(correlationId);
    });

    it('non-pending rows (in-flight / failed / canceled / completed) expose the remove affordance', () => {
      const inFlight = render(QueueItemActions, {
        props: { item: buildItem({ status: 'in-flight' }), isPrimary: true }
      });
      expect(inFlight.queryByTestId('queue-item-remove-q-1')).not.toBeNull();
      cleanup();

      const failed = render(QueueItemActions, {
        props: { item: buildItem({ status: 'failed' }), isPrimary: true }
      });
      expect(failed.queryByTestId('queue-item-remove-q-1')).not.toBeNull();
      cleanup();

      const canceled = render(QueueItemActions, {
        props: { item: buildItem({ status: 'canceled' }), isPrimary: true }
      });
      expect(canceled.queryByTestId('queue-item-remove-q-1')).not.toBeNull();
      cleanup();

      const completed = render(QueueItemActions, {
        props: { item: buildItem({ status: 'completed' }), isPrimary: true }
      });
      expect(completed.queryByTestId('queue-item-remove-q-1')).not.toBeNull();
    });

    it('accepted ACK leaves no inline rejection text', async () => {
      const { getByTestId, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'pending' }), isPrimary: true }
      });
      await confirmRemove(getByTestId);
      expect(lastAckListener).not.toBeNull();
      lastAckListener?.({ status: 'accepted' });
      await flushAck();
      expect(queryByTestId('queue-item-remove-error-q-1')).toBeNull();
    });

    it('rejected ACK with task-not-in-pending-state surfaces pending-only message', async () => {
      const { getByTestId, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'pending' }), isPrimary: true }
      });
      await confirmRemove(getByTestId);
      expect(lastAckListener).not.toBeNull();
      lastAckListener?.({ status: 'rejected', reason: 'task-not-in-pending-state' });
      await flushAck();
      const err = queryByTestId('queue-item-remove-error-q-1');
      expect(err).not.toBeNull();
      expect(err?.textContent?.trim()).toBe('Cannot remove: task is no longer pending.');
      expect(err?.getAttribute('role')).toBe('status');
    });

    it('rejected ACK with unknown-task-id surfaces the no-longer-exists message', async () => {
      const { getByTestId, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'pending' }), isPrimary: true }
      });
      await confirmRemove(getByTestId);
      expect(lastAckListener).not.toBeNull();
      lastAckListener?.({ status: 'rejected', reason: 'unknown-task-id' });
      await flushAck();
      const err = queryByTestId('queue-item-remove-error-q-1');
      expect(err).not.toBeNull();
      expect(err?.textContent?.trim()).toBe('Cannot remove: task no longer exists.');
    });

    it('a follow-up click clears stale rejection text before dispatching again', async () => {
      const { getByTestId, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'pending' }), isPrimary: true }
      });
      await confirmRemove(getByTestId);
      lastAckListener?.({ status: 'rejected', reason: 'task-not-in-pending-state' });
      await flushAck();
      expect(queryByTestId('queue-item-remove-error-q-1')).not.toBeNull();

      await confirmRemove(getByTestId);
      // Stale text cleared synchronously on the new click.
      await tick();
      expect(queryByTestId('queue-item-remove-error-q-1')).toBeNull();
      // The first intent settled, so the second click is a new intent under a new identity.
      const identities = postCommandSpy.mock.calls.map(
        (call) => (call[2] as { correlationId: string }).correlationId
      );
      expect(identities).toHaveLength(2);
      expect(identities[1]).not.toBe(identities[0]);
      expect(markPendingSpy).toHaveBeenLastCalledWith(identities[1]);
    });
  });

  describe('Accessibility', () => {
    it('every rendered button preserves aria-label', () => {
      // Feature 030 (US2, T034) — up/down arrows moved to QueueItem.svelte.
      // Feature 030 (US3, T045) — the per-row "Move to another queue"
      // button was removed; a pending row now renders edit + remove
      // (2 buttons).
      const { container } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'pending' }), isPrimary: true }
      });
      const buttons = container.querySelectorAll('button');
      expect(buttons.length).toBe(2);
      buttons.forEach((b) => {
        expect(b.getAttribute('aria-label')).toBeTruthy();
        expect(b.getAttribute('type')).toBe('button');
      });
    });

    it('All buttons aria-disabled when isPrimary===false', () => {
      const { container } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'failed' }), isPrimary: false }
      });
      const buttons = container.querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach((b) => {
        expect(b.getAttribute('aria-disabled')).toBe('true');
      });
    });

    it('Click on aria-disabled button does NOT post a command', async () => {
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'failed' }), isPrimary: false }
      });
      await fireEvent.click(getByTestId('queue-item-retry-q-1'));
      expect(postCommandSpy).not.toHaveBeenCalled();
    });
  });

  // FR-R3-153 (FR-011, T1639) — the confirmation must be able to name this
  // task's real status, which requires the component to actually pass it
  // through to `useConfirm`'s context (action-copy.test.ts covers the
  // rendered wording itself).
  describe('delete confirmation carries the task status (FR-011)', () => {
    it.each(['pending', 'in-flight', 'paused', 'completed', 'failed', 'canceled'] as const)(
      'passes status=%s into the queue.remove-item confirmation context',
      async (status) => {
        const { getByTestId } = render(QueueItemActions, {
          props: { item: buildItem({ status }), isPrimary: true }
        });
        await fireEvent.click(getByTestId('queue-item-remove-q-1'));
        await tick();
        expect(useConfirmMock).toHaveBeenCalledWith(
          'queue.remove-item',
          expect.objectContaining({ context: expect.objectContaining({ taskTitle: 'Add filters', status }) })
        );
      }
    );

    it('dismissing the confirmation posts nothing, for any status', async () => {
      useConfirmMock.mockResolvedValueOnce(false);
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'in-flight' }), isPrimary: true }
      });
      await fireEvent.click(getByTestId('queue-item-remove-q-1'));
      await tick();
      expect(postCommandSpy).not.toHaveBeenCalled();
    });
  });

  // Feature 195 (T064, FR-025, FR-026) — the third way out of a halt.
  //
  // A task whose phase committed an irreversible side effect and was *then*
  // recorded failed can be served by neither of FR-009's two exits: retry
  // repeats the side effect, remove destroys the record the operator wants to
  // keep. So the operator attests the outcome instead, and the halt ends by
  // FR-003's recomputation with nothing stored.
  //
  // The affordance lives on this component rather than on either surface T064
  // names, because `QueueControls.svelte` renders *this* component for the row
  // its halt names (T031) — so one affordance reaches the queue header and the
  // row list both, and `QueueControls` keeps its documented property of adding
  // no IPC call of its own.
  describe('attested completion (T064, FR-025)', () => {
    it('offers the affordance on a failed row and on no other status', () => {
      for (const status of ['pending', 'in-flight', 'paused', 'completed', 'canceled'] as const) {
        const { queryByTestId, unmount } = render(QueueItemActions, {
          props: { item: buildItem({ status }), isPrimary: true }
        });
        expect(queryByTestId('queue-item-attest-q-1')).toBeNull();
        unmount();
      }
      const { queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'failed' }), isPrimary: true }
      });
      expect(queryByTestId('queue-item-attest-q-1')).not.toBeNull();
    });

    it('posts CMD_ATTEST_TASK_COMPLETED with the row taskId once confirmed', async () => {
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'failed' }), isPrimary: true }
      });

      await fireEvent.click(getByTestId('queue-item-attest-q-1'));
      await tick();

      expect(postCommandSpy).toHaveBeenCalledWith(CMD_ATTEST_TASK_COMPLETED, {
        taskId: 'q-1',
        confirmed: true
      });
    });

    it('asks for the attestation by its own action key, naming the task', async () => {
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'failed' }), isPrimary: true }
      });

      await fireEvent.click(getByTestId('queue-item-attest-q-1'));
      await tick();

      expect(useConfirmMock).toHaveBeenCalledWith(
        'queue.attest-completed',
        expect.objectContaining({
          context: expect.objectContaining({ taskTitle: 'Add filters' })
        })
      );
    });

    // FR-025: "the operator MUST assert that outcome explicitly; the system
    // MUST NOT infer it". A dismissed prompt is not an assertion, so nothing
    // may be posted — the click alone must never reach the host.
    it('posts nothing when the operator dismisses the prompt', async () => {
      useConfirmMock.mockResolvedValueOnce(false);
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'failed' }), isPrimary: true }
      });

      await fireEvent.click(getByTestId('queue-item-attest-q-1'));
      await tick();

      expect(postCommandSpy).not.toHaveBeenCalled();
    });

    it('is aria-disabled and inert in a non-primary window', async () => {
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'failed' }), isPrimary: false }
      });

      const button = getByTestId('queue-item-attest-q-1');
      expect(button.getAttribute('aria-disabled')).toBe('true');

      await fireEvent.click(button);
      await tick();

      expect(useConfirmMock).not.toHaveBeenCalled();
      expect(postCommandSpy).not.toHaveBeenCalled();
    });
  });
});

// FR-R4-F05 (T17, T117; contract I, I5 to I8; contract O, O3, O4) — a remove whose wait ran out. The
// remove action had no timer: a host that never answered left the row in limbo with no message. It
// waits 5 s through the intent ledger, says the outcome is NOT YET KNOWN (the host may still remove
// the task), a second click is the same intent under the same identity, the host's late answer
// replaces the message once, and unmount removes the timer.
describe('a remove whose wait ran out (T117; FR-024, FR-026)', () => {
  const NOT_YET_KNOWN = 'The host has not answered yet, so the outcome is not yet known.';

  it('shows the not-yet-known text at 5,000 ms, and the late outcome replaces it once', async () => {
    vi.useFakeTimers();
    try {
      const { getByTestId, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'pending' }), isPrimary: true }
      });
      await confirmRemove(getByTestId);
      expect(queryByTestId('queue-item-remove-error-q-1')).toBeNull();

      await vi.advanceTimersByTimeAsync(5_000);
      await flushAck();
      expect(getByTestId('queue-item-remove-error-q-1').textContent.trim()).toBe(NOT_YET_KNOWN);

      lastAckListener?.({ status: 'rejected', reason: 'unknown-task-id' });
      await flushAck();
      expect(getByTestId('queue-item-remove-error-q-1').textContent.trim()).toBe(
        'Cannot remove: task no longer exists.'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries under the same identity and payload', async () => {
    vi.useFakeTimers();
    try {
      const { getByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'pending' }), isPrimary: true }
      });
      await confirmRemove(getByTestId);
      await vi.advanceTimersByTimeAsync(5_000);
      await flushAck();

      await confirmRemove(getByTestId);

      const [first, second] = postCommandSpy.mock.calls;
      expect((second![2] as { correlationId: string }).correlationId).toBe(
        (first![2] as { correlationId: string }).correlationId
      );
      expect(second![1]).toEqual(first![1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no timer behind when the row unmounts before the ack', async () => {
    vi.useFakeTimers();
    try {
      const { getByTestId, unmount } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'pending' }), isPrimary: true }
      });
      await confirmRemove(getByTestId);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      unmount();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
