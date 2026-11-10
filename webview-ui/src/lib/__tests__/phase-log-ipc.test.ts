// FR-R4-F05 (T17; contract I, I4 to I6; contract O, O1, O3, O7; FR-019 to FR-024) — the phase-log commands through the intent ledger.
//
// WHY. The three commands are gated now (each appends an audit row). A refusal used to read as
// `internal-error` and a wait that ran out as `internal-error` too; the failure now carries the shared
// sentence for what happened, and a timeout says the outcome is not yet known.
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
const hostHandlers = new Set<(message: unknown) => void>();

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
  onHostMessage(handler: (message: unknown) => void): () => void {
    hostHandlers.add(handler);
    return () => {
      hostHandlers.delete(handler);
    };
  }
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
  hostHandlers.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  disposeIntentLedger();
  vi.useRealTimers();
});

const { ackPhaseLogTail, readPhaseLog, startPhaseLogTail, stopPhaseLogTail, subscribePhaseLogBatch } = await import(
  '../phase-log-ipc'
);

const SELECTION = { queueId: 'q', taskId: 't', pipelineId: 'p1', phaseId: 'p2', iterationN: null };
const NOT_YET_KNOWN = 'The host has not answered yet, so the outcome is not yet known.';

describe('phase-log helpers (T17)', () => {
  it('words a wait that ran out as not yet known, not as an internal error', async () => {
    const waiting = readPhaseLog({ selection: SELECTION });
    await vi.advanceTimersByTimeAsync(5000);

    const result = await waiting;

    expect(result).toMatchObject({ outcome: 'failure', refusalText: NOT_YET_KNOWN });
  });

  it('posts the same correlation id and payload for a retry after a timeout', async () => {
    const first = readPhaseLog({ selection: SELECTION });
    await vi.advanceTimersByTimeAsync(5000);
    await first;

    const retry = readPhaseLog({ selection: SELECTION });

    expect(posted[1]!.correlationId).toBe(posted[0]!.correlationId);
    expect(posted[1]!.payload).toEqual(posted[0]!.payload);
    fireAck(posted[0]!.correlationId, { status: 'accepted', result: { outcome: 'failure', reason: 'unknown-tuple' } });
    await expect(retry).resolves.toEqual({ outcome: 'failure', reason: 'unknown-tuple' });
  });

  it.each([
    ['untrusted-workspace', 'The workspace is not trusted, so this action is unavailable.'],
    ['secondary-window-readonly', 'This window is not the primary one, so it cannot make this change.'],
    [
      'command-dispatch-failed',
      'The action could not be carried out. Check the Schegent log and try again.'
    ]
  ])('shows a read refused with %s as its sentence', async (reason, text) => {
    const waiting = readPhaseLog({ selection: SELECTION });
    fireAck(posted[0]!.correlationId, { status: 'rejected', reason });

    await expect(waiting).resolves.toMatchObject({ outcome: 'failure', reason: 'internal-error', refusalText: text });
  });

  it('keeps unknown-tuple as the own reason of the module, with no refusal text', async () => {
    const waiting = readPhaseLog({ selection: SELECTION });
    fireAck(posted[0]!.correlationId, { status: 'rejected', reason: 'unknown-tuple' });

    const result = await waiting;

    expect(result).toEqual({ outcome: 'failure', reason: 'unknown-tuple' });
  });

  it('carries the refusal text on a refused tail start and a refused tail stop', async () => {
    const start = startPhaseLogTail({ selection: { ...SELECTION, iterationN: 1 } });
    fireAck(posted[0]!.correlationId, { status: 'rejected', reason: 'untrusted-workspace' });
    const stop = stopPhaseLogTail({ sessionId: 'session-1' });
    fireAck(posted[1]!.correlationId, { status: 'rejected', reason: 'secondary-window-readonly' });

    await expect(start).resolves.toMatchObject({ outcome: 'failure', refusalText: expect.stringContaining('not trusted') });
    await expect(stop).resolves.toMatchObject({ outcome: 'failure', refusalText: expect.stringContaining('not the primary') });
  });
});

// FR-R6-F07 (T021; FR-004, FR-009) — the batch push and its acknowledgement.
describe('live-log batches (T021)', () => {
  function hostPosts(message: unknown): void {
    for (const handler of [...hostHandlers]) handler(message);
  }

  it('posts an acknowledgement as a one-way command that waits for nothing', () => {
    const returned: unknown = ackPhaseLogTail({ sessionId: 'session-1', batchSeq: 0 });
    ackPhaseLogTail({ sessionId: 'session-1', batchSeq: 4, resync: true });

    expect(returned).toBeUndefined();
    expect(posted.map((entry) => entry.type)).toEqual(['CMD_ACK_PHASE_LOG_TAIL', 'CMD_ACK_PHASE_LOG_TAIL']);
    expect(posted.at(0)?.payload).toEqual({ sessionId: 'session-1', batchSeq: 0 });
    expect(posted.at(1)?.payload).toEqual({ sessionId: 'session-1', batchSeq: 4, resync: true });
    expect(ackListeners.size).toBe(0);
  });

  it('delivers each batch payload, whatever its protocol, and nothing else', () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribePhaseLogBatch((payload) => {
      seen.push(payload);
    });
    const batch = { protocol: 1, tailSessionId: 's', batchSeq: 1, generation: 'g', mode: 'resume', toCursor: null, entries: [] };
    const future = { ...batch, protocol: 2, batchSeq: 2 };

    hostPosts({ type: 'MSG_PHASE_LOG_BATCH', payload: batch });
    hostPosts({ type: 'MSG_PHASE_LOG_ENTRY', payload: { tailSessionId: 's', entrySeq: 1 } });
    hostPosts({ type: 'STATE_SNAPSHOT', payload: {} });
    hostPosts({ type: 'MSG_PHASE_LOG_BATCH', payload: future });
    unsubscribe();
    hostPosts({ type: 'MSG_PHASE_LOG_BATCH', payload: batch });

    expect(seen).toEqual([batch, future]);
  });
});
