// FR-R4-F05 (T16; contract I, I1 to I3, I5, I6, I8, I9; data-model §4; FR-019 to FR-026) — the
// panel's intent ledger: an identical retry of an unresolved action reuses its identity and its
// stored payload, a timeout says the outcome is not yet known, a late ack is shown once, and
// abort and disposal leave no timer and no listener behind.
//
// WHY THESE CASES. The host answers a repeated identity with the first outcome and runs the
// operation once, so the whole benefit of a retry depends on the webview sending the SAME identity.
// Each case here is one way that fails: a new identity on a retry, a payload that drifts between
// sends, a late outcome shown twice or never, a timer that outlives the panel. Time is fake and
// the host's ack is fired by hand; nothing waits for real time.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CMD_MOVE_TASK, CMD_SAVE_QUEUE_SETTINGS } from '../messages';

interface AckLike {
  readonly status: 'accepted' | 'rejected';
  readonly reason?: string;
}
type AckListener = (ack: AckLike) => void;

const ackListeners = new Map<string, AckListener>();
const pending = new Set<string>();

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(id: string): void {
      pending.add(id);
    },
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => {
        if (ackListeners.get(id) === fn) ackListeners.delete(id);
      };
    }
  }
}));

const { INTENT_REUSE_WINDOW_MS, disposeIntentLedger, sendIntent } = await import('../intent-ledger');

const TIMEOUT_MS = 5_000;

interface Post {
  readonly id: string;
  readonly payload: unknown;
}

let posts: Post[];

function post(id: string, payload: unknown): void {
  posts.push({ id, payload });
}

/** The host's ack, delivered the way the store does: remove the listener, then call it. */
function fireAck(id: string, ack: AckLike): void {
  const listener = ackListeners.get(id);
  expect(listener, `no listener for ${id}`).toBeDefined();
  ackListeners.delete(id);
  listener!(ack);
}

const move = (payload: unknown, extra: { signal?: AbortSignal; onLateOutcome?: (ack: AckLike) => void } = {}) =>
  sendIntent({
    type: CMD_MOVE_TASK,
    payload,
    post,
    timeoutMs: TIMEOUT_MS,
    ...extra
  });

beforeEach(() => {
  vi.useFakeTimers();
  ackListeners.clear();
  pending.clear();
  posts = [];
});

afterEach(() => {
  disposeIntentLedger();
  vi.useRealTimers();
});

