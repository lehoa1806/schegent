import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import QueueItemActions from '../QueueItemActions.svelte';
import type { QueueItem } from '../../lib/snapshot-types';

// BUG-002 (T119) — postCommand now returns `{ correlationId }` so the
// caller can listen for an ACK. The default stub returns a stable id so
// every test gets a deterministic correlation key.
let nextCorrelationId = 'corr-test';
const postCommandSpy = vi.fn((..._args: unknown[]) => ({ correlationId: nextCorrelationId }));
vi.mock('../../lib/vscode-api', () => ({
  postCommand: (...args: unknown[]) => postCommandSpy(...args)
}));

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
    }
  }
}));

import {
  CMD_RETRY_QUEUE_ITEM,
  CMD_CANCEL,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_RESTART_CANCELED_TASK
} from '../../lib/messages';

beforeEach(() => {
  nextCorrelationId = 'corr-test';
  postCommandSpy.mockReset();
  postCommandSpy.mockImplementation(() => ({ correlationId: nextCorrelationId }));
  markPendingSpy.mockReset();
  onceAckSpy.mockReset();
  lastAckListener = null;
});
afterEach(() => cleanup());

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

    it('failed row renders Retry plus Delete', () => {
      const { container, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'failed' }), isPrimary: true }
      });
      const retry = queryByTestId('queue-item-retry-q-1');
      expect(retry).not.toBeNull();
      expect(retry?.textContent?.trim()).toBe('↻');
      expect(queryByTestId('queue-item-cancel-q-1')).toBeNull();
      expect(queryByTestId('queue-item-remove-q-1')).not.toBeNull();
      expect(container.querySelectorAll('button').length).toBe(2);
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
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_REMOVE_QUEUE_ITEM, { id: 'q-1', confirmed: true });
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
      expect(postCommandSpy).toHaveBeenCalledWith(CMD_REMOVE_QUEUE_ITEM, { id: 'q-7', confirmed: true });
      expect(markPendingSpy).toHaveBeenCalledWith('corr-test');
      expect(onceAckSpy).toHaveBeenCalledTimes(1);
      expect(onceAckSpy.mock.calls[0]?.[0]).toBe('corr-test');
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
      await tick();
      expect(queryByTestId('queue-item-remove-error-q-1')).toBeNull();
    });

    it('rejected ACK with task-not-in-pending-state surfaces pending-only message', async () => {
      const { getByTestId, queryByTestId } = render(QueueItemActions, {
        props: { item: buildItem({ status: 'pending' }), isPrimary: true }
      });
      await confirmRemove(getByTestId);
      expect(lastAckListener).not.toBeNull();
      lastAckListener?.({ status: 'rejected', reason: 'task-not-in-pending-state' });
      await tick();
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
      await tick();
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
      await tick();
      expect(queryByTestId('queue-item-remove-error-q-1')).not.toBeNull();

      nextCorrelationId = 'corr-second';
      await confirmRemove(getByTestId);
      // Stale text cleared synchronously on the new click.
      await tick();
      expect(queryByTestId('queue-item-remove-error-q-1')).toBeNull();
      expect(markPendingSpy).toHaveBeenLastCalledWith('corr-second');
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
});
