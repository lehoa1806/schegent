// FR-R4-F05 (T17; contract I, I4 to I7; FR-019 to FR-024) — the Pipeline launch through the intent ledger.
//
// WHY. A launch that outlived the 5 s wait used to resolve as a queue refusal, and a second click was
// a second launch. A timeout is now `not-yet-known`, the retry of the same request reuses the identity,
// and the late outcome reaches the caller once.
// The host's answer is fired by hand and time is fake; nothing waits for real time.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface AckLike {
  readonly status: 'accepted' | 'rejected';
  readonly reason?: string;
  readonly result?: unknown;
}
type AckListener = (ack: AckLike) => void;

const ackListeners = new Map<string, AckListener>();
const posted: Array<{ type: string; payload?: unknown; correlationId: string }> = [];
let nextId = 0;

vi.mock('../snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(): void {},
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => {
        if (ackListeners.get(id) === fn) ackListeners.delete(id);
      };
    }
  }
}));

vi.mock('../vscode-api', () => ({
  // Honours the identity the intent ledger supplies, as the real `postCommand` does.
  postCommand(
    type: string,
    payload?: unknown,
    opts?: { correlationId?: string }
  ): { correlationId: string } {
    const correlationId = opts?.correlationId ?? `c${++nextId}`;
    posted.push({ type, payload, correlationId });
    return { correlationId };
  },
  onHostMessage: () => () => undefined
}));

const { disposeIntentLedger } = await import('../intent-ledger');

function fireAck(id: string, ack: AckLike): void {
  const fn = ackListeners.get(id);
  expect(fn, `no listener registered for ${id}`).toBeDefined();
  ackListeners.delete(id);
  fn!(ack);
}

beforeEach(() => {
  disposeIntentLedger();
  ackListeners.clear();
  posted.length = 0;
  nextId = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  disposeIntentLedger();
  vi.useRealTimers();
});

const { launchPipeline } = await import('../run-launcher-ipc');

const REQUEST = { pipelineId: 'triage-flow', inputs: [], supplemental: [], outputs: [] };
const ENQUEUED = { outcome: 'enqueued', requestId: 'req-1' };

describe('launchPipeline (T17)', () => {
  it('resolves a wait that ran out as not-yet-known, never as a queue refusal', async () => {
    const waiting = launchPipeline(REQUEST);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await waiting;

    expect(result).toEqual({ outcome: 'not-yet-known' });
    expect(JSON.stringify(result)).not.toContain('no-host-response');
  });

  it('posts the same correlation id and payload for a retry after a timeout, and answers it with the ack', async () => {
    const first = launchPipeline(REQUEST, 'q-beta');
    await vi.advanceTimersByTimeAsync(5000);
    await first;

    const retry = launchPipeline(REQUEST, 'q-beta');

    expect(posted).toHaveLength(2);
    expect(posted[1]!.correlationId).toBe(posted[0]!.correlationId);
    expect(posted[1]!.payload).toEqual({ request: REQUEST, queueId: 'q-beta' });
    fireAck(posted[0]!.correlationId, { status: 'accepted', result: ENQUEUED });
    await expect(retry).resolves.toEqual(ENQUEUED);
  });

  it('omits an absent queue id from the payload, as the ingress guard requires', () => {
    void launchPipeline(REQUEST);

    expect(Object.keys(posted[0]!.payload as object)).toEqual(['request']);
  });

  it('delivers the late outcome once', async () => {
    const late = vi.fn();
    const waiting = launchPipeline(REQUEST, undefined, { onLateOutcome: late });
    await vi.advanceTimersByTimeAsync(5000);
    await waiting;

    fireAck(posted[0]!.correlationId, { status: 'accepted', result: ENQUEUED });

    expect(late).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledWith(ENQUEUED);
  });

  it('resolves cancelled sends as not-yet-known without calling the late callback', async () => {
    const late = vi.fn();
    const controller = new AbortController();
    const waiting = launchPipeline(REQUEST, undefined, { signal: controller.signal, onLateOutcome: late });

    controller.abort();
    fireAck(posted[0]!.correlationId, { status: 'accepted', result: ENQUEUED });

    await expect(waiting).resolves.toEqual({ outcome: 'not-yet-known' });
    expect(late).not.toHaveBeenCalled();
  });
});
