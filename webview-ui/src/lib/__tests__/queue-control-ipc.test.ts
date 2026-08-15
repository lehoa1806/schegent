// Feature 095 (T012, FR-002, FR-007, FR-016) — the queue-control IPC helper.
//
// Asserts the correlated-request contract the four existing helpers share
// (accept, reject-with-reason, timeout, no cross-resolution), plus the two
// things specific to this module: the two-phase delete's probe branches, and
// that `moveTask` sends no `position`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CMD_CLEAR_QUEUE_SCHEDULE,
  CMD_DELETE_QUEUE,
  CMD_MOVE_TASK,
  CMD_SAVE_QUEUE_SETTINGS,
  CMD_SET_QUEUE_SCHEDULE
} from '../messages';

type AckListener = (ack: {
  status: 'accepted' | 'rejected';
  reason?: string;
  result?: unknown;
}) => void;

const ackListeners = new Map<string, AckListener>();
const pendingSet = new Set<string>();
const posted: { type: string; payload?: unknown; correlationId: string }[] = [];

let nextId = 0;
let confirmAnswer = true;
const confirmCalls: { actionKey: string; context?: unknown }[] = [];

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

vi.mock('../vscode-api', () => ({
  postCommand(type: string, payload?: unknown): { correlationId: string } {
    const correlationId = `c${++nextId}`;
    posted.push({ type, payload, correlationId });
    return { correlationId };
  }
}));

vi.mock('../use-confirm', () => ({
  useConfirm(actionKey: string, options?: { context?: unknown }): Promise<boolean> {
    confirmCalls.push({ actionKey, context: options?.context });
    return Promise.resolve(confirmAnswer);
  }
}));

const {
  clearQueueSchedule,
  confirmAndDeleteQueue,
  moveTask,
  saveQueueSettings,
  setQueueSchedule
} = await import('../queue-control-ipc');

function fireAck(
  id: string,
  status: 'accepted' | 'rejected',
  reason?: string,
  result?: unknown
): void {
  const fn = ackListeners.get(id);
  expect(fn, `no listener registered for ${id}`).toBeDefined();
  ackListeners.delete(id);
  fn!({ status, reason, result });
}

const IMPACT = { queueId: 'q-beta', pendingTaskCount: 3, boundConnectedRunIds: ['r1', 'r2'] };

beforeEach(() => {
  ackListeners.clear();
  pendingSet.clear();
  posted.length = 0;
  confirmCalls.length = 0;
  nextId = 0;
  confirmAnswer = true;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('correlated-request contract', () => {
  it('marks the correlation id pending and resolves accepted on a matching ack', async () => {
    const promise = clearQueueSchedule('q-beta');
    const { correlationId, type, payload } = posted[0]!;
    expect(type).toBe(CMD_CLEAR_QUEUE_SCHEDULE);
    expect(payload).toEqual({ queueId: 'q-beta' });
    expect(pendingSet.has(correlationId)).toBe(true);

    fireAck(correlationId, 'accepted');
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('carries the host refusal reason through', async () => {
    const promise = setQueueSchedule('q-beta', 'in 30m');
    fireAck(posted[0]!.correlationId, 'rejected', 'invalid-expression');
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'invalid-expression'
    });
  });

  it('substitutes a generic reason when the host names none', async () => {
    const promise = clearQueueSchedule('q-beta');
    fireAck(posted[0]!.correlationId, 'rejected');
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'rejected' });
  });

  it('resolves rejected/timeout after 5 seconds', async () => {
    const promise = setQueueSchedule('q-beta', 'in 30m');
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
  });

  it('ignores a late ack that arrives after the timeout', async () => {
    const promise = clearQueueSchedule('q-beta');
    const { correlationId } = posted[0]!;
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
    // The one-shot listener was unsubscribed by `finalise`, so nothing is
    // registered to receive this and the already-settled promise cannot change.
    expect(ackListeners.has(correlationId)).toBe(false);
  });

  it('never cross-resolves two concurrent calls', async () => {
    const first = setQueueSchedule('q-alpha', 'in 30m');
    const second = clearQueueSchedule('q-beta');
    const [a, b] = posted;

    fireAck(b!.correlationId, 'rejected', 'not-armed');
    fireAck(a!.correlationId, 'accepted');

    await expect(first).resolves.toEqual({ status: 'accepted' });
    await expect(second).resolves.toEqual({ status: 'rejected', reason: 'not-armed' });
  });
});

