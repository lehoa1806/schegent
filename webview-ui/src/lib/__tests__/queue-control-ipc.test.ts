// Feature 095 (T012, FR-002, FR-007, FR-016) — the queue-control IPC helper.
//
// Asserts the correlated-request contract `saveQueueSettings` and `moveTask`
// share (accept, reject-with-reason, timeout, no cross-resolution), plus the
// two things specific to this module: the two-phase delete's probe branches,
// and that `moveTask` sends no `position`.
//
// Feature 097 removed the module's other two simple helpers,
// `setQueueSchedule`/`clearQueueSchedule` (FR-013); `saveQueueSettings` and
// `moveTask` are now this block's only vehicles for the shared contract.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CMD_CLEAR_COMPLETED,
  CMD_CLEAR_QUEUE,
  CMD_DELETE_QUEUE,
  CMD_MOVE_TASK,
  CMD_SAVE_QUEUE_SETTINGS
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
  // FR-R4-F05 (I4) — honours the identity the intent ledger supplies, as the real `postCommand` does.
  postCommand(
    type: string,
    payload?: unknown,
    opts?: { correlationId?: string }
  ): { correlationId: string } {
    const correlationId = opts?.correlationId ?? `c${++nextId}`;
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
  clearCompleted,
  clearQueue,
  confirmAndDeleteQueue,
  moveTask,
  refusalText,
  saveQueueSettings
} = await import('../queue-control-ipc');
const { disposeIntentLedger } = await import('../intent-ledger');

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
  // The ledger is module state: an unsettled intent from one case would be reused by the next.
  disposeIntentLedger();
  vi.useRealTimers();
});

describe('correlated-request contract', () => {
  it('marks the correlation id pending and resolves accepted on a matching ack', async () => {
    const promise = moveTask('t-1', 'q-beta');
    const { correlationId, type, payload } = posted[0]!;
    expect(type).toBe(CMD_MOVE_TASK);
    expect(payload).toEqual({ taskId: 't-1', targetQueueId: 'q-beta' });
    expect(pendingSet.has(correlationId)).toBe(true);

    fireAck(correlationId, 'accepted');
    await expect(promise).resolves.toEqual({ status: 'accepted' });
  });

  it('carries the host refusal reason through', async () => {
    const promise = saveQueueSettings(7, 'q-beta');
    fireAck(posted[0]!.correlationId, 'rejected', 'invalid-concurrency-cap');
    await expect(promise).resolves.toEqual({
      status: 'rejected',
      reason: 'invalid-concurrency-cap'
    });
  });

  it('substitutes a generic reason when the host names none', async () => {
    const promise = moveTask('t-1', 'q-beta');
    fireAck(posted[0]!.correlationId, 'rejected');
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'rejected' });
  });

  it('resolves rejected/timeout after 5 seconds', async () => {
    const promise = saveQueueSettings(7, 'q-beta');
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
  });

  // FR-R4-F05 (I3; TA9) — this case used to assert that the one-shot listener was unsubscribed at
  // the timeout. It now stays: the intent ledger keeps the identity until the host answers or the
  // reuse window ends, so a retry can reuse it and the host's late ack is not lost. What still
  // holds is that the settled promise cannot change, and that the ack removes the listener.
  it('settles once at the timeout, and a late ack changes nothing and removes the listener', async () => {
    const promise = moveTask('t-1', 'q-beta');
    const { correlationId } = posted[0]!;
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
    expect(ackListeners.has(correlationId)).toBe(true);

    fireAck(correlationId, 'accepted');

    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
    expect(ackListeners.has(correlationId)).toBe(false);
  });

  it('never cross-resolves two concurrent calls', async () => {
    const first = saveQueueSettings(7, 'q-alpha');
    const second = moveTask('t-1', 'q-beta');
    const [a, b] = posted;

    fireAck(b!.correlationId, 'rejected', 'unknown-task-id');
    fireAck(a!.correlationId, 'accepted');

    await expect(first).resolves.toEqual({ status: 'accepted' });
    await expect(second).resolves.toEqual({ status: 'rejected', reason: 'unknown-task-id' });
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
    fireAck(posted[0]!.correlationId, 'rejected', 'invalid-concurrency-cap');
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'invalid-concurrency-cap' });
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
    for (const reason of [
      'default-queue-undeletable',
      'queue-has-in-flight-task',
      // FR-R4-F01 (spec 239, US3, FR-013, contract D2) — a queue whose Run is live is refused too.
      'queue-has-running-run',
      'queue-has-retry-pending-run',
      'queue-has-paused-run',
      'unsupported'
    ]) {
      posted.length = 0;
      confirmCalls.length = 0;
      const promise = confirmAndDeleteQueue('default', 'Default');
      fireAck(posted[0]!.correlationId, 'rejected', reason);
      await expect(promise).resolves.toEqual({ status: 'refused', reason });
      expect(confirmCalls).toHaveLength(0);
      expect(posted).toHaveLength(1);
    }
  });

  // FR-R4-F01 (spec 239, US3, FR-013, contract D2) — the three refusals name the state the Run
  // is in and the one control that clears it. The text is the contract's, character for
  // character: an operator reads this, and a raw `queue-has-paused-run` is a code nobody can act on.
  it.each([
    [
      'queue-has-running-run',
      "This queue's Run is still running. Cancel the Run first, then delete the queue."
    ],
    [
      'queue-has-retry-pending-run',
      "This queue's Run is waiting to retry. Cancel the Run first, then delete the queue."
    ],
    [
      'queue-has-paused-run',
      "This queue's Run is paused (at a breakpoint, at its spend limit, or by you). Cancel the Run first, then delete the queue."
    ]
  ])('renders %s as the operator text of contract D2', (reason, text) => {
    expect(refusalText(reason)).toBe(text);
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
    fireAck(posted[1]!.correlationId, 'rejected', 'queue-has-in-flight-task');
    await expect(promise).resolves.toEqual({ status: 'refused', reason: 'queue-has-in-flight-task' });
  });
});

