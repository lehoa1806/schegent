// FR-R4-F05 (T17; contract I, I4 to I6; FR-019 to FR-024) — phase breakpoint changes through the intent ledger.
//
// WHY. Arming a breakpoint is a gated write. A click that outlived the 5 s wait used to be a second
// write under a new identity; now a retry of the unresolved change posts the same correlation id and
// payload, and a timeout is a result the caller already handles, not a claim that nothing happened.
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

const { clearPhaseBreakpoint, setPhaseBreakpoint } = await import('../phase-breakpoint-ipc');

describe('phase breakpoint helpers (T17)', () => {
  it('posts the same correlation id and payload for a retry after a timeout, and answers it with the ACK', async () => {
    const first = setPhaseBreakpoint('run-1', 'speckit-plan', 'q-1');
    await vi.advanceTimersByTimeAsync(5000);
    await expect(first).resolves.toEqual({ status: 'rejected', reason: 'timeout' });

    const retry = setPhaseBreakpoint('run-1', 'speckit-plan', 'q-1');

    expect(posted).toHaveLength(2);
    expect(posted[1]!.correlationId).toBe(posted[0]!.correlationId);
    expect(posted[1]!.payload).toEqual(posted[0]!.payload);
    fireAck(posted[0]!.correlationId, { status: 'accepted' });
    await expect(retry).resolves.toEqual({ status: 'accepted' });
  });

  it('sends set and clear as different intents', () => {
    void setPhaseBreakpoint('run-1', 'speckit-plan', 'q-1');
    void clearPhaseBreakpoint('run-1', 'speckit-plan', 'q-1');

    expect(posted[1]!.correlationId).not.toBe(posted[0]!.correlationId);
  });

  it('resolves the refusal of the host with its reason', async () => {
    const waiting = clearPhaseBreakpoint('run-1', 'speckit-plan', 'q-1');
    fireAck(posted[0]!.correlationId, { status: 'rejected', reason: 'untrusted-workspace' });

    await expect(waiting).resolves.toEqual({ status: 'rejected', reason: 'untrusted-workspace' });
  });
});