describe('saveQueueSettings', () => {
  it('carries both values in one command', async () => {
    const promise = saveQueueSettings(7, 'q-beta');
    expect(posted[0]!.type).toBe(CMD_SAVE_QUEUE_SETTINGS);
    expect(posted[0]!.payload).toEqual({ globalConcurrencyCap: 7, defaultQueueId: 'q-beta' });
    fireAck(posted[0]!.correlationId, 'accepted');
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('sends an out-of-range cap to the host rather than refusing locally (FR-011)', async () => {
    const promise = saveQueueSettings(99, 'q-beta');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.payload).toMatchObject({ globalConcurrencyCap: 99 });
    fireAck(posted[0]!.correlationId, 'rejected', 'out-of-range');
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'out-of-range' });
  });
});

describe('moveTask', () => {
  it('sends only the Task and its target queue — no position (FR-016)', async () => {
    const promise = moveTask('t-1', 'q-beta');
    expect(posted[0]!.type).toBe(CMD_MOVE_TASK);
    expect(posted[0]!.payload).toEqual({ taskId: 't-1', targetQueueId: 'q-beta' });
    expect(Object.keys(posted[0]!.payload as object)).not.toContain('position');
    fireAck(posted[0]!.correlationId, 'accepted');
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });
});

describe('confirmAndDeleteQueue', () => {
  it('probes unconfirmed, confirms with the host impact, then deletes confirmed', async () => {
    const promise = confirmAndDeleteQueue('q-beta', 'Beta');

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: CMD_DELETE_QUEUE, payload: { queueId: 'q-beta' } });
    expect(Object.keys(posted[0]!.payload as object)).not.toContain('confirmed');

    fireAck(posted[0]!.correlationId, 'rejected', 'confirmation-required', IMPACT);
    await vi.advanceTimersByTimeAsync(0);

    // Counts come from the probe, never from a snapshot.
    expect(confirmCalls).toEqual([
      {
        actionKey: 'queue.delete',
        context: { queueName: 'Beta', pendingTaskCount: 3, connectedRunCount: 2 }
      }
    ]);

    expect(posted).toHaveLength(2);
    expect(posted[1]!.payload).toEqual({ queueId: 'q-beta', confirmed: true });
    fireAck(posted[1]!.correlationId, 'accepted');

    await expect(promise).resolves.toEqual({ status: 'deleted' });
  });

  it('posts nothing further when the operator declines', async () => {
    confirmAnswer = false;
    const promise = confirmAndDeleteQueue('q-beta', 'Beta');
    fireAck(posted[0]!.correlationId, 'rejected', 'confirmation-required', IMPACT);

    await expect(promise).resolves.toEqual({ status: 'declined' });
    expect(posted).toHaveLength(1);
  });

  it('refuses without prompting when the probe is refused ahead of the gate', async () => {
    for (const reason of ['default-queue', 'in-flight-task', 'unsupported']) {
      posted.length = 0;
      confirmCalls.length = 0;
      const promise = confirmAndDeleteQueue('default', 'Default');
      fireAck(posted[0]!.correlationId, 'rejected', reason);
      await expect(promise).resolves.toEqual({ status: 'refused', reason });
      expect(confirmCalls).toHaveLength(0);
      expect(posted).toHaveLength(1);
    }
  });

  it('treats an impact payload of the wrong shape as a plain refusal', async () => {
    const promise = confirmAndDeleteQueue('q-beta', 'Beta');
    fireAck(posted[0]!.correlationId, 'rejected', 'confirmation-required', {
      queueId: 'q-beta',
      pendingTaskCount: '3',
      boundConnectedRunIds: ['r1']
    });
    await expect(promise).resolves.toEqual({
      status: 'refused',
      reason: 'confirmation-required'
    });
    expect(confirmCalls).toHaveLength(0);
  });

  it('reports an impossible accepted probe rather than assuming it away', async () => {
    const promise = confirmAndDeleteQueue('q-beta', 'Beta');
    fireAck(posted[0]!.correlationId, 'accepted');
    await expect(promise).resolves.toEqual({ status: 'refused', reason: 'unexpected-accept' });
    expect(confirmCalls).toHaveLength(0);
  });

  it('reports a timed-out probe as a refusal, without prompting', async () => {
    const promise = confirmAndDeleteQueue('q-beta', 'Beta');
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'refused', reason: 'timeout' });
    expect(confirmCalls).toHaveLength(0);
  });

  it('reports a refusal on the confirmed delete', async () => {
    const promise = confirmAndDeleteQueue('q-beta', 'Beta');
    fireAck(posted[0]!.correlationId, 'rejected', 'confirmation-required', IMPACT);
    await vi.advanceTimersByTimeAsync(0);
    fireAck(posted[1]!.correlationId, 'rejected', 'in-flight-task');
    await expect(promise).resolves.toEqual({ status: 'refused', reason: 'in-flight-task' });
  });
});