// Code-review finding (iteration 4, FR-R3-150/FR-011) — `clearQueue`/
// `clearCompleted` replace a bare `postCommand` call in `QueueDetailTier`
// that never listened for the ack, so an `unknown-queue-id` refusal (the
// queue was deleted from another window between opening the confirmation
// and confirming it) reached no one. These assert the confirm-then-correlate
// contract the two share with `confirmAndDeleteQueue` above.
const CLEAN_ALL_CONTEXT = {
  queueId: 'q-beta',
  queueName: 'nightly',
  pendingCount: 1,
  completedCount: 0,
  failedCount: 0,
  canceledCount: 0,
  inflightTitle: null,
  pauseSource: null,
  hasActiveRun: false,
  hasSchedule: false
};

const CLEAR_DONE_CONTEXT = { queueId: 'q-beta', queueName: 'nightly', completedCount: 2 };

describe('clearQueue', () => {
  it('confirms, then posts and correlates the ack', async () => {
    const promise = clearQueue('q-beta', CLEAN_ALL_CONTEXT);
    await vi.advanceTimersByTimeAsync(0);

    expect(confirmCalls).toEqual([{ actionKey: 'queue.clean-all', context: CLEAN_ALL_CONTEXT }]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: CMD_CLEAR_QUEUE, payload: { queueId: 'q-beta' } });

    fireAck(posted[0]!.correlationId, 'accepted');
    await expect(promise).resolves.toEqual({ status: 'cleared' });
  });

  it('posts nothing when the operator declines', async () => {
    confirmAnswer = false;
    const promise = clearQueue('q-beta', CLEAN_ALL_CONTEXT);
    await expect(promise).resolves.toEqual({ status: 'declined' });
    expect(posted).toHaveLength(0);
  });

  it('surfaces an unknown-queue-id refusal instead of dropping the ack', async () => {
    const promise = clearQueue('q-beta', CLEAN_ALL_CONTEXT);
    await vi.advanceTimersByTimeAsync(0);
    fireAck(posted[0]!.correlationId, 'rejected', 'unknown-queue-id');
    await expect(promise).resolves.toEqual({ status: 'refused', reason: 'unknown-queue-id' });
  });
});