describe('identity (I1, I2)', () => {
  it('mints an identity, marks it pending and posts the payload under it', () => {
    void move({ taskId: 't-1' });

    expect(posts).toHaveLength(1);
    expect(posts[0]!.payload).toEqual({ taskId: 't-1' });
    expect(posts[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(pending.has(posts[0]!.id)).toBe(true);
  });

  it('reuses the identity and the stored payload while the intent is pending', () => {
    const payload = { taskId: 't-1' };
    void move(payload);
    void move({ taskId: 't-1' });

    expect(posts).toHaveLength(2);
    expect(posts[1]!.id).toBe(posts[0]!.id);
    expect(posts[1]!.payload).toBe(posts[0]!.payload);
  });

  it('reuses the identity once the first wait has timed out', async () => {
    const first = move({ taskId: 't-1' });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(first).resolves.toMatchObject({ kind: 'unknown' });

    void move({ taskId: 't-1' });

    expect(posts[1]!.id).toBe(posts[0]!.id);
  });

  it('registers exactly one listener per identity, however many sends reuse it', () => {
    void move({ taskId: 't-1' });
    void move({ taskId: 't-1' });
    void move({ taskId: 't-1' });

    expect(ackListeners.size).toBe(1);
  });

  it('mints a new identity for a changed payload', () => {
    void move({ taskId: 't-1' });
    void move({ taskId: 't-2' });

    expect(posts[1]!.id).not.toBe(posts[0]!.id);
  });

  it('mints a new identity for a different command type', () => {
    void move({ taskId: 't-1' });
    void sendIntent({ type: CMD_SAVE_QUEUE_SETTINGS, payload: { taskId: 't-1' }, post, timeoutMs: TIMEOUT_MS });

    expect(posts[1]!.id).not.toBe(posts[0]!.id);
  });

  it('mints a new identity after the intent settled', async () => {
    const first = move({ taskId: 't-1' });
    fireAck(posts[0]!.id, { status: 'accepted' });
    await first;

    void move({ taskId: 't-1' });

    expect(posts[1]!.id).not.toBe(posts[0]!.id);
  });

  it('mints a new identity after the reuse window', async () => {
    void move({ taskId: 't-1' });
    await vi.advanceTimersByTimeAsync(INTENT_REUSE_WINDOW_MS);

    void move({ taskId: 't-1' });

    expect(posts[1]!.id).not.toBe(posts[0]!.id);
    // The expired entry's listener went with it: one listener per live identity.
    expect(ackListeners.size).toBe(1);
  });

  it('keeps the reuse window at the host retention', () => {
    expect(INTENT_REUSE_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it('treats payloads that differ only in key order, or in undefined members, as one intent', () => {
    void move({ b: 2, a: 1, nested: { y: 1, x: 2 } });
    void move({ a: 1, b: 2, nested: { x: 2, y: 1 }, omitted: undefined });

    expect(posts[1]!.id).toBe(posts[0]!.id);
  });

  it('keeps array order significant', () => {
    void move({ ids: [1, 2] });
    void move({ ids: [2, 1] });

    expect(posts[1]!.id).not.toBe(posts[0]!.id);
  });
});

describe('outcomes (I5, I6)', () => {
  it('resolves a waiter with the ack when it arrives in time', async () => {
    const waiting = move({ taskId: 't-1' });
    fireAck(posts[0]!.id, { status: 'rejected', reason: 'task-cap-reached' });

    await expect(waiting).resolves.toEqual({
      kind: 'ack',
      ack: { status: 'rejected', reason: 'task-cap-reached' },
      correlationId: posts[0]!.id
    });
  });

  it('resolves a waiter unknown at the timeout, never as a failure', async () => {
    const waiting = move({ taskId: 't-1' });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    await expect(waiting).resolves.toEqual({ kind: 'unknown', correlationId: posts[0]!.id });
  });

  it('gives a waiter that timed out the late outcome exactly once', async () => {
    const late = vi.fn();
    const waiting = move({ taskId: 't-1' }, { onLateOutcome: late });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await waiting;
    expect(late).not.toHaveBeenCalled();

    fireAck(posts[0]!.id, { status: 'accepted' });
    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith({ status: 'accepted' });

    // The listener is gone: a second ack for the identity reaches nobody.
    expect(ackListeners.has(posts[0]!.id)).toBe(false);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('never calls the late callback of a waiter that got its ack', async () => {
    const late = vi.fn();
    const waiting = move({ taskId: 't-1' }, { onLateOutcome: late });

    fireAck(posts[0]!.id, { status: 'accepted' });
    await waiting;

    expect(late).not.toHaveBeenCalled();
  });

  it('answers the waiting retry with the ack and the timed-out first send with the late outcome', async () => {
    const late = vi.fn();
    const first = move({ taskId: 't-1' }, { onLateOutcome: late });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await first;
    const retry = move({ taskId: 't-1' });

    fireAck(posts[0]!.id, { status: 'accepted' });

    await expect(retry).resolves.toMatchObject({ kind: 'ack' });
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('delayed acks (I5, I6; the FR-027 record)', () => {
  // The three holds of the delayed-ack record. A hold inside the wait resolves an ack; a hold
  // past it resolves unknown and then delivers the outcome once.
  it.each([
    { heldMs: 4_900, expectedFirst: 'ack', lateCalls: 0 },
    { heldMs: 5_100, expectedFirst: 'unknown', lateCalls: 1 },
    { heldMs: 30_000, expectedFirst: 'unknown', lateCalls: 1 }
  ])('resolves $expectedFirst, with $lateCalls late outcome(s), when the ack comes after $heldMs ms', async ({ heldMs, expectedFirst, lateCalls }) => {
    const late = vi.fn();
    const waiting = move({ taskId: 't-1' }, { onLateOutcome: late });

    await vi.advanceTimersByTimeAsync(heldMs);
    fireAck(posts[0]!.id, { status: 'accepted' });
    const result = await waiting;

    expect({ heldMs, resolvedTo: result.kind, lateCalls: late.mock.calls.length }).toEqual({
      heldMs,
      resolvedTo: expectedFirst,
      lateCalls
    });
  });
});

describe('abort (I8)', () => {
  it('removes the waiter, its timer and its late callback, and keeps the entry and its identity', async () => {
    const late = vi.fn();
    const controller = new AbortController();
    const waiting = move({ taskId: 't-1' }, { signal: controller.signal, onLateOutcome: late });
    expect(vi.getTimerCount()).toBe(1);

    controller.abort();

    await expect(waiting).resolves.toEqual({ kind: 'cancelled', correlationId: posts[0]!.id });
    expect(vi.getTimerCount()).toBe(0);

    // The entry stays: the host may still run the command, and a retry reuses its identity.
    void move({ taskId: 't-1' });
    expect(posts[1]!.id).toBe(posts[0]!.id);
    fireAck(posts[0]!.id, { status: 'accepted' });
    expect(late).not.toHaveBeenCalled();
  });

  // FR-R4-F05 (I8, FR-026; spec scenario 6) — the unmount that follows a timeout. The waiter has
  // already resolved `unknown` and is only owed the late outcome, so its abort has to drop that
  // callback, or a surface that is gone is told the host's answer.
  it('drops the late callback of a waiter that timed out and aborts afterwards', async () => {
    const late = vi.fn();
    const controller = new AbortController();
    const waiting = move({ taskId: 't-1' }, { signal: controller.signal, onLateOutcome: late });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(waiting).resolves.toMatchObject({ kind: 'unknown' });

    controller.abort();
    fireAck(posts[0]!.id, { status: 'accepted' });

    expect(late).not.toHaveBeenCalled();
  });

  it('keeps the abort listener while a late outcome is owed, and removes it when the outcome arrives', async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const waiting = move({ taskId: 't-1' }, { signal: controller.signal, onLateOutcome: vi.fn() });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await waiting;
    expect(removed).not.toHaveBeenCalled();

    fireAck(posts[0]!.id, { status: 'accepted' });

    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('removes the abort listener of a waiter that timed out with no late callback to protect', async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const waiting = move({ taskId: 't-1' }, { signal: controller.signal });

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await waiting;

    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('resolves cancelled at once for a signal that is already aborted, and posts nothing it cannot answer', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(move({ taskId: 't-1' }, { signal: controller.signal })).resolves.toMatchObject({
      kind: 'cancelled'
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('disposal (I9)', () => {
  it('leaves no timer and no listener, resolves waiters cancelled and runs no callback', async () => {
    const late = vi.fn();
    const timedOut = move({ taskId: 't-1' }, { onLateOutcome: late });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await timedOut;
    const stillWaiting = move({ taskId: 't-2' }, { onLateOutcome: late });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    disposeIntentLedger();

    await expect(stillWaiting).resolves.toMatchObject({ kind: 'cancelled' });
    expect(vi.getTimerCount()).toBe(0);
    expect(ackListeners.size).toBe(0);
    expect(late).not.toHaveBeenCalled();
  });

  it('starts a clean slate: the next send mints a new identity', () => {
    void move({ taskId: 't-1' });
    disposeIntentLedger();

    void move({ taskId: 't-1' });

    expect(posts[1]!.id).not.toBe(posts[0]!.id);
  });
});
