// FR-R4-F05 (T17; contract I, I4 to I6; contract O, O1, O3, O7; FR-019 to FR-024) — the metrics read through the intent ledger.
//
// WHY. The metrics read is gated now (it appends a `metrics-view-opened` row). A refusal used to be
// `internal-error` and showed nothing; the failure now carries the shared sentence, and a wait that ran
// out says the outcome is not yet known.
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

const { readMetrics } = await import('../metrics-ipc');

const NOT_YET_KNOWN = 'The host has not answered yet, so the outcome is not yet known.';

describe('readMetrics (T17)', () => {
  it('words a wait that ran out as not yet known, not as an internal error', async () => {
    const waiting = readMetrics({});
    await vi.advanceTimersByTimeAsync(5000);

    await expect(waiting).resolves.toMatchObject({ outcome: 'failure', refusalText: NOT_YET_KNOWN });
  });

  it('posts the same correlation id and payload for a retry after a timeout', async () => {
    const first = readMetrics({ includeArchives: true });
    await vi.advanceTimersByTimeAsync(5000);
    await first;

    void readMetrics({ includeArchives: true });

    expect(posted).toHaveLength(2);
    expect(posted[1]!.correlationId).toBe(posted[0]!.correlationId);
    expect(posted[1]!.payload).toEqual(posted[0]!.payload);
  });

  it('shows a read refused by the router as its sentence', async () => {
    const waiting = readMetrics({});
    fireAck(posted[0]!.correlationId, { status: 'rejected', reason: 'untrusted-workspace' });

    await expect(waiting).resolves.toEqual({
      outcome: 'failure',
      reason: 'internal-error',
      refusalText: 'The workspace is not trusted, so this action is unavailable.'
    });
  });

  it('reads an accepted ack that is not a metrics response as a plain failure with no refusal text', async () => {
    const waiting = readMetrics({});
    fireAck(posted[0]!.correlationId, { status: 'accepted', result: { not: 'metrics' } });

    await expect(waiting).resolves.toEqual({ outcome: 'failure', reason: 'internal-error' });
  });
});