// Feature 195 (T032, FR-019, SC-011) — every command this module correlates
// shares one `correlatedRequest` scaffold, and that scaffold's `status` comes
// from the host's own ack `status` field alone (never from `outcome`, never
// inferred). A halt is one of the reasons a queue command can now be
// declined for (`queue-halted-on-failed-task`, `commands/start-queue.ts`);
// this pins that a `rejected` ack carrying that reason resolves through the
// shared scaffold as a refusal with the reason attached, and never as
// `accepted` — the structural guarantee FR-019 depends on for every command
// routed through this module, not only the one this feature added.
describe('halted-queue refusals never acknowledge accepted (FR-019, SC-011)', () => {
  it('moveTask resolves a halt refusal as rejected-with-reason, never accepted', async () => {
    const promise = moveTask('t-1', 'q-beta');
    fireAck(posted[0]!.correlationId, 'rejected', 'queue-halted-on-failed-task');
    const result = await promise;
    expect(result).toEqual({ status: 'rejected', reason: 'queue-halted-on-failed-task' });
    expect(result.status).not.toBe('accepted');
  });

  it('clearQueue resolves a halt refusal as refused-with-reason, never cleared', async () => {
    const promise = clearQueue('q-beta', CLEAN_ALL_CONTEXT);
    await vi.advanceTimersByTimeAsync(0);
    fireAck(posted[0]!.correlationId, 'rejected', 'queue-halted-on-failed-task');
    const outcome = await promise;
    expect(outcome).toEqual({ status: 'refused', reason: 'queue-halted-on-failed-task' });
    expect(outcome.status).not.toBe('cleared');
  });
});

describe('clearCompleted', () => {
  it('confirms, then posts and correlates the ack', async () => {
    const promise = clearCompleted('q-beta', CLEAR_DONE_CONTEXT);
    await vi.advanceTimersByTimeAsync(0);

    expect(confirmCalls).toEqual([{ actionKey: 'queue.clear-done', context: CLEAR_DONE_CONTEXT }]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: CMD_CLEAR_COMPLETED, payload: { queueId: 'q-beta' } });

    fireAck(posted[0]!.correlationId, 'accepted');
    await expect(promise).resolves.toEqual({ status: 'cleared' });
  });

  it('surfaces an unknown-queue-id refusal instead of dropping the ack', async () => {
    const promise = clearCompleted('q-beta', CLEAR_DONE_CONTEXT);
    await vi.advanceTimersByTimeAsync(0);
    fireAck(posted[0]!.correlationId, 'rejected', 'unknown-queue-id');
    await expect(promise).resolves.toEqual({ status: 'refused', reason: 'unknown-queue-id' });
  });
});

// FR-R4-F05 (T11; contract O, O1, O2; data-model §5) — the queue family's own map wins, and
// anything it lacks resolves through the shared boundary text, never through the raw reason.
describe('refusalText — the shared boundary fallback (T11)', () => {
  it('words command-dispatch-failed for a queue change, not for Clean All', () => {
    expect(refusalText('command-dispatch-failed')).toBe(
      'The queue could not be changed. Check the log and try again.'
    );
  });

  it('maps untrusted-workspace, the router gate token, to the boundary sentence', () => {
    expect(refusalText('untrusted-workspace')).toBe(
      'The workspace is not trusted, so this action is unavailable.'
    );
  });

  it('keeps a queue-specific sentence over the boundary table', () => {
    expect(refusalText('task-cap-reached')).toBe('The target queue is already full.');
  });

  it('never shows a free-text reason', () => {
    const freeText = 'write failed at /synthetic/home/user-252/secret.txt';

    expect(refusalText(freeText)).toBe('The host refused this action.');
    expect(refusalText(freeText)).not.toContain('user-252');
  });

  it('names a code-shaped reason it does not know inside a fixed sentence', () => {
    expect(refusalText('some-new-host-refusal')).toBe(
      'The host refused this action (`some-new-host-refusal`).'
    );
  });
});

