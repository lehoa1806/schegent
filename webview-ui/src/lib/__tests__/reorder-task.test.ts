// Feature 030 (US2, T033) — reorder-task helper unit tests.
//
// Asserts:
//   - postReorderTask posts CMD_REORDER_TASK with the expected payload.
//   - postMoveItemUp posts CMD_MOVE_QUEUE_ITEM_UP with `{ id }` payload.
//   - postMoveItemDown posts CMD_MOVE_QUEUE_ITEM_DOWN with `{ id }` payload.
//   - All three resolve `accepted` on a matching accepted ack.
//   - All three resolve `rejected` with the reason from the ack.
//   - All three resolve `{ status: 'rejected', reason: 'timeout' }`
//     after 5 seconds without ack.
//   - Concurrent calls never cross-resolve mismatched correlation ids.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  postReorderTask,
  postMoveItemUp,
  postMoveItemDown
} from '../reorder-task';
import {
  CMD_REORDER_TASK,
  CMD_MOVE_QUEUE_ITEM_UP,
  CMD_MOVE_QUEUE_ITEM_DOWN
} from '../messages';

type AckListener = (ack: { status: 'accepted' | 'rejected'; reason?: string }) => void;

const ackListeners = new Map<string, AckListener>();
const pendingSet = new Set<string>();
const postedCommands: Array<{ type: string; payload: unknown; correlationId: string }> = [];
let nextCorrelationId = 0;

vi.mock('../vscode-api', () => ({
  postCommand: (type: string, payload: unknown) => {
    const correlationId = `corr-${++nextCorrelationId}`;
    postedCommands.push({ type, payload, correlationId });
    return { correlationId };
  }
}));

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(id: string): void {
      pendingSet.add(id);
    },
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => ackListeners.delete(id);
    }
  }
}));

function fireAck(id: string, status: 'accepted' | 'rejected', reason?: string): void {
  const fn = ackListeners.get(id);
  expect(fn, `no listener registered for ${id}`).toBeDefined();
  ackListeners.delete(id);
  fn!({ status, reason });
}

beforeEach(() => {
  ackListeners.clear();
  pendingSet.clear();
  postedCommands.length = 0;
  nextCorrelationId = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Feature 030 (US2, T033) — reorder-task helper', () => {
  describe('postReorderTask', () => {
    it('posts CMD_REORDER_TASK with { taskId, newPosition }', async () => {
      const promise = postReorderTask('task-7', 2);
      expect(postedCommands).toHaveLength(1);
      const env = postedCommands[0];
      expect(env.type).toBe(CMD_REORDER_TASK);
      expect(env.payload).toEqual({ taskId: 'task-7', newPosition: 2 });
      fireAck(env.correlationId, 'accepted');
      await expect(promise).resolves.toEqual({ status: 'accepted' });
    });

    it('resolves rejected with reason on a matching rejected ack', async () => {
      const promise = postReorderTask('task-7', 2);
      const env = postedCommands[0];
      fireAck(env.correlationId, 'rejected', 'task-not-pending');
      await expect(promise).resolves.toEqual({
        status: 'rejected',
        reason: 'task-not-pending'
      });
    });

    it('resolves { status: rejected, reason: timeout } after 5 seconds without ack', async () => {
      const promise = postReorderTask('task-7', 2);
      vi.advanceTimersByTime(5000);
      await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
    });
  });

  describe('postMoveItemUp', () => {
    it('posts CMD_MOVE_QUEUE_ITEM_UP with { id }', async () => {
      const promise = postMoveItemUp('task-7');
      expect(postedCommands).toHaveLength(1);
      const env = postedCommands[0];
      expect(env.type).toBe(CMD_MOVE_QUEUE_ITEM_UP);
      expect(env.payload).toEqual({ id: 'task-7' });
      fireAck(env.correlationId, 'accepted');
      await expect(promise).resolves.toEqual({ status: 'accepted' });
    });

    it('resolves rejected with reason on a matching rejected ack', async () => {
      const promise = postMoveItemUp('task-7');
      const env = postedCommands[0];
      fireAck(env.correlationId, 'rejected', 'invalid-position');
      await expect(promise).resolves.toEqual({
        status: 'rejected',
        reason: 'invalid-position'
      });
    });
  });

  describe('postMoveItemDown', () => {
    it('posts CMD_MOVE_QUEUE_ITEM_DOWN with { id }', async () => {
      const promise = postMoveItemDown('task-7');
      expect(postedCommands).toHaveLength(1);
      const env = postedCommands[0];
      expect(env.type).toBe(CMD_MOVE_QUEUE_ITEM_DOWN);
      expect(env.payload).toEqual({ id: 'task-7' });
      fireAck(env.correlationId, 'accepted');
      await expect(promise).resolves.toEqual({ status: 'accepted' });
    });

    it('resolves rejected with reason on a matching rejected ack', async () => {
      const promise = postMoveItemDown('task-7');
      const env = postedCommands[0];
      fireAck(env.correlationId, 'rejected', 'no-op');
      await expect(promise).resolves.toEqual({
        status: 'rejected',
        reason: 'no-op'
      });
    });
  });

  it('concurrent calls never cross-resolve mismatched correlation ids', async () => {
    const p1 = postReorderTask('task-7', 2);
    const p2 = postMoveItemUp('task-8');
    const p3 = postMoveItemDown('task-9');
    expect(postedCommands).toHaveLength(3);
    expect(new Set(postedCommands.map((c) => c.correlationId)).size).toBe(3);

    fireAck(postedCommands[2].correlationId, 'rejected', 'no-op');
    await expect(p3).resolves.toEqual({ status: 'rejected', reason: 'no-op' });

    fireAck(postedCommands[0].correlationId, 'accepted');
    await expect(p1).resolves.toEqual({ status: 'accepted' });

    fireAck(postedCommands[1].correlationId, 'rejected', 'invalid-position');
    await expect(p2).resolves.toEqual({
      status: 'rejected',
      reason: 'invalid-position'
    });
  });
});