// FR-R4-F05 (T17; contract I, I4 to I6; contract O, O3) — the queue family sends through the intent
// ledger: a retry of an unresolved action reuses its identity and payload, and the timeout text says
// the outcome is not yet known.
describe('retry identity (T17)', () => {
  it('posts the same correlation id and payload for a retry after a timeout, and resolves it with the ack', async () => {
    const first = moveTask('t-1', 'q-beta');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toEqual({ status: 'rejected', reason: 'timeout' });

    const retry = moveTask('t-1', 'q-beta');

    expect(posted).toHaveLength(2);
    expect(posted[1]!.correlationId).toBe(posted[0]!.correlationId);
    expect(posted[1]!.payload).toEqual(posted[0]!.payload);
    // The host's late ack reaches the retry's waiter, once.
    fireAck(posted[0]!.correlationId, 'accepted');
    await expect(retry).resolves.toEqual({ status: 'accepted' });
    expect(ackListeners.size).toBe(0);
  });

  it('sends a different payload under a new identity', async () => {
    void moveTask('t-1', 'q-beta');
    void moveTask('t-1', 'q-gamma');

    expect(posted[1]!.correlationId).not.toBe(posted[0]!.correlationId);
  });

  it('words a timeout as not yet known, never as a failure or an invitation to retry', () => {
    const text = refusalText('timeout');

    expect(text).toBe(
      'The host has not answered yet. The change may still happen; this view will update when it does.'
    );
    expect(text).not.toMatch(/try again|failed|nothing/i);
  });
});

// FR-R4-F05 code review (I6, I8, FR-024) — a caller that shows the timeout text is told the host's
// answer once when it arrives late, through the same result shape, and an aborted caller is not.
describe('late outcome reaches a caller that waited', () => {
  it('moveTask: a late acceptance replaces the timeout result once', async () => {
    const late = vi.fn();
    const promise = moveTask('t-1', 'q-beta', { onLateOutcome: late });
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'rejected', reason: 'timeout' });
    fireAck(posted[0]!.correlationId, 'accepted');
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith({ status: 'accepted' });
  });

  it('clearCompleted: a late refusal arrives as the ClearQueueOutcome the caller renders', async () => {
    const late = vi.fn();
    const promise = clearCompleted('q-beta', { completedCount: 1 } as never, null, {
      onLateOutcome: late
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'refused', reason: 'timeout' });
    fireAck(posted[0]!.correlationId, 'rejected', 'unknown-queue-id');
    expect(late).toHaveBeenCalledWith({ status: 'refused', reason: 'unknown-queue-id' });
  });

  it('confirmAndDeleteQueue: a late probe impact clears the text and asks nothing', async () => {
    const late = vi.fn();
    const promise = confirmAndDeleteQueue('q-beta', 'Beta', null, { onLateOutcome: late });
    vi.advanceTimersByTime(5000);
    await expect(promise).resolves.toEqual({ status: 'refused', reason: 'timeout' });
    fireAck(posted[0]!.correlationId, 'rejected', 'confirmation-required', IMPACT);
    expect(late).toHaveBeenCalledWith({ status: 'declined' });
    expect(confirmCalls).toHaveLength(0);
  });

  it('an aborted caller gets no late outcome', async () => {
    const late = vi.fn();
    const lifetime = new AbortController();
    const promise = saveQueueSettings(4, 'default', { signal: lifetime.signal, onLateOutcome: late });
    vi.advanceTimersByTime(5000);
    await promise;
    lifetime.abort();
    fireAck(posted[0]!.correlationId, 'accepted');
    expect(late).not.toHaveBeenCalled();
  });
});
